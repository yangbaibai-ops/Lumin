import { defineStore } from 'pinia'
import type { DraftInfo, FileNode, HistoryEntry, OpenedFile } from '../../../shared/types'
import type { ConcreteEncoding, EncodingId } from '../../../shared/encodings'
import { isEol, otherEol, type Eol } from '../../../shared/eol'
import { useSettingsStore } from './settings'
import { useWorkspaceDocsStore } from './workspaceDocs'
import { useRecentStore } from './recent'
import { useUiStore } from './ui'
import i18n from '../i18n'
import { ancestorDirs, isInside, samePath } from '../lib/pathUtils'
import { errorReason } from '../lib/errors'
import { confirmDiscardIfDirty } from '../lib/dialog'
import { draftKeyFor, restorableDraft } from '../lib/draftRules'
import { docLoad, isHeavyDoc } from '../lib/largeDoc'
import {
  createLedger,
  markApplied,
  shouldApply,
  write,
  type Author,
  type DrivenSurface,
  type SyncLedger
} from '../lib/contentSync'
import { encodingLabel, formatHistoryTime, untitledEncoding, untitledEol } from '../lib/docText'

/**
 * 统计量的按内容缓存（见下方 getters 的说明）：一起算出「字数 / 行数 / 字符数」，
 * 内容串没变就直接复用。放在模块级而不是 store state 里 —— 它是纯粹的派生缓存，
 * 不该进 Vue 响应式系统（也不需要持久化）。
 */
let countKey: string | null = null
let countVal = { words: 0, lines: 0, chars: 0 }

