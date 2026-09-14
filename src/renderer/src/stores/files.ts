import { defineStore } from 'pinia'
import type {
  DraftInfo,
  FileNode,
  OpenedFile,
  RecentFolder,
  WorkspaceDoc
} from '../../../shared/types'
import type { ConcreteEncoding, EncodingId } from '../../../shared/encodings'
import { encodingOf } from '../../../shared/encodings'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'
import i18n from '../i18n'
import { ancestorDirs, isInside } from '../lib/pathUtils'

export interface CurrentDoc {
  path: string | null
  name: string
  content: string
  mtimeMs: number | null
  savedContent: string
  /** 该文档当前的编码（未命名文档用设置里的默认编码，落到具体值时才有意义） */
  encoding: ConcreteEncoding
  /** 文件原本是否带 BOM（写回时保持一致） */
  hadBom: boolean
}

let untitledSeq = 1

/** 未命名文档的编码：设置里选了具体编码就用它，'auto' 时当作 utf-8（新文件没得猜） */
function untitledEncoding(): ConcreteEncoding {
  const id = useSettingsStore().defaultEncoding
  return id === 'auto' ? 'utf-8' : id
}

/** 编码 id → 给用户看的名字（专有名，不走 i18n） */
function encodingLabel(id: ConcreteEncoding): string {
  return encodingOf(id)?.label ?? id
}

