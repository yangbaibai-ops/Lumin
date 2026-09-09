import { defineStore } from 'pinia'
import type { DraftInfo, FileNode, OpenedFile } from '../../../shared/types'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'
import i18n from '../i18n'

export interface CurrentDoc {
  path: string | null
  name: string
  content: string
  mtimeMs: number | null
  savedContent: string
}

let untitledSeq = 1

export const useFilesStore = defineStore('files', {
  state: () => ({
    root: null as string | null,
    currentDir: null as string | null,
    dirCache: {} as Record<string, FileNode[]>,
    expanded: new Set<string>() as Set<string>,
    current: null as CurrentDoc | null,
    draftRestore: null as DraftInfo | null,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    saving: false,
    /** 新建文件后需要自动进入就地重命名的路径（TreeNode 消费后清空） */
    pendingRenamePath: null as string | null
  }),
  getters: {
    dirty(state): boolean {
      return !!state.current && state.current.content !== state.current.savedContent
    },
    wordCount(state): number {
      if (!state.current) return 0
      const text = state.current.content.replace(/[#>*`\-_~\[\]()!|]/g, ' ').trim()
      if (!text) return 0
      const zh = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
      const words = (text.match(/[a-zA-Z0-9_]+(?:['’-][a-zA-Z0-9_]+)*/g) || []).length
      return zh + words
    },
    lineCount(state): number {
      if (!state.current) return 0
      const content = state.current.content
      if (!content) return 0
      return content.split('\n').length
    },
    charCount(state): number {
      return state.current ? state.current.content.length : 0
    }
  },
  actions: {
    // ── 工作区 ──
    async init(): Promise<void> {
      this.root = await window.luminAPI.workspace.getRoot()
      if (this.root) {
        this.expanded.add(this.root)
        await this.loadChildren(this.root)
      }
      // 外部软件增删/改名文件时，主进程 fs.watch 推送 workspace:changed，
      // 实时刷新根目录与所有已展开子目录
      window.luminAPI.events.on('workspace:changed', () => {
        if (!this.root) return
        const dirs = new Set<string>([this.root, ...this.expanded])
        for (const dir of dirs) void this.loadChildren(dir)
      })
    },
    async openFolder(): Promise<void> {
      const dir = await window.luminAPI.file.chooseFolder()
      if (!dir) return
      await this.setRoot(dir)
    },
    async setRoot(dir: string | null): Promise<void> {
      this.root = dir
      this.dirCache = {}
      this.expanded.clear()
      await window.luminAPI.workspace.setRoot(dir)
      if (dir) {
        this.expanded.add(dir)
        await this.loadChildren(dir)
      }
    },
    async loadChildren(dir: string): Promise<void> {
      try {
        const nodes = await window.luminAPI.file.readDir(dir)
        this.dirCache[dir] = nodes
      } catch {
        this.dirCache[dir] = []
      }
    },
    async toggleDir(dir: string): Promise<void> {
      if (this.expanded.has(dir)) {
        this.expanded.delete(dir)
      } else {
        this.expanded.add(dir)
        if (!this.dirCache[dir]) await this.loadChildren(dir)
      }
    },
    async refreshDir(dir: string): Promise<void> {
      await this.loadChildren(dir)
      for (const key of Object.keys(this.dirCache)) {
        if (key !== dir && key.startsWith(dir + '\\')) delete this.dirCache[key]
      }
    },
    async createFileAt(dir: string, name: string): Promise<string | null> {
      const path = await window.luminAPI.file.join(dir, name.endsWith('.md') ? name : `${name}.md`)
      try {
        await window.luminAPI.file.createFile(path)
        await this.refreshDir(dir)
        this.expanded.add(dir)
        return path
      } catch {
        return null
      }
    },
    async createDirAt(dir: string, name: string): Promise<boolean> {
      try {
        const path = await window.luminAPI.file.join(dir, name)
        await window.luminAPI.file.createDir(path)
        await this.refreshDir(dir)
        this.expanded.add(dir)
        return true
      } catch {
        return false
      }
    },
    /** 新建文件（默认名）并让其在目录树中就地重命名（新建即改名）。
     *  用唯一的「未命名[-n].md」占位创建，创建后置 pendingRenamePath，
     *  对应 TreeNode 挂载后自动进入重命名编辑状态。 */
    async newFileAt(dir: string): Promise<string | null> {
      const base = '未命名'
      let name = `${base}.md`
      let i = 1
      while (await window.luminAPI.file.exists(await window.luminAPI.file.join(dir, name))) {
        name = `${base}-${i}.md`
        i += 1
      }
      const path = await this.createFileAt(dir, name)
      if (path) this.pendingRenamePath = path
      return path
    },
    async removeNode(node: FileNode, parentDir: string): Promise<void> {
      await window.luminAPI.file.remove(node.path)
      if (this.current?.path === node.path) {
        this.current = null
      }
      await this.refreshDir(parentDir)
    },
    async renameNode(node: FileNode, parentDir: string, newName: string): Promise<void> {
      const newPath = await window.luminAPI.file.join(parentDir, newName)
      await window.luminAPI.file.rename(node.path, newPath)
      if (this.current?.path === node.path) {
        this.current.path = newPath
        this.current.name = newName
      }
      await this.refreshDir(parentDir)
    },
    dirnameOf(p: string): Promise<string> {
      return window.luminAPI.file.dirname(p)
    },

    // ── 文档 ──
    async openPath(path: string): Promise<boolean> {
      try {
        const opened: OpenedFile = await window.luminAPI.file.read(path)
        this.current = {
          path: opened.path,
          name: opened.name,
          content: opened.content,
          mtimeMs: opened.mtimeMs,
          savedContent: opened.content
        }
        this.draftRestore = null
        this.currentDir = await window.luminAPI.file.dirname(opened.path)
        // 草稿恢复检查
        const draft = await window.luminAPI.drafts.load(this.draftKey(path))
        if (draft && draft.savedAt > opened.mtimeMs + 1000 && draft.content !== opened.content) {
          this.draftRestore = draft
        }
        this.touchRecent(path)
        return true
      } catch {
        const ui = useUiStore()
        ui.toast(i18n.global.t('toast.openFailed') + ': ' + path, 'error')
        return false
      }
    },
    async openUntitled(): Promise<void> {
      this.current = {
        path: null,
        name: `Untitled-${untitledSeq++}.md`,
        content: '',
        mtimeMs: null,
        savedContent: ''
      }
      this.currentDir = this.root
      this.draftRestore = null
      const draft = await window.luminAPI.drafts.load('untitled')
      if (draft) this.draftRestore = draft
    },
    async newDocInWorkspace(): Promise<void> {
      if (!this.root) {
        await this.openUntitled()
        return
      }
      const base = '未命名'
      let name = `${base}.md`
      let i = 1
      while (await window.luminAPI.file.exists(await window.luminAPI.file.join(this.root, name))) {
        name = `${base}-${i}.md`
        i += 1
      }
      const path = await this.createFileAt(this.root, name)
      if (path) await this.openPath(path)
    },
    close(): void {
      this.current = null
      this.draftRestore = null
    },
    draftKey(path: string | null): string {
      if (!path) return 'untitled'
      return 'file-' + encodeURIComponent(path.toLowerCase())
    },

    // ── 内容更新 + 自动保存 + 草稿 ──
    setContent(content: string): void {
      if (!this.current) return
      this.current.content = content
      this.scheduleSave()
    },
    scheduleSave(): void {
      const settings = useSettingsStore()
      clearTimeout(this.saveTimer as never)
      clearTimeout(this.draftTimer as never)
      const delay = settings.autoSave ? Math.max(settings.autoSaveInterval, 1) * 1000 : 30000
      // 草稿防抖（始终写入，用于崩溃恢复）
      this.draftTimer = setTimeout(() => this.writeDraft(), 1200)
      if (this.current?.path && settings.autoSave) {
        this.saveTimer = setTimeout(() => this.save(), delay)
      }
    },
    /** 关闭自动保存时取消尚未触发的磁盘落盘（草稿写入不受影响） */
    cancelAutoSave(): void {
      clearTimeout(this.saveTimer as never)
    },
    async writeDraft(): Promise<void> {
      if (!this.current) return
      await window.luminAPI.drafts.save(
        this.draftKey(this.current.path),
        this.current.content,
        this.current.path
      )
    },
    async save(): Promise<boolean> {
      if (!this.current) return false
      if (!this.current.path) {
        return this.saveAs()
      }
      this.saving = true
      try {
        await window.luminAPI.file.write(this.current.path, this.current.content)
        const stat = await window.luminAPI.file.exists(this.current.path)
        if (stat) this.current.mtimeMs = Date.now()
        this.current.savedContent = this.current.content
        await window.luminAPI.drafts.remove(this.draftKey(this.current.path))
        this.touchRecent(this.current.path)
        return true
      } catch {
        useUiStore().toast(i18n.global.t('toast.saveFailed'), 'error')
        return false
      } finally {
        this.saving = false
      }
    },
    async saveAs(): Promise<boolean> {
      if (!this.current) return false
      const name = this.current.name.replace(/\.md$/i, '') + '.md'
      const path = await window.luminAPI.file.chooseSaveFile(name, 'md')
      if (!path) return false
      this.current.path = path
      this.current.name = await window.luminAPI.file.basename(path)
      this.currentDir = await window.luminAPI.file.dirname(path)
      return this.save()
    },
    async flushAll(): Promise<void> {
      clearTimeout(this.saveTimer as never)
      // 有路径的文档直接落盘；未命名文档仅写草稿（下次启动恢复），避免关闭时弹出保存对话框
      if (this.dirty && this.current?.path) await this.save()
      await this.writeDraft().catch(() => {})
    },
    async applyDraftRestore(restore: boolean): Promise<void> {
      const draft = this.draftRestore
      this.draftRestore = null
      if (!draft || !this.current) return
      if (restore) {
        this.current.content = draft.content
      }
      await window.luminAPI.drafts.remove(draft.key)
    },

    // ── 最近文档 ──
    touchRecent(path: string): void {
      const settings = useSettingsStore()
      const title = path.split(/[\\/]/).pop() || path
      const list = settings.recentFiles.filter((r) => r.path !== path)
      list.unshift({ path, title, openedAt: Date.now() })
      settings.set('recentFiles', list.slice(0, 30))
    },
    removeRecent(path: string): void {
      const settings = useSettingsStore()
      settings.set(
        'recentFiles',
        settings.recentFiles.filter((r) => r.path !== path)
      )
    },
    togglePin(path: string): void {
      const settings = useSettingsStore()
      const pinned = new Set(settings.pinnedFiles)
      if (pinned.has(path)) pinned.delete(path)
      else pinned.add(path)
      settings.set('pinnedFiles', [...pinned])
    }
  }
})