function countsOf(content: string): { words: number; lines: number; chars: number } {
  if (countKey === content) return countVal
  countKey = content
  countVal = { words: 0, lines: 0, chars: content.length }
  if (!content) {
    countVal.lines = 0
    return countVal
  }
  countVal.lines = content.split('\n').length
  // 字符集与主进程 countWords 一致，`-` 放末尾（类内末尾的连字符无需转义）
  const text = content.replace(/[#>*`_~[\]()!|-]/g, ' ').trim()
  if (text) {
    const zh = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    const words = (text.match(/[a-zA-Z0-9_]+(?:['’-][a-zA-Z0-9_]+)*/g) || []).length
    countVal.words = zh + words
  }
  return countVal
}

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
  /**
   * 该文档的行尾（内存里文本永远是 LF，落盘时由主进程按它展开）。
   * 已有文件用打开时判定出来的；未命名文档用设置里的默认行尾。
   */
  eol: Eol
}

let untitledSeq = 1

// 未命名文档的编码/行尾、编码显示名、历史时间格式、草稿键与草稿可恢复判定
// 都是**规则**而非状态：抽到 lib/docText.ts 与 lib/draftRules.ts（纯函数，有单测）。

export const useFilesStore = defineStore('files', {
  state: () => ({
    root: null as string | null,
    currentDir: null as string | null,
    dirCache: {} as Record<string, FileNode[]>,
    expanded: new Set<string>() as Set<string>,
    current: null as CurrentDoc | null,
    draftRestore: null as DraftInfo | null,
    /**
     * 本次打开的文档是否触发了「大文档降级」（见 lib/largeDoc.ts）：
     * 置真时 openPath 已把会话模式切到 source，EditorView 会**不挂载渲染面板**，
     * 从而一个 CodeMirror NodeView 都不建（否则即使切到源码模式，隐藏但常驻的渲染面板
     * 照样会把 500 个实例建出来 —— 实测 14.7s / 1.6GB）。每次打开/新建都会重置。
     */
    heavyMode: false,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    saving: false,
    /** 新建文件后需要自动进入就地重命名的路径（TreeNode 消费后清空） */
    pendingRenamePath: null as string | null,
    /**
     * 编辑面 ⇄ 真源的单向数据流账本（手册 §4.59）：
     * `{ rev, author, applied }` —— 内容世代号 + 谁写的 + 各命令式编辑面渲染到哪一代。
     * 契约只有一条：**凡是要换内容的动作都调 `setContent`（或 `noteExternalReplace`）**，
     * 由账本记下作者与世代；编辑面自己判断「我落后了吗」（`contentIsStale`），
     * 落后就按 store 的内容重渲染一次并 `markContentApplied`。
     * 于是不再有「比字符串」「600ms 静默窗」「150ms 快照相等」这类会漏判的启发式，
     * 也不会出现「自己的回声把自己回灌一遍」。
     * 协议本身是纯函数（`lib/contentSync.ts`），单测直接覆盖。
     */
    sync: createLedger() as SyncLedger
  }),
  getters: {
    dirty(state): boolean {
      return !!state.current && state.current.content !== state.current.savedContent
    },
    /* ── 统计量（第二十五轮轻量化）────────────────────────────────────────────
     * 三个计数原先各自对**全文**做一遍扫描（`replace` + 两次 `match` / `split`），
     * 而它们都挂在 `current.content` 上 ⇒ 每敲一个键、状态栏一渲染就重算。
     * 大文档（1MB 级）下这是每键可感的成本，且同一帧里可能被读多次。
     * 做法：按**内容串身份**缓存一次「一趟扫出三个数」。内容没变就是纯读缓存；
     * 变了也只扫一遍（原先读三个数要扫三遍）。语义与逐个数完全一致（同一套正则）。
     */
    wordCount(state): number {
      return countsOf(state.current?.content ?? '').words
    },
    lineCount(state): number {
      return countsOf(state.current?.content ?? '').lines
    },
    charCount(state): number {
      return countsOf(state.current?.content ?? '').chars
    },
    /** 真源内容的世代号（每次内容变化 +1；只增不减） */
    contentRev(state): number {
      return state.sync.rev
    },
    /** 最近一次内容变化的作者（'wysiwyg' | 'source' | 'codeblock' | 'external'） */
    contentAuthor(state): Author {
      return state.sync.author
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
        useWorkspaceDocsStore().invalidate()
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
      useWorkspaceDocsStore().reset()
      await window.luminAPI.workspace.setRoot(dir)
      if (dir) {
        useRecentStore().touchFolder(dir)
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
      useWorkspaceDocsStore().invalidate()
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
        // 编码走设置里的「默认编码」（默认 auto = 主进程按判定链猜）。
        // softDefault=true：这是**软默认** —— 该文件已记录的编码优先，既避免「改了全局默认后
        // 老文件被解成乱码」，也保证多窗口打开同一文件解出同一份内容（见 ipc.ts 的 file:read）
        const requested = useSettingsStore().defaultEncoding
        const opened: OpenedFile = await window.luminAPI.file.read(path, requested, {
          softDefault: true
        })
        // **先**定好 currentDir 再换 current：编辑器按 current.path 重建（:key），
        // 重建那一刻就渲染正文里的图片，而图片相对路径的基准正是 currentDir ——
        // 顺序反了的话第一帧会拿到「上一个文档的目录」（实测：换文档后图片指向旧目录）。
        this.currentDir = await window.luminAPI.file.dirname(opened.path)
        this.current = {
          path: opened.path,
          name: opened.name,
          content: opened.content,
          mtimeMs: opened.mtimeMs,
          savedContent: opened.content,
          encoding: opened.encoding,
          hadBom: opened.hadBom,
          eol: opened.eol
        }
        this.draftRestore = null
        // 显式替换意图：同一路径再次打开（外部改动后重载、另一个窗口的会话恢复）时
        // 编辑器不会重建（:key 只看 path），必须靠世代号让它换内容
        this.noteExternalReplace()
        /**
         * ─── 大文档降级闸（本轮）─────────────────────────────────────────────────
         * 代码围栏是唯一的性能悬崖：实测 500 块 → 打开 22.8s、1500 块 → >185s 且进程常驻
         * 1.4GB（根因：每个代码块一个 CodeMirror 实例，见 lib/largeDoc.ts 的实测数字）。
         * 超阈值就**直接进源码模式**：一个 CM NodeView 都不建，打开回到秒级、内存回到基线。
         * 只改会话状态（`ui.editorMode`），**不落库** —— 用户的持久偏好（settings.editorMode）
         * 不受影响，随时可以手动切回实时渲染。正常文档（几万字）远在阈值之下，不会碰到这条路。
         */
        const load = docLoad(opened.content)
        this.heavyMode = isHeavyDoc(opened.content)
        if (this.heavyMode) {
          const ui = useUiStore()
          ui.editorMode = 'source'
          ui.toast(i18n.global.t('toast.heavyDocSourceMode', { fences: load.fences }), 'warning')
        }
        // 草稿恢复检查：只有「内容确实不同 + 确实比磁盘新」才值得打扰用户
        const draft = await window.luminAPI.drafts.load(this.draftKey(path))
        if (restorableDraft(draft, opened.content, opened.path, opened.mtimeMs)) {
          this.draftRestore = draft
        }
        useRecentStore().touchFile(path)
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
        encoding: untitledEncoding(useSettingsStore().defaultEncoding),
        hadBom: false,
        eol: untitledEol(useSettingsStore().defaultEol)
      }
      this.currentDir = this.root
      this.draftRestore = null
      // 未命名缓冲区永远是空白起步：不携带上一份文档的降级标记
      this.heavyMode = false
      // 显式替换意图：上一份文档若也是未命名（:key 同为 'untitled'），编辑器不会重建，
      // 得靠世代号让它换成这份空白缓冲
      this.noteExternalReplace()
      // 未命名缓冲区没有路径，草稿按窗口（会话槽位）区分；主进程还会把「无主草稿」
      // 交给它认领（别的窗口单独关闭/崩溃留下的正文）。空白缓冲区只有真拿到
      // 非空草稿才弹横幅 —— 空草稿在这里没有任何恢复意义。
      const draft = await window.luminAPI.drafts.untitledDraft()
      if (restorableDraft(draft, this.current.content, null, null)) this.draftRestore = draft
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
      this.heavyMode = false
      useWorkspaceDocsStore().invalidate()
    },
    draftKey(path: string | null): string {
      return draftKeyFor(path, window.luminAPI.app.sessionSlot)
    },

    // ── 内容更新 + 自动保存 + 草稿 ──
    /**
     * 唯一的正文写入口：改内容 → 记一代账（作者是谁）→ 排保存。
     * @param author 谁写的。三个编辑面各自报自己的 id（见 lib/contentSync）：
     *   `wysiwyg`（Tiptap 面板）/ `source`（源码 textarea）/ `codeblock`（代码块 CodeMirror）。
     *   默认 `external`：**整篇替换**（打开文件 / 恢复草稿 / 重新解释编码 / 载入历史），
     *   语义是「所有编辑面都落后了，都得按新内容重渲染一次」——哪怕文本恰好没变。
     */
    setContent(content: string, author: Author = 'external'): void {
      if (!this.current) return
      this.current.content = content
      write(this.sync, author)
      this.scheduleSave()
    },
    /** 整篇替换意图（不改内容本身，只宣告「上一代已作废」）：打开/草稿/切编码/载入历史，见 setContent 说明 */
    noteExternalReplace(): void {
      write(this.sync, 'external')
    },
    /** 命令式编辑面报告「我已渲染到当前世代」（渲染动作 = setContent / setState 之后调用） */
    markContentApplied(surface: DrivenSurface): void {
      markApplied(this.sync, surface)
    },
    /** 命令式编辑面是否需要重新渲染（落后于真源） */
    contentIsStale(surface: DrivenSurface): boolean {
      return shouldApply(this.sync, surface)
    },
    scheduleSave(): void {
      const settings = useSettingsStore()
      clearTimeout(this.saveTimer as never)
      clearTimeout(this.draftTimer as never)
      const delay = settings.autoSave ? Math.max(settings.autoSaveInterval, 1) * 1000 : 30000
      // 草稿防抖（脏了才写，用于崩溃恢复；干净文档不写，见 writeDraft）
      this.draftTimer = setTimeout(() => this.writeDraft(), 1200)
      if (this.current?.path && settings.autoSave) {
        this.saveTimer = setTimeout(() => this.save(), delay)
      }
    },
    /** 关闭自动保存时取消尚未触发的磁盘落盘（草稿写入不受影响） */
    cancelAutoSave(): void {
      clearTimeout(this.saveTimer as never)
    },
    /**
     * 写草稿。**只有脏文档才有草稿**：内容与 savedContent 一致时不仅不写，还会把盘上
     * 的旧草稿清掉 —— 否则那份「没有未保存内容」的草稿会在下次打开时变成一条
     * 毫无意义的「检测到未保存的草稿」横幅（空白新文档尤其明显）。
     * 例外：正等着用户决定的草稿横幅（draftRestore）不能被这里顺手清掉。
     */
    async writeDraft(): Promise<void> {
      const cur = this.current
      if (!cur) return
      const key = this.draftKey(cur.path)
      if (cur.content === cur.savedContent) {
        if (this.draftRestore?.key !== key) await window.luminAPI.drafts.remove(key)
        return
      }
      await window.luminAPI.drafts.save(key, cur.content, cur.path)
    },
    async save(): Promise<boolean> {
      if (!this.current) return false
      if (!this.current.path) {
        return this.saveAs()
      }
      this.saving = true
      try {
        // 按文档当前编码 + 行尾写回（编码来源：打开时判定出来的，或用户「选择编码重新打开」选的；
        // 行尾交给主进程展开 —— 这里传的是元数据，不是转换过的文本）
        await window.luminAPI.file.write(
          this.current.path,
          this.current.content,
          this.current.encoding,
          this.current.hadBom,
          this.current.eol
        )
        const stat = await window.luminAPI.file.exists(this.current.path)
        if (stat) this.current.mtimeMs = Date.now()
        this.current.savedContent = this.current.content
        await window.luminAPI.drafts.remove(this.draftKey(this.current.path))
        useRecentStore().touchFile(this.current.path)
        // 列表视图就地刷新该条目的修改时间（若列表已打开）
        useWorkspaceDocsStore().bumpMtime(this.current.path)
        return true
      } catch (err) {
        // 带上原因：写盘失败的原因（只读、被占用、磁盘满）决定用户下一步怎么做
        useUiStore().toast(`${i18n.global.t('toast.saveFailed')}：${errorReason(err)}`, 'error')
        return false
      } finally {
        this.saving = false
      }
    },
    async saveAs(): Promise<boolean> {
      if (!this.current) return false
      const name = this.current.name.replace(/\.md$/i, '') + '.md'
      // 对话框默认落在哪个文件夹：
      //  * **已经有路径**（另存为）→ 它自己所在的文件夹（`currentDir` 就是打开/上次保存时记下的）；
      //  * **未命名文档**（含 Ctrl+N / 新建文档 开出来的那份）→ 侧栏当前工作区，
      //    这样 Ctrl+S 默认就存进侧栏打开的那个文件夹，不必每次自己找；
      //  * 既没路径也没工作区 → 不传，由系统记上次的位置。
      const dir = this.current.path ? this.currentDir : this.root
      const path = await window.luminAPI.file.chooseSaveFile(name, 'md', dir)
      if (!path) return false
      // 同样先算好 name/currentDir 再改 path（顺序理由见 openPath）：path 一变，
      // 编辑器就按 :key 重建并渲染正文图片，那时 currentDir 必须已经是新目录
      const newName = await window.luminAPI.file.basename(path)
      const newDir = await window.luminAPI.file.dirname(path)
      this.currentDir = newDir
      this.current.path = path
      this.current.name = newName
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
    /**
     * 切换/设置当前文档的行尾（状态栏点击、文件菜单「以 LF/CRLF 保存」都走这里）。
     *
     * 语义：行尾是**文档属性**，不是正文内容 —— 内存里的文本始终是 LF，只有落盘时才展开。
     * 所以：
     *   * 不需要改内容、不需要重建编辑器（不会动光标、不会触发回声过滤）；
     *   * 脏标记只看 content 与 savedContent，行尾变化不会伪造出「未保存」状态；
     *   * `save=true` 时立刻落盘（菜单项「以 CRLF 保存」的语义）。
     */
    async setEol(eol: Eol, options: { save?: boolean } = {}): Promise<boolean> {
      const cur = this.current
      if (!cur) return false
      if (!isEol(eol)) return false
      cur.eol = eol
      // 行尾变化不改变文本，磁盘正本也就跟着变了 → 视为已保存状态，避免假脏标记
      if (options.save) return this.save()
      if (cur.path) useWorkspaceDocsStore().bumpMtime(cur.path)
      useUiStore().toast(
        i18n.global.t('toast.eolChanged', { eol: eol === 'crlf' ? 'CRLF' : 'LF' }),
        'success'
      )
      return true
    },
    /** 状态栏点击：在 LF / CRLF 之间轮换（并立即写回，避免用户以为改了却没保存） */
    async toggleEol(): Promise<boolean> {
      const cur = this.current
      if (!cur) return false
      return this.setEol(otherEol(cur.eol), { save: !!cur.path })
    },
    /**
     * 「以编码保存」：把文档编码改成指定值并立即写回。
     * 与 reopenWithEncoding 的区别：那个是**重新解释磁盘字节**（不改文件），这个是**改变写盘编码**。
     */
    async saveWithEncoding(encoding: ConcreteEncoding): Promise<boolean> {
      const cur = this.current
      if (!cur) return false
      cur.encoding = encoding
      const ok = await this.save()
      if (ok) {
        useUiStore().toast(
          i18n.global.t('toast.savedWithEncoding', { enc: encodingLabel(encoding) }),
          'success'
        )
      }
      return ok
    },
    /**
     * 把某个历史版本载入编辑器（**不直接写盘**）。
     *
     * 为什么不做「一键还原到磁盘」：历史快照是**将来说不准**的东西，直接覆盖磁盘风险太大
     * —— 用户可能选错版本、也可能只想摘一段。所以语义是「载入缓冲 + 变成未保存状态」：
     * 用户能在编辑器里看清、对比（大纲/搜索都在），确认无误再 Ctrl+S。
     */
    async restoreHistory(entry: HistoryEntry): Promise<boolean> {
      const cur = this.current
      if (!cur) return false
      if (cur.path && !samePath(cur.path, entry.path)) return false
      cur.content = entry.content
      // 强制同步：这是一次显式外部替换，不能让它被回声过滤吞掉（同 reopenWithEncoding）
      this.noteExternalReplace()
      cur.mtimeMs = cur.mtimeMs ?? null
      useUiStore().toast(
        i18n.global.t('toast.historyRestored', { time: formatHistoryTime(entry.savedAt) }),
        'success'
      )
      return true
    },
    async openHistory(): Promise<void> {
      if (!this.current?.path) {
        useUiStore().toast(i18n.global.t('toast.historyNeedsFile'), 'info')
        return
      }
      await useUiStore().openLocalHistory(this.current.path)
    },
    async reopenWithEncoding(encoding: EncodingId): Promise<boolean> {
      const cur = this.current
      // 未落盘的文档没有「磁盘字节」可重新解释：不要静默返回 false（否则用户只会看到「点了没反应」）
      if (!cur?.path) {
        useUiStore().toast(i18n.global.t('toast.encodingFailed'), 'error')
        return false
      }
      // 脏文档先问（唯一实现在 lib/dialog：只依赖 ui store，所以 store 用也不会循环导入）
      if (!(await confirmDiscardIfDirty(this.dirty))) return false
      try {
        const opened: OpenedFile = await window.luminAPI.file.read(cur.path, encoding)
        // 主进程/preload 是**构建产物**，不像渲染层那样热更新：若应用是在本次改动之前启动的，
        // 老主进程会忽略 encoding 参数、老 preload 也没有 rememberEncoding。这时必须明确告诉用户
        // 「重启应用」，而不是含糊地报「无法按该编码重新打开」—— 否则看着像功能坏了（实际踩过）。
        if (!opened?.encoding || typeof window.luminAPI.file.rememberEncoding !== 'function') {
          useUiStore().toast(i18n.global.t('toast.encodingNeedsRestart'), 'warning')
          return false
        }
        const concrete = opened.encoding
        await window.luminAPI.file.rememberEncoding(cur.path, concrete)
        cur.content = opened.content
        cur.savedContent = opened.content
        cur.mtimeMs = opened.mtimeMs
        cur.encoding = concrete
        // 显式替换内容：让编辑器绕过回声过滤强制同步（否则"切回原编码"可能被当成回声丢掉）
        this.noteExternalReplace()
        cur.hadBom = opened.hadBom
        cur.eol = opened.eol
        this.draftRestore = null
        useWorkspaceDocsStore().bumpMtime(cur.path)
        useUiStore().toast(
          i18n.global.t('toast.reopenedWithEncoding', { enc: encodingLabel(concrete) }),
          'success'
        )
        return true
      } catch (err) {
        // 带上原因，别让用户和后来的我们都只能看到一句「失败了」（真出问题时这条日志就是线索）
        console.error('[encoding] 按编码重新打开失败:', err)
        useUiStore().toast(`${i18n.global.t('toast.encodingFailed')}：${errorReason(err)}`, 'error')
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
      useWorkspaceDocsStore().invalidate()
    },
    async flushAll(): Promise<void> {
      clearTimeout(this.saveTimer as never)
      clearTimeout(this.draftTimer as never)
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
        // 显式外部替换：让编辑器绕过回声过滤强制同步（用户可能刚打完字就点了「恢复」，
        // 600ms 静默窗会把这次替换当成回声丢掉）
        this.noteExternalReplace()
      }
      await window.luminAPI.drafts.remove(draft.key)
    }
    // 「最近文档 / 最近文件夹 / 置顶」已整块移到 stores/recent.ts：那份数据的归属是
    // 「用户开过什么」，与「当前工作区/当前文档」是两件事，不该继续挂在这个 store 上。
  }
})