export const useFilesStore = defineStore('files', {
  state: () => ({
    root: null as string | null,
    currentDir: null as string | null,
    dirCache: {} as Record<string, FileNode[]>,
    expanded: new Set<string>() as Set<string>,
    /** 侧边栏「列表视图」的工作区文章缓存（主进程递归扫描结果） */
    docs: [] as WorkspaceDoc[],
    /** 文档列表的失效世代：工作区结构变化 / 保存后自增，列表组件据此重扫 */
    docsEpoch: 0,
    /** 上次成功扫描所对应的世代（避免同世代重复扫描） */
    lastDocsEpoch: -1,
    docsLoading: false,
    current: null as CurrentDoc | null,
    draftRestore: null as DraftInfo | null,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    saving: false,
    /** 新建文件后需要自动进入就地重命名的路径（TreeNode 消费后清空） */
    pendingRenamePath: null as string | null,
    /**
     * 显式「外部内容替换」的次数（重新解释编码等）。
     * 编辑器 watch 它，变化时**强制**同步一次并跳过自己的两条回声过滤 ——
     * 否则「切回原编码」时 store 内容恰好等于编辑器上次 emit 的文本，会被当成回声丢掉。
     */
    syncEpoch: 0
  }),
  getters: {
    dirty(state): boolean {
      return !!state.current && state.current.content !== state.current.savedContent
    },
    wordCount(state): number {
      if (!state.current) return 0
      // 字符集与主进程 countWords 一致，`-` 放末尾（类内末尾的连字符无需转义）
      const text = state.current.content.replace(/[#>*`_~[\]()!|-]/g, ' ').trim()
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
    /**
     * 启动初始化。
     * @param options.inheritWorkspace 是否继承 SQLite kv 里的当前工作区。默认 true；
     *   「新建窗口」（--lumin-no-workspace）传 false —— 那是个干净窗口，不该顺带把
     *   别的窗口打开着的文件夹树带出来。
     */
    async init(options: { inheritWorkspace?: boolean } = {}): Promise<void> {
      this.root =
        options.inheritWorkspace === false ? null : await window.luminAPI.workspace.getRoot()
      if (this.root) {
        this.expanded.add(this.root)
        await this.loadChildren(this.root)
      }
      // 外部软件增删/改名文件时，主进程 fs.watch 推送 workspace:changed，
      // 实时刷新根目录与所有已展开子目录；列表视图缓存一并失效
      window.luminAPI.events.on('workspace:changed', () => {
        if (!this.root) return
        const dirs = new Set<string>([this.root, ...this.expanded])
        for (const dir of dirs) void this.loadChildren(dir)
        this.docsEpoch++
      })
    },
    /** 列表视图：重新扫描工作区文章。同根目录、epoch 未变时不重复扫描 */
    async loadDocs(): Promise<void> {
      if (!this.root || this.docsLoading) return
      const root = this.root
      const epoch = this.docsEpoch
      if (this.docs.length && epoch === this.lastDocsEpoch) return
      this.docsLoading = true
      try {
        const docs = await window.luminAPI.file.scanWorkspace(root)
        if (this.root === root && this.docsEpoch === epoch) {
          this.docs = docs
          this.lastDocsEpoch = epoch
        }
      } catch {
        /* 扫描失败保留旧缓存 */
      } finally {
        this.docsLoading = false
      }
    },
    /** 当前文档保存成功后，就地刷新列表里该条目的 mtime（避免整库重扫） */
    bumpDocMtime(path: string): void {
      const item = this.docs.find((d) => d.path === path)
      if (item) {
        item.mtimeMs = Date.now()
        this.docs = [...this.docs].sort(
          (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'zh-CN')
        )
      }
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
      this.docs = []
      this.docsEpoch++
      await window.luminAPI.workspace.setRoot(dir)
      if (dir) {
        this.touchRecentFolder(dir)
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
      // 结构变化（新建/删除/改名）会改变列表内容，失效列表缓存
      this.docsEpoch++
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
        // 编码走设置里的「默认编码」（默认 auto = 主进程按判定链猜）
        const requested = useSettingsStore().defaultEncoding
        const opened: OpenedFile = await window.luminAPI.file.read(path, requested)
        this.current = {
          path: opened.path,
          name: opened.name,
          content: opened.content,
          mtimeMs: opened.mtimeMs,
          savedContent: opened.content,
          encoding: opened.encoding,
          hadBom: opened.hadBom
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
        savedContent: '',
        // 未命名文档还没有真实编码：用设置里的默认（auto 时落成 utf-8，保存时按它写）
        encoding: untitledEncoding(),
        hadBom: false,
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
      this.docs = []
      this.docsEpoch++
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
        // 按文档当前编码写回（编码来源：打开时判定出来的，或用户「选择编码重新打开」选的）
        await window.luminAPI.file.write(
          this.current.path,
          this.current.content,
          this.current.encoding,
          this.current.hadBom
        )
        const stat = await window.luminAPI.file.exists(this.current.path)
        if (stat) this.current.mtimeMs = Date.now()
        this.current.savedContent = this.current.content
        await window.luminAPI.drafts.remove(this.draftKey(this.current.path))
        this.touchRecent(this.current.path)
        // 列表视图就地刷新该条目的修改时间（若列表已打开）
        this.bumpDocMtime(this.current.path)
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
      const ok = await this.save()
      // 另存到别处后，侧栏必须能看见这份新文件（否则它「消失」了）：
      // 落在当前工作区之外 → 工作区跟到它的文件夹；本来就在工作区内 → 逐级展开把它露出来。
      if (ok) await this.syncWorkspaceToPath(path)
      return ok
    },

    /**
     * 「选择编码重新打开」：按指定编码重新读盘，把内容换进编辑器。
     *
     * 三个要点：
     *  1. 脏文档先问（confirmIfDirty），否则重新读盘会把未保存的修改直接吞掉；
     *  2. 换进来之后 **标记为干净**（savedContent = 新内容）：这次操作的语义是「重新解释磁盘上的
     *     字节」，磁盘没被改过，所以不该留下未保存状态；
     *  3. 让主进程把这次选择记进每文件记忆表，下次自动打开就用它。
     * 返回是否成功（失败时 toast 报错）。
     */
    async reopenWithEncoding(encoding: EncodingId): Promise<boolean> {
      const cur = this.current
      // 未落盘的文档没有「磁盘字节」可重新解释：不要静默返回 false（否则用户只会看到「点了没反应」）
      if (!cur?.path) {
        useUiStore().toast(i18n.global.t('toast.encodingFailed'), 'error')
        return false
      }
      // 脏文档先问（这里不引 composables/useAppActions 的 confirmIfDirty：那个模块反过来
      // 依赖本 store，会形成循环导入，所以就地写同样的询问）
      const ui = useUiStore()
      if (this.dirty) {
        const ok = await ui.confirm({
          title: i18n.global.t('editor.dirtyConfirmTitle'),
          body: i18n.global.t('editor.dirtyConfirmBody'),
          danger: true
        })
        if (!ok) return false
      }
      try {
        const opened: OpenedFile = await window.luminAPI.file.read(cur.path, encoding)
        // 主进程/preload 是**构建产物**，不像渲染层那样热更新：若应用是在本次改动之前启动的，
        // 老主进程会忽略 encoding 参数、老 preload 也没有 rememberEncoding。这时必须明确告诉用户
        // 「重启应用」，而不是含糊地报「无法按该编码重新打开」—— 否则看着像功能坏了（实际踩过）。
        if (!opened?.encoding || typeof window.luminAPI.file.rememberEncoding !== 'function') {
          ui.toast(i18n.global.t('toast.encodingNeedsRestart'), 'warning')
          return false
        }
        const concrete = opened.encoding
        await window.luminAPI.file.rememberEncoding(cur.path, concrete)
        cur.content = opened.content
        cur.savedContent = opened.content
        cur.mtimeMs = opened.mtimeMs
        cur.encoding = concrete
        // 显式替换内容：让编辑器绕过回声过滤强制同步（否则"切回原编码"可能被当成回声丢掉）
        this.syncEpoch++
        cur.hadBom = opened.hadBom
        this.draftRestore = null
        this.bumpDocMtime(cur.path)
        ui.toast(
          i18n.global.t('toast.reopenedWithEncoding', { enc: encodingLabel(concrete) }),
          'success'
        )
        return true
      } catch (err) {
        // 带上原因，别让用户和后来的我们都只能看到一句「失败了」（真出问题时这条日志就是线索）
        console.error('[encoding] 按编码重新打开失败:', err)
        // 把原因带在提示里：否则用户只能看到一句「失败了」，排查要多绕一轮
        const reason = String((err as Error)?.message ?? err).slice(0, 120)
        ui.toast(`${i18n.global.t('toast.encodingFailed')}：${reason}`, 'error')
        return false
      }
    },

    /**
     * 让侧栏「对准」某个文件（打开外部文件、另存为之后都走这里）：
     *  - 没有工作区，或文件在当前工作区之外 → 把工作区切到该文件所在文件夹（`setRoot`）；
     *  - 文件本来就在当前工作区内 → **不缩小范围**，改为逐级展开到它（树视图可见）。
     * 返回 're-rooted' | 'revealed'，便于调用方与验收断言。
     */
    async syncWorkspaceToPath(p: string): Promise<'re-rooted' | 'revealed'> {
      const dir = await window.luminAPI.file.dirname(p)
      if (!this.root || !isInside(this.root, p)) {
        await this.setRoot(dir)
        return 're-rooted'
      }
      await this.revealPath(p)
      return 'revealed'
    },

    /** 逐级展开到某个文件（含其父目录），路径上的目录都加载好子项 */
    async revealPath(p: string): Promise<void> {
      if (!this.root) return
      for (const dir of ancestorDirs(this.root, p)) {
        this.expanded.add(dir)
        if (!this.dirCache[dir]) await this.loadChildren(dir)
      }
      // 列表视图按 mtime 排序并缓存，新文件要让它重扫一次才会出现
      this.docsEpoch++
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
    },

    // ── 最近文件夹（工作区）──
    /** 打开文件夹时记一笔（去重 + 置顶，最多 12 条，跨会话保留在 SQLite kv） */
    touchRecentFolder(dir: string): void {
      const settings = useSettingsStore()
      const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir
      const list = (settings.recentFolders ?? []).filter((f) => f.path !== dir)
      list.unshift({ path: dir, name, openedAt: Date.now() })
      settings.set('recentFolders', list.slice(0, 12))
    },
    removeRecentFolder(dir: string): void {
      const settings = useSettingsStore()
      settings.set(
        'recentFolders',
        (settings.recentFolders ?? []).filter((f) => f.path !== dir)
      )
    },
    /** 最近文件夹列表：并入「当前工作区」（历史用户可能没记录过，避免空列表） */
    recentFolderList(): RecentFolder[] {
      const settings = useSettingsStore()
      const list = [...(settings.recentFolders ?? [])]
      if (this.root && !list.some((f) => f.path === this.root)) {
        const name = this.root.split(/[\\/]/).filter(Boolean).pop() || this.root
        list.unshift({ path: this.root, name, openedAt: Date.now() })
      }
      return list
    }
  }
})
