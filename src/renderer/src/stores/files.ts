import { defineStore } from 'pinia'
import type { DraftInfo, FileNode, HistoryEntry, OpenedFile } from '../../../shared/types'
import type { ConcreteEncoding, EncodingId } from '../../../shared/encodings'
import { isEol, otherEol, type Eol } from '../../../shared/eol'
import { useSettingsStore } from './settings'
import { useWorkspaceDocsStore } from './workspaceDocs'
import { useRecentStore } from './recent'
import { useUiStore } from './ui'
import { useNotificationsStore } from './notifications'
import i18n from '../i18n'
import { ancestorDirs, isInside, samePath } from '../lib/pathUtils'
import { activeTreePath } from '../lib/treeFocus'
import { planMove, type MoveRejectReason, type MoveSource } from '../lib/treeMove'
import { errorReason } from '../lib/errors'
import { confirmDiscardIfDirty } from '../lib/dialog'
import { flushEditorBeforeReplace } from '../lib/editorFlush'
import { draftKeyFor, restorableDraft } from '../lib/draftRules'
import { SAVE_CONFLICT_KIND } from '../lib/saveConflict'
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
// 保存快照语义 / 草稿时机 / 同路径重开 / 改名路径算术 / 退避延时：纯判据都在 filesCore（有单测）
import {
  DRAFT_DEBOUNCE_MS,
  askedPathStillCurrent,
  decideSamePathReopen,
  focusPathAfterMove,
  nextSaveRetryDelay,
  planDraftWrite,
  planReopenWhenClean,
  planSaveOutcome,
  renameCurrentDocFixup,
  snapshotIsSaved
} from '../lib/filesCore'
// 字数口径（中文按字 + 拉丁按词）的唯一实现：状态栏字数、阅读时长、主进程 word_count 共用
import { measureText, type TextMeasure } from '../../../shared/readingTime'

/**
 * 统计量的按内容缓存（见下方 getters 的说明）：一起算出「字数 / 行数 / 字符数」，
 * 内容串没变就直接复用。放在模块级而不是 store state 里 —— 它是纯粹的派生缓存，
 * 不该进 Vue 响应式系统（也不需要持久化）。
 */
/**
 * ─── 草稿的两个时间常数 ────────────────────────────────────────────────────────
 * 定义在 `lib/filesCore.ts`（与判定它的纯函数放在一起，`tests/filesCore.test.mjs` 覆盖
 * 1.2s / 10s 两个**恰好等于**的边界）。这里只用到防抖那一个来调度定时器，
 * 最大等待（10s）由 `planDraftWrite` 内部判。
 */

let countKey: string | null = null
/** 一趟扫出来的四个数：字数（含中文/拉丁的拆分，阅读时长要用拆分）+ 行数 + 字符数 */
interface DocCounts extends TextMeasure {
  lines: number
  chars: number
}
let countVal: DocCounts = { cjkChars: 0, latinWords: 0, words: 0, lines: 0, chars: 0 }

function countsOf(content: string): DocCounts {
  if (countKey === content) return countVal
  countKey = content
  countVal = { cjkChars: 0, latinWords: 0, words: 0, lines: 0, chars: content.length }
  if (!content) return countVal
  countVal.lines = content.split('\n').length
  // 字数口径的唯一实现在 shared/readingTime.ts（中文按字 + 拉丁按词）：
  // 状态栏的「阅读时长」按各自速率算，需要**分开**的两个数，所以这里连拆分一起缓存
  const m = measureText(content)
  countVal.cjkChars = m.cjkChars
  countVal.latinWords = m.latinWords
  countVal.words = m.words
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
  /**
   * 打开这份文件时解码出现过替换字符（`U+FFFD`）—— 界面要如实提示：
   * 「打开→保存」不会字节相等（那些字节会变成 `EF BF BD`）。见 shared/encodingMemory.ts。
   */
  hadReplacement: boolean
}

let untitledSeq = 1

// 未命名文档的编码/行尾、编码显示名、历史时间格式、草稿键与草稿可恢复判定
// 都是**规则**而非状态：抽到 lib/docText.ts 与 lib/draftRules.ts（纯函数，有单测）。

/**
 * 改名（重命名）通知的 `payload.kind`：处理器在 `lib/renameUndo.ts` 里按它注册。
 *
 * 为什么要有这张卡片：改名看着"不可逆"，其实完全可以退回去（审计 §8 P2「危险/不可逆操作
 * 还缺确认与撤销」里剩下的一条）。通知会被持久化在 SQLite 里、重启后仍可能被渲染，
 * 所以按钮的动作只能按 kind 注册，不能是随通知序列化的闭包（与 recentUndo / linkOpen 同一套）。
 */
export const RENAME_KIND = 'rename'

/**
 * 落点被拒时的提示文案（`MoveRejectReason` → i18n 键）。
 *
 * 为什么是一张表而不是 if/else：这条映射与纯函数里的原因枚举**一一对应**，
 * 以后加一种拒绝原因，TypeScript 会在这里当场报缺键（漏一条就等于静默吞掉一次拖放）。
 * `into-self` 与 `into-descendant` 共用一句：对用户来说都是"你不能把文件夹搬进它自己里"。
 */
const MOVE_REJECT_TOAST: Record<MoveRejectReason, string> = {
  'outside-workspace': 'toast.moveOutside',
  'into-self': 'toast.moveIntoSelf',
  'into-descendant': 'toast.moveIntoSelf',
  'target-exists': 'toast.moveExists'
}

/**
 * 起一张「已重命名 / 已移动，可撤销」的卡片（同一路径只占一位，反复操作不刷屏）。
 * @param titleKey 卡片标题。移动复用同一张卡（同一个 `RENAME_KIND`：撤销的动作与改名完全一样，
 *   都是"把路径搬回去"），只是标题要说"移动"而不是"重命名"。
 */
function offerRenameUndo(p: {
  oldPath: string
  newPath: string
  type: 'file' | 'directory'
  name: string
  titleKey?: string
}): void {
  // titleKey 只用于这一句话，不进 payload：通知会被持久化，载荷里只该有撤销真正需要的东西
  const { titleKey, ...payload } = p
  void useNotificationsStore()
    .notify({
      level: 'info',
      title: i18n.global.t(titleKey ?? 'toast.renamedTo', { name: p.name }),
      actions: [{ id: 'undo', label: i18n.global.t('common.undo'), tone: 'ghost' }],
      payload: { kind: RENAME_KIND, ...payload },
      mergeKey: `renamed:${p.newPath}`
    })
    .catch(() => {})
}

export const useFilesStore = defineStore('files', {
  state: () => ({
    root: null as string | null,
    currentDir: null as string | null,
    dirCache: {} as Record<string, FileNode[]>,
    expanded: new Set<string>() as Set<string>,
    current: null as CurrentDoc | null,
    draftRestore: null as DraftInfo | null,
    /**
     * 「这一轮关窗，用户已经选了**不保存**」（见 `discardCurrentDraft`）。
     * 只有关窗流程会置真，且 `requestClose` 每次开始关窗时复位 —— 它拦住的是
     * `EditorView.onBeforeUnmount` 那条兜底 `flushAll()`（否则它会把用户刚丢弃的改动写回去）。
     */
    discardOnClose: false,
    /**
     * 最近一次草稿写盘（可能还在飞）。只服务一个场景：关窗选「不保存」时要**等它落地再删**，
     * 否则那次写盘的 IPC 会排在删除之后，把草稿写回磁盘（见 `discardCurrentDraft`）。
     */
    draftWrite: null as Promise<void> | null,
    /**
     * 本次打开的文档是否触发了「大文档降级」（见 lib/largeDoc.ts）：
     * 置真时 openPath 已把会话模式切到 source，EditorView 会**不挂载渲染面板**，
     * 从而一个 CodeMirror NodeView 都不建（否则即使切到源码模式，隐藏但常驻的渲染面板
     * 照样会把 500 个实例建出来 —— 实测 14.7s / 1.6GB）。每次打开/新建都会重置。
     */
    heavyMode: false,
    /**
     * 「当前缓冲区是按某个编码**重新解释磁盘字节**得到的」（`reopenWithEncoding` 之后为真）。
     *
     * 为什么需要这个标记（用户报障的数据损坏路径）：把 UTF-8 文件按 GBK 重新打开 → 缓冲区里是乱码；
     * 此时若发生**自动保存**，乱码就按 gbk 写回磁盘 —— 原始内容永久丢失，再切回 UTF-8 读到的
     * 也只是这份坏数据。所以：
     *   * 自动保存：见到这个标记**直接不落盘**，只提示一次（见 scheduleSave）；
     *   * 手动保存：先弹确认（见 save），用户明确点了才写。
     * 打开新文档 / 成功保存后清掉。
     */
    reopenedWithEncoding: false,
    /** 「自动保存因重新解释而被跳过」的提示只弹一次，避免每次防抖都刷屏 */
    reopenAutoSaveWarned: false,
    /** 「当前编码存不下某些字符」的提示只弹一次（每次自动保存都弹等于骚扰） */
    lossyEncodingWarned: false,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    /** 上一次草稿写盘的时刻（ms）。草稿的"最大等待"靠它算，见 DRAFT_MAX_WAIT_MS */
    lastDraftAt: 0,
    /** 上一次写盘失败的退避延时（ms，0 = 没在退避）；成功即清零 */
    saveRetryDelay: 0,
    /**
     * 上一次写盘失败的原因（null = 没有失败记录）。
     *
     * 审计 §2 P1「自动保存失败后不重试」的**可见性**那一半：退避重试早已有，
     * 但失败只在一条会消失的 toast 里说过一次 —— 之后状态栏仍然只写"未保存的更改"，
     * 用户完全看不出"它已经试过、而且一直在失败"。磁盘满 / 只读 / 被占用时，
     * 内容就只存在于内存与草稿里，用户必须**当场知道**。
     */
    saveError: null as string | null,
    /** 失败后最近一次排定的重试时刻（状态栏说明"正在重试"用） */
    saveRetryAt: 0,
    saving: false,
    /** 写盘进行中的 Promise（串行化用：同一时刻只允许一次写盘，见 save 的说明） */
    savePromise: null as Promise<boolean> | null,
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
    /**
     * 中文/拉丁**分开**的计数（阅读时长按两种速率分别计时，需要拆开的两个数）。
     * 与上面三个 getter 共用同一份按内容缓存的扫描结果 —— 状态栏每敲一键都要读它，
     * 不能为此再把全文扫一遍。返回新对象不影响缓存：Pinia 的 getter 只在依赖
     * （`current.content`）变化时重算，缓存的对象本身不参与身份比较。
     */
    textMeasure(state): TextMeasure {
      const c = countsOf(state.current?.content ?? '')
      return { cjkChars: c.cjkChars, latinWords: c.latinWords, words: c.words }
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
    /** 新建文件（默认名）：**内容区切到它** + 在目录树里就地重命名（新建即可改名）。
     *  用唯一的「未命名[-n].md」占位创建，创建后置 pendingRenamePath，
     *  对应 TreeNode 挂载后自动进入重命名编辑状态。 */
    async newFileAt(dir: string): Promise<string | null> {
      // 新建会把当前文档从内容区换掉，与「打开文件」同一口径：脏了先问
      // （问在创建之前 —— 用户取消时不该在磁盘上留下一个空文件）
      if (!(await confirmDiscardIfDirty(() => this.dirty))) return null
      const base = i18n.global.t('common.untitled')
      let name = `${base}.md`
      let i = 1
      while (await window.luminAPI.file.exists(await window.luminAPI.file.join(dir, name))) {
        name = `${base}-${i}.md`
        i += 1
      }
      const path = await this.createFileAt(dir, name)
      if (!path) return null
      // 内容区跟着切到新文件（用户口径）；打不开也照样进改名 —— 用户至少能改个名再重试
      await this.openPath(path)
      // ⚠️ 顺序不能反：`openPath` 会让编辑器按新 path 重建并抢焦点，改名输入框必须**最后**
      // 拿焦点（反过来的话输入框刚聚焦就被编辑器夺走 → blur 立刻按默认名「未命名.md」提交，
      // 用户看到的就是「刚新建就自动结束改名」）。
      this.pendingRenamePath = path
      return path
    },
    /**
     * 删除文件/目录（主进程优先走系统回收站）。
     *
     * 两种"正在编辑的文档被删掉"都要照顾到，否则会出现"删了又自己长回来"：
     *  * 删的就是它 → 关掉缓冲区（现有行为）；
     *  * 删的是**它所在的目录** → 保留正文，把它降级成**未命名缓冲区**：路径没了，
     *    保存时会走「另存为」而不是在旧目录里把文件复活（`fileOps.writeFile` 会 `mkdir -p`，
     *    而 `current.path` 还在旧路径上时，下一次保存就会重建那个目录）。
     */
    async removeNode(node: FileNode, parentDir: string): Promise<void> {
      const { trashed } = await window.luminAPI.file.remove(node.path)
      if (!trashed) {
        // 该位置不支持回收站（网络盘 / FAT 盘 / 组策略）：已经永久删除了，必须说清楚
        useUiStore().toast(i18n.global.t('toast.deletePermanent'), 'warning')
      }
      if (this.current?.path) {
        if (samePath(this.current.path, node.path)) {
          // 删的就是正在编辑的这一篇：按用户意图关掉它（内容已在回收站 + 本地历史里）
          this.current = null
          useWorkspaceDocsStore().invalidate()
        } else if (isInside(node.path, this.current.path)) {
          // 删的是它所在的目录：正文要留住，所以降级成未命名缓冲区（见 detachCurrentDoc）
          this.detachCurrentDoc()
        }
      }
      // 最近文档 / 置顶 / 最近文件夹里的死链一起清掉
      // （单个文件被删：删它那一条；目录被删：删它里面的所有条目）
      if (node.type === 'directory') useRecentStore().dropWithin(node.path)
      // undo=false：这次移除是"删文件"的副作用，不是用户在最近列表上的动作
      else useRecentStore().removeFile(node.path, false)
      await this.refreshDir(parentDir)
    },
    /**
     * 把当前文档从磁盘路径上"摘下来"（它所在的目录已被删除）：
     * 正文留在缓冲区里，`path` 置空、`savedContent` 置空 ——
     * 后者让脏标记亮起、让草稿继续写，用户不会以为"已经保存过了"；
     * 前者让下一次保存走「另存为」，而不是在旧目录里 `mkdir -p` 把目录复活（`fileOps.writeFile` 会建目录）。
     * `name` 保留：另存为对话框的默认文件名还要用它。
     */
    detachCurrentDoc(): void {
      if (!this.current) return
      this.current.path = null
      this.current.savedContent = ''
      this.draftRestore = null
      useWorkspaceDocsStore().invalidate()
    },
    /**
     * 改名的**后续修正**（正向与撤销共用）。
     *
     * 为什么抽出来：撤销改名不是"把 `file.rename` 反着调一次"就完了 —— 当前文档的路径、
     * 最近列表里的子孙路径也得一起搬回去，否则继续编辑会写回旧路径（实测那正是
     * "保存后生成一份幽灵副本"的成因）。两个方向共用同一段逻辑，才不会漏掉某一半。
     *
     * 「当前文档路径怎么搬」这段路径算术在纯函数 `renameCurrentDocFixup` 里
     * （大小写/分隔符不敏感、按目录边界判、原后缀原样拼；`tests/filesCore.test.mjs` 逐条钉住）。
     */
    applyRenameFixups(oldPath: string, newPath: string, type: FileNode['type']): void {
      const cur = this.current
      if (cur) {
        const fixup = renameCurrentDocFixup(oldPath, newPath, cur.path, cur.name)
        // 只有"改的就是它"才换文件名；目录改名时 name 为空串，保持原名不动（与旧实现一致）
        if (fixup && fixup.name) {
          cur.name = fixup.name
        }
        if (fixup) cur.path = fixup.path
      }
      // 目录改名：最近文档 / 置顶 / 最近文件夹里的子孙路径也要跟着搬
      // （主进程那边已经重写了 documents 与 documents_history 的 path）
      if (type === 'directory') useRecentStore().migrateWithin(oldPath, newPath)
    },
    /**
     * 搬家（移动 / 撤销移动）之后，那些**按路径记着**的会话状态要跟着走。
     *
     * 与 `applyRenameFixups` 的分工：那一段管"文档路径 + 最近列表"（改名与移动共用），
     * 这里管另外两样 `applyRenameFixups` 不管的东西 ——
     *   * `currentDir`：正文里相对路径图片的解析基准。**改名的目录不变**，所以那边不需要；
     *     一旦目录真的换了（移动、撤销移动），不更新就会拿旧目录去解析图片，直到下次打开才纠正；
     *   * 键盘焦点行（roving tabindex 的单一真相）：旧路径的行没了以后，整棵树会没有一个
     *     `tabindex=0` 的行 —— Tab 进来方向键全都没反应。
     */
    async syncPathKeyedState(fromPath: string, toPath: string): Promise<void> {
      if (this.current?.path) {
        this.currentDir = await window.luminAPI.file.dirname(this.current.path)
      }
      // 焦点行的搬迁判据在纯函数 focusPathAfterMove 里（按目录边界 + 原后缀原样拼）
      const moved = focusPathAfterMove(fromPath, toPath, activeTreePath.value)
      if (moved !== null) {
        activeTreePath.value = moved
      }
    },
    async renameNode(node: FileNode, parentDir: string, newName: string): Promise<void> {
      const newPath = await window.luminAPI.file.join(parentDir, newName)
      await window.luminAPI.file.rename(node.path, newPath)
      this.applyRenameFixups(node.path, newPath, node.type)
      await this.refreshDir(parentDir)
      // 改名是"看起来不可逆、其实完全可以退回去"的操作（审计 §8 P2）：
      // 给一张带「撤销」的通知卡片，按钮的处理器按 payload.kind 注册（见 lib/renameUndo.ts）
      offerRenameUndo({
        oldPath: node.path,
        newPath,
        type: node.type,
        name: newPath.split(/[\\/]/).pop() ?? newName
      })
    },
    /**
     * ─── 把文件 / 目录**移动到另一个文件夹**（文件树拖放与右键「移动到…」的唯一实现）─────
     *
     * 移动 = 换一个目标路径的 rename：走的是同一条 `file.rename` IPC（目标已存在时主进程抛
     * TARGET_EXISTS，**绝不覆盖**）。这里只做三件事：算目标路径、收尾同步、给一条撤销出路。
     *
     * 判定全部收在纯函数 `planMove` 里（`tests/treeMove.test.mjs` 逐条钉住）。磁盘探测是异步的，
     * 所以分两趟：第一趟纯字符串拿到目标路径 → `file:exists` 探一次 → 把结果**注入**纯函数再判一次。
     * 这样「重名不覆盖」这条规则的唯一实现仍在纯函数里，不会长出第二份。
     *
     * 失败一律**明确提示**（拖放最怕静默什么都不发生）：非法落点给警告、重名给警告、
     * IPC 抛错给错误 + 原因；同父目录是**无操作**，不提示、也不产生一次无意义的 rename。
     *
     * @returns 是否真的搬了（调用方据此决定要不要收尾）
     */
    async moveNode(source: MoveSource, targetDir: string): Promise<boolean> {
      const root = this.root
      if (!root) return false
      const probe = planMove(source, targetDir, root)
      const taken = probe.kind === 'move' ? await window.luminAPI.file.exists(probe.to) : false
      const plan = planMove(source, targetDir, root, () => taken)
      if (plan.kind === 'noop') return false
      if (plan.kind === 'reject') {
        useUiStore().toast(i18n.global.t(MOVE_REJECT_TOAST[plan.reason]), 'warning')
        return false
      }
      try {
        await window.luminAPI.file.rename(plan.from, plan.to)
      } catch (err) {
        // 占用 / 只读 / 目标目录已被删除……原因决定用户下一步怎么做，必须带上
        useUiStore().toast(i18n.global.t('toast.moveFailed', { reason: errorReason(err) }), 'error')
        return false
      }
      // 当前文档路径 +（目录搬家时的）最近列表：与重命名**共用同一段**，不写第二份
      this.applyRenameFixups(plan.from, plan.to, source.type)
      // 目录真的换了：图片基准目录与键盘焦点行跟着走（见 syncPathKeyedState）
      await this.syncPathKeyedState(plan.from, plan.to)
      /**
       * 只有这两个目录的内容变了。**刻意不用 `refreshDir`**：它会把这两个目录下"已展开"的
       * 子目录缓存整片删掉，而 `expanded` 里还留着那些路径 ⇒ 它们会渲染成"空文件夹"
       * （改名路径下已是既有现象；但移动的落点常常是根目录，一次就会清掉整棵树，必须避开）。
       * 移动不会让任何目录消失，所以「只重新读这两个目录」是完整且最小的刷新。
       */
      await this.loadChildren(plan.fromDir)
      await this.loadChildren(plan.toDir)
      useWorkspaceDocsStore().invalidate()
      // 把落点目录展开：拖进折叠的文件夹时，这是"搬到哪去了"最直接的答案
      this.expanded.add(plan.toDir)
      // 与改名同一张撤销卡（同一个 kind：撤销就是"把路径搬回去"），只是标题说"移动"
      offerRenameUndo({
        oldPath: plan.from,
        newPath: plan.to,
        type: source.type,
        name: plan.name,
        titleKey: 'toast.movedTo'
      })
      return true
    },
    /**
     * 撤销一次改名：把路径搬回去，并让当前文档 / 最近列表跟着搬（走同一段 `applyRenameFixups`）。
     * 失败（目标名又被占了、原路径已不在）时给一句提示，不静默吞掉。
     */
    async undoRename(payload: {
      oldPath: string
      newPath: string
      type: FileNode['type']
    }): Promise<boolean> {
      try {
        await window.luminAPI.file.rename(payload.newPath, payload.oldPath)
      } catch {
        useUiStore().toast(i18n.global.t('toast.renameUndoFailed'), 'error')
        return false
      }
      const parentDir = await window.luminAPI.file.dirname(payload.oldPath)
      this.applyRenameFixups(payload.newPath, payload.oldPath, payload.type)
      // 被撤销的可能是一次**移动**（同一张通知卡）：目录换了，图片基准与键盘焦点行也要跟着回去
      await this.syncPathKeyedState(payload.newPath, payload.oldPath)
      await this.refreshDir(parentDir)
      return true
    },
    dirnameOf(p: string): Promise<string> {
      return window.luminAPI.file.dirname(p)
    },

    // ── 文档 ──
    /**
     * @param opts.discardChanges 明确表示"这次重开就是要放弃缓冲区里的修改"（不再问一次）。
     *   只有**用户刚刚点过**的入口才该传：外部改动冲突通知里的「重新打开（放弃我的改动）」。
     *   普通入口（树/列表点击）不能传 —— 那正是"同一路径重开会静默回滚"那条缺陷的入口。
     */
    async openPath(path: string, opts: { discardChanges?: boolean } = {}): Promise<boolean> {
      // 换文档之前先把编辑器里挂起的变更落地（防抖 250ms 窗口内的输入否则会随旧实例一起消失）。
      // 这是**兜底**：会弹「未保存」确认的那些入口在 `confirmDiscardIfDirty` 里已经刷过一次。
      flushEditorBeforeReplace()
      /**
       * ─── 同一路径再次打开（审计 §3 P1）─────────────────────────────────────────
       * 树/列表双击当前正在编辑的那一条、或菜单里的"重新打开"，走的都是这条路。旧行为：
       *   * 调用点的脏确认写的是 `files.dirty && files.current?.path !== path` ——
       *     **同一路径直接放行**（那一句的前提是"同路径=没换文档，不用问"）；
       *   * 于是下面重新 read 磁盘内容 + `noteExternalReplace()`，编辑器按世代号把
       *     **磁盘上的旧版**回灌进来 —— 用户看到的是"我刚写的自己没了"，
       *     若接着触发保存，磁盘也会退回旧版（草稿还在，但没有任何提示）。
       *
       * 现在在**唯一入口**（本函数）上补两条，所有调用点自动受益：
       *   1. 同路径 + 脏 → 先问（确认走原来的换文档语义；取消就原样返回，内容一个字不动）；
       *   2. 同路径 + 干净 → 只有"**重开不会带来任何变化**"时才短路（见下面的判据）。
       * 注意判据用 `samePath`（Windows 大小写/分隔符不敏感），不能用 `===`。
       *
       * 三条分支的判定本身在纯函数 `decideSamePathReopen` / `planReopenWhenClean` 里
       * （`tests/filesCore.test.mjs` 覆盖三条分支 + 「问的期间文档被换掉」）。
       */
      const same = samePath(this.current?.path, path)
      if (same) {
        if (
          decideSamePathReopen({
            currentPath: this.current?.path ?? null,
            path,
            dirty: this.dirty,
            discardChanges: !!opts.discardChanges
          }) === 'ask'
        ) {
          if (!(await confirmDiscardIfDirty(() => this.dirty))) return false
          // 问的期间文档被换掉了：原样返回，别按"用户同意了"往下读盘
          if (!askedPathStillCurrent(this.current?.path ?? null, path)) return false
        } else if (!this.dirty && !opts.discardChanges) {
          /**
           * 同路径 + 干净：短路的前提是"重开确实什么都不会变"。两件事会变，必须放行：
           *   1. **磁盘被外部改过**（mtime 变了）→ 重开才是"载入最新内容"；
           *   2. **生效的默认编码变了**（设置里换成别的编码）→ 重开才会按新编码重新解释，
           *      这也是"改了默认编码想对当前文件生效"的唯一路径
           *      （实测：`_verify-encoding.js` 的 `default-encoding-1252-applies` 因此变红）。
           * 另外草稿检查在两条路上都要跑：草稿可能比磁盘新，那是用户唯一的一份
           * （实测：`_verify-draft-banner.js` 的三条断言）。
           */
          const cur = this.current
          if (cur) {
            const draft = await window.luminAPI.drafts.load(this.draftKey(path))
            if (restorableDraft(draft, cur.content, cur.path, cur.mtimeMs))
              this.draftRestore = draft
            const settings = useSettingsStore()
            const diskMtime = await window.luminAPI.file.mtime(path).catch(() => null)
            if (
              planReopenWhenClean({
                dirty: this.dirty,
                discardChanges: !!opts.discardChanges,
                defaultEncoding: settings.defaultEncoding,
                currentEncoding: cur.encoding,
                currentMtimeMs: cur.mtimeMs,
                diskMtimeMs: diskMtime
              }) === 'short-circuit'
            ) {
              return true
            }
          }
        }
        // 上面没短路的情况：继续往下走，重新读盘就是这次动作的目的
      }
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
          eol: opened.eol,
          hadReplacement: !!opened.hadReplacement
        }
        this.draftRestore = null
        // 新打开的文档：清掉「按编码重新解释过」的标记（那是上一个文档的状态）
        this.reopenedWithEncoding = false
        this.reopenAutoSaveWarned = false
        // 「这个编码存不下某些字符」的提示对每份文档只弹一次：换文档就复位
        this.lossyEncodingWarned = false
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
        eol: untitledEol(useSettingsStore().defaultEol),
        // 未命名文档没有"解码"这一步，自然也没有替换字符
        hadReplacement: false
      }
      this.currentDir = this.root
      this.draftRestore = null
      // 未命名缓冲区永远是空白起步：不携带上一份文档的降级标记，也不带「重新解释过」的标记
      this.heavyMode = false
      this.reopenedWithEncoding = false
      this.reopenAutoSaveWarned = false
      // 显式替换意图：上一份文档若也是未命名（:key 同为 'untitled'），编辑器不会重建，
      // 得靠世代号让它换成这份空白缓冲
      this.noteExternalReplace()
      // 未命名缓冲区没有路径，草稿按窗口（会话槽位）区分；主进程还会把「无主草稿」
      // 交给它认领（别的窗口单独关闭/崩溃留下的正文）。空白缓冲区只有真拿到
      // 非空草稿才弹横幅 —— 空草稿在这里没有任何恢复意义。
      //
      // ⚠️ **等 IPC 回来时这份空白缓冲可能已经不再是当前文档了**（启动时它只是占位，
      // 会话恢复/打开文件会在这期间替换 `current`）——那时再把草稿挂上去，就会弹出一个
      // 谁都不认领的「未保存的草稿」，紧接着被 `openPath` 清掉 ⇒ 用户看到**闪一下**的弹窗。
      // 所以这里先记住自己这一份，回来时确认还是它才挂草稿（启动竞态的另一半就堵在这里；
      // 另一半是「启动期间别开占位缓冲」，见 EditorView 的 onMounted）。
      const buffer = this.current
      const draft = await window.luminAPI.drafts.untitledDraft()
      if (this.current === buffer && restorableDraft(draft, this.current.content, null, null)) {
        this.draftRestore = draft
      }
    },
    async newDocInWorkspace(): Promise<void> {
      if (!this.root) {
        await this.openUntitled()
        return
      }
      const base = i18n.global.t('common.untitled')
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
      // 关掉当前文档同样要先把编辑器里挂起的变更刷进 store（否则它们连草稿都进不去）
      flushEditorBeforeReplace()
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
      // 草稿：尾沿防抖 1.2s，但**距上一份草稿超过 10s 就立刻写**（上限见 filesCore 的说明）。
      // 脏了才写、干净文档不写（见 writeDraft）。判定在纯函数 planDraftWrite 里，
      // 两个边界（恰好 1.2s / 恰好 10s）由 tests/filesCore.test.mjs 覆盖。
      const draftPlan = planDraftWrite({
        dirty: this.dirty,
        lastDraftAt: this.lastDraftAt,
        now: Date.now()
      })
      if (draftPlan === 'write-now') {
        void this.writeDraft()
      } else if (draftPlan === 'debounce') {
        this.draftTimer = setTimeout(() => void this.writeDraft(), DRAFT_DEBOUNCE_MS)
      }
      if (this.current?.path && settings.autoSave) {
        /**
         * ⚠️ **按编码重新打开之后，自动保存不许落盘**（用户报障的那条数据损坏路径）：
         * 用错误编码重新解释出来的缓冲区里就是乱码；它一旦被自动写回，磁盘上的原始内容就没了，
         * 「再切回原来的编码」读到的也只是这份坏数据。手动保存仍允许，但会先弹一次确认（见 save()）。
         */
        if (this.reopenedWithEncoding) {
          if (!this.reopenAutoSaveWarned) {
            this.reopenAutoSaveWarned = true
            const enc = encodingLabel(this.current.encoding)
            useUiStore().toast(
              i18n.global.t('toast.encodingReopenAutoSaveSkipped', { enc }),
              'warning'
            )
          }
          return
        }
        this.saveTimer = setTimeout(() => void this.saveAutomatically(), delay)
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
      // 用户已经决定"这份改动不要了"（关窗选了不保存）：一次草稿都不许再写
      if (this.discardOnClose) return
      // 记账时机放在写之前：无论写成功还是失败都算"尝试过一次"，
      // 否则失败时会因为 lastDraftAt 不前进而变成每次按键都重试（打满 IPC）。
      this.lastDraftAt = Date.now()
      const key = this.draftKey(cur.path)
      /**
       * 把这一次写盘挂到 `draftWrite` 上：关窗选「不保存」时要先把**已经飞出去**的那一次等回来，
       * 再去删草稿 —— 否则它的 IPC 会落在删除**之后**，把草稿又写回磁盘
       * （实测：断言红，而且下次启动真的会弹"检测到未保存的草稿"）。
       */
      const job = (async () => {
        if (cur.content === cur.savedContent) {
          if (this.draftRestore?.key !== key) await window.luminAPI.drafts.remove(key)
          return
        }
        await window.luminAPI.drafts.save(key, cur.content, cur.path)
      })()
      this.draftWrite = job.catch(() => {})
      await job
    },
    /**
     * 保存当前文档。两条与"丢稿"直接相关的并发口径：
     *
     *  1. **串行化**：同一时刻只允许一次写盘。临时文件名已经带随机后缀（见 fileOps.writeFile），
     *     但并发写同一文件在语义上仍然是坏的（后写者可能带着更旧的内容）。后来的调用**等**前一次。
     *  2. **快照比对**：写盘是异步的，`await` 期间用户可能继续输入。所以进 `file.write` 之前先抓住
     *     当时的内容与文档对象；回来之后只认"那一份"的账：`savedContent = snapshot`（磁盘上确实是它）。
     *     若 `content` 已经更多，就**保持 dirty** 并排下一轮 —— 绝不能把新内容标成"已保存"
     *     （那会连草稿一起删掉，新内容永久丢失；这正是本轮修掉的那个缺陷）。
     */
    async save(): Promise<boolean> {
      if (!this.current) return false
      if (!this.current.path) return this.saveAs()
      if (this.savePromise) await this.savePromise.catch(() => false)
      const p = this.saveNow(false)
      this.savePromise = p
      try {
        return await p
      } finally {
        if (this.savePromise === p) this.savePromise = null
      }
    },
    /** 自动保存走这里（见 scheduleSave）：冲突时**不弹模态**，见 saveNow 的说明 */
    async saveAutomatically(): Promise<boolean> {
      if (!this.current?.path) return false
      if (this.savePromise) await this.savePromise.catch(() => false)
      const p = this.saveNow(true)
      this.savePromise = p
      try {
        return await p
      } finally {
        if (this.savePromise === p) this.savePromise = null
      }
    },
    /**
     * `save()` 的实体（不含并发闸门）。口径见 `save()` 的说明。
     * @param auto true = 这一次是自动保存：外部改动冲突时**不弹模态框**，改成
     *   "失败态 + 通知卡片"，见下面 conflict 分支的说明。
     */
    async saveNow(auto = false): Promise<boolean> {
      const doc = this.current
      if (!doc?.path) return false
      /**
       * ⚠️ **按编码重新解释过之后再保存，先问一次**（用户报障的数据损坏路径）：
       * 缓冲区里很可能是乱码，写回会把磁盘上的原始内容覆盖掉 —— 这个动作不可逆，
       * 所以必须让用户明确点一下，而不是等他发现「切回原编码也回不来了」。
       * 自动保存那条路已经在 scheduleSave 里直接跳过了（不会走到这里）。
       */
      if (this.reopenedWithEncoding) {
        const ui = useUiStore()
        const enc = encodingLabel(doc.encoding)
        const ok = await ui.confirm({
          title: i18n.global.t('editor.saveAfterReopenTitle'),
          body: i18n.global.t('editor.saveAfterReopenBody', { enc }),
          danger: true
        })
        if (!ok) return false
        this.reopenedWithEncoding = false
        this.reopenAutoSaveWarned = false
      }
      this.saving = true
      // 快照：写进去的是**这一份**，回来核对账目也只认它
      const snapshot = doc.content
      try {
        // 按文档当前编码 + 行尾写回（编码来源：打开时判定出来的，或用户「选择编码重新打开」选的；
        // 行尾交给主进程展开 —— 这里传的是元数据，不是转换过的文本）
        // 第 6 个参数是"我上次读/写这份文件时的 mtime"：主进程据此检测**外部改动**（审计 §2 P1）
        const first = await window.luminAPI.file.write(
          doc.path,
          snapshot,
          doc.encoding,
          doc.hadBom,
          doc.eol,
          doc.mtimeMs
        )
        /**
         * 非 UTF-8 编码表示不了的字符：主进程做了 decode→encode 往返比对并回报 `lossy`
         * （审计 §2 P1「编码往返可能静默改字节」）。这里发一张**持久通知**而不是一闪而过的
         * toast：这是"内容已经被改成 `?`"的事实，用户可能需要回头再看一眼（要不要改存 UTF-8）。
         * 每份文档只提醒一次（`mergeKey` 固定，反复保存也只是一张卡），换文档时标记复位。
         */
        if (first.lossy && !this.lossyEncodingWarned) {
          this.lossyEncodingWarned = true
          void useNotificationsStore()
            .notify({
              level: 'warning',
              title: i18n.global.t('toast.encodingLossySave', {
                enc: encodingLabel(doc.encoding)
              }),
              body: doc.name,
              mergeKey: `encoding-lossy:${doc.path}`
            })
            .catch(() => {})
        }
        /**
         * ─── 外部改动冲突：别处改了同一文件（审计 §2 P1）────────────────────────
         * 主进程**没有写入**（写之前 stat 发现 mtime 变了），把磁盘当前 mtime 回报过来。
         * 这里绝不能把它当成保存成功：那正是"无声覆盖"的老毛病。
         *
         * 两条路：
         *   * **手动保存** → 当场问一次（"磁盘上这一份已被其它程序改过，仍要覆盖吗？"）——
         *     用户就在键盘前，问是自然的；
         *   * **自动保存** → **不弹模态**（那会把正在写作的人从行文里拽出来，而且他可能
         *     只是想先看看），改成"失败态 + 一张带按钮的持久通知"：
         *     状态栏那一格变红（复用 saveError），通知卡上有「另存为」「重新打开（放弃我的改动）」。
         */
        if (first.conflict) {
          const overwrite = auto
            ? false
            : await useUiStore().confirm({
                title: i18n.global.t('editor.saveConflictTitle', { name: doc.name }),
                body: i18n.global.t('editor.saveConflictBody'),
                danger: true
              })
          if (!overwrite) {
            this.noteSaveConflict(doc, first.mtimeMs)
            return false
          }
          // 用户选择覆盖：以磁盘当前 mtime 为新基线再写一次（这次比对必然通过）
          const forced = await window.luminAPI.file.write(
            doc.path,
            snapshot,
            doc.encoding,
            doc.hadBom,
            doc.eol,
            first.mtimeMs
          )
          if (forced.conflict) {
            // 极端情况：两次之间又被改了。同样不覆盖，交给用户
            this.noteSaveConflict(doc, forced.mtimeMs)
            return false
          }
          return this.finishSave(doc, snapshot, forced.mtimeMs)
        }
        return this.finishSave(doc, snapshot, first.mtimeMs)
      } catch (err) {
        // 带上原因：写盘失败的原因（只读、被占用、磁盘满）决定用户下一步怎么做
        const reason = errorReason(err)
        useUiStore().toast(i18n.global.t('toast.saveFailedDetail', { reason }), 'error')
        /**
         * 状态栏红态 + 通知中心里一张**不会自己消失**的卡片（审计 §2 P1 的另一半）。
         *
         * 为什么必须是持久的：失败只讲一次的话，用户低头写完一段再抬头，看到的还是
         * "未保存的更改"——分不清"待保存"和"存不进去"。而这两种情况的处置完全不同
         * （前者什么都不用做，后者要立刻腾磁盘/关掉占用它的程序/另存到别处）。
         * `mergeKey` 固定：反复重试失败只更新同一张卡，不刷屏。
         */
        this.saveError = reason
        void useNotificationsStore()
          .notify({
            level: 'error',
            title: i18n.global.t('notifications.saveFailedTitle', { name: doc.name }),
            body: i18n.global.t('notifications.saveFailedBody', { reason }),
            mergeKey: `save-failed:${doc.path}`
          })
          .catch(() => {})
        // 失败后不放弃：指数退避重试（5s → 10s → … → 60s 封顶）。
        // 此前失败后不再重排定时器，用户一停手就再也不会尝试落盘（只靠草稿兜）。
        // 退避本身的算术在纯函数 `nextSaveRetryDelay` 里（恰好 0 / 封顶两个边界有单测）。
        // ⚠️ 自动保存的重试也走 `saveAutomatically()`：否则自动保存这一路重启之后
        // 会退化成"弹模态"（手动保存那条路才会弹），把正在写作的人拽出来。
        this.saveRetryDelay = nextSaveRetryDelay(this.saveRetryDelay)
        this.saveRetryAt = Date.now() + this.saveRetryDelay
        if (this.current === doc && doc.content !== doc.savedContent) {
          clearTimeout(this.saveTimer as never)
          this.saveTimer = setTimeout(
            () => void (auto ? this.saveAutomatically() : this.save()),
            this.saveRetryDelay
          )
        }
        return false
      } finally {
        this.saving = false
      }
    },
    /**
     * 保存成功后的共同收尾（mtime 记账 + 最近列表 + 草稿/续排）。
     * 抽出来是因为"直接写成功"与"用户选择覆盖后再写"两条路要一模一样地记账。
     *
     * **快照语义**（审计 §2 P1 的 P0 那条）：「要不要清草稿 / 要不要续排」的判据在纯函数
     * `snapshotIsSaved` + `planSaveOutcome` 里 —— 写盘是异步的，`await` 期间用户可能又敲了字，
     * 那时 `content !== snapshot`，**绝不能**把新内容标成"已保存"（那会连草稿一起删掉）。
     * `tests/filesCore.test.mjs` 里"保存期间继续输入不会被标成已保存"就是钉这条的。
     */
    async finishSave(doc: CurrentDoc, snapshot: string, mtimeMs: number): Promise<boolean> {
      doc.mtimeMs = mtimeMs
      doc.savedContent = snapshot
      this.saveRetryDelay = 0
      this.saveRetryAt = 0
      this.saveError = null
      useRecentStore().touchFile(doc.path as string)
      // 列表视图就地刷新该条目的修改时间（若列表已打开）
      useWorkspaceDocsStore().bumpMtime(doc.path as string)
      const isStillDoc = this.current === doc
      const outcome = planSaveOutcome(isStillDoc, snapshotIsSaved(doc, snapshot))
      if (outcome === 'clear-draft') {
        // 没有新输入：文档与磁盘一致 → 草稿可以清掉（此时它没有恢复价值）。
        // ⚠️ 保存期间用户**换了文档**时这个清草稿的动作不做：旧路径的草稿不属于新文档的地盘
        // （与旧实现一致 —— 那时两个分支都不进），脏文档的草稿交给它自己的下一次 scheduleSave。
        if (isStillDoc) await window.luminAPI.drafts.remove(this.draftKey(doc.path as string))
      } else {
        // await 期间又有输入：保持脏，重排一次保存与草稿（不静默把新内容吞掉）
        this.scheduleSave()
      }
      return true
    },
    /**
     * 外部改动冲突：**不写入**，只把状态说清楚 + 给两条出路（审计 §2 P1）。
     *
     * 状态：`saveError` → 状态栏那一格变红、悬停给出原因（复用 W17 那套失败可见性）。
     * 出路：一张持久通知，按钮「另存为」「重新打开（放弃我的改动）」（处理器见 useAppActions）。
     * 不排自动重试：冲突不会自己消失，反复重试只是每 60 秒失败一次 —— 必须等用户决定。
     * `doc.mtimeMs` **保持不动**：下次保存仍然会被判成冲突（这正是我们要的：
     * 在用户明确选择覆盖之前，绝不覆盖）。
     */
    noteSaveConflict(doc: CurrentDoc, diskMtimeMs: number): void {
      this.saveError = i18n.global.t('editor.saveConflictShort')
      this.saveRetryDelay = 0
      this.saveRetryAt = 0
      void useNotificationsStore()
        .notify({
          level: 'warning',
          title: i18n.global.t('notifications.saveConflictTitle', { name: doc.name }),
          body: i18n.global.t('notifications.saveConflictBody'),
          mergeKey: `save-conflict:${doc.path}`,
          actions: [
            {
              id: 'save-as',
              label: i18n.global.t('notifications.saveConflictSaveAs'),
              tone: 'primary'
            },
            {
              id: 'reload',
              label: i18n.global.t('notifications.saveConflictReload'),
              tone: 'ghost'
            }
          ],
          payload: { kind: SAVE_CONFLICT_KIND, path: doc.path, diskMtimeMs }
        })
        .catch(() => {})
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
      // 成功不发通知（保存类一律不发，状态栏的编码标签就是结果）；失败由 save() 自己报错
      return await this.save()
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
      /**
       * 有未保存修改时**先问**（审计 §2 P1）。点一下就把刚写的一大段换掉是不可接受的：
       * 历史里的那一版再老也是"已经落过盘"的，而当前缓冲区里可能是用户刚写的、
       * 还没有任何副本的一段。`confirmDiscardIfDirty` 会先把编辑器里挂起的变更刷进 store
       * （不然"脏不脏"用的是 250ms 防抖前的老账）。
       */
      if (!(await confirmDiscardIfDirty(() => this.dirty))) return false
      // 问的这段时间里文档可能被换掉了（浮层是模态的，但这条入口不止一处）——账要对得上
      if (this.current !== cur) return false
      /**
       * 走 `setContent(…, 'external')` 而不是直接给 `cur.content` 赋值（审计 §2 P1 的另一半）：
       * 它会计一次外部替换的账，并**排上保存与草稿**。直接赋值那条路既不排保存也不写草稿 ——
       * 源码模式下连草稿都不会被重写，1.2 秒后旧草稿还可能被新内容覆盖。
       */
      this.setContent(entry.content, 'external')
      // 立刻补一份草稿：载入历史是"把缓冲区换成另一个版本"，用户按 Ctrl+S 之前它只在内存里
      // （崩溃就没了）。`scheduleSave` 的草稿是 1.2s 防抖的，这里不等它。
      void this.writeDraft()
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
        // 「还没落盘」是**另一种**失败：没有磁盘字节可重新解释。文案要说清这一点，
        // 否则用户只看到「重新打开失败」，不知道先按 Ctrl+S
        useUiStore().toast(i18n.global.t('toast.encodingNotSaved'), 'error')
        return false
      }
      // 脏文档先问（唯一实现在 lib/dialog：只依赖 ui store，所以 store 用也不会循环导入）
      if (!(await confirmDiscardIfDirty(() => this.dirty))) return false
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
        // 标记「这份缓冲区是按 enc 重新解释出来的」：自动保存跳过、手动保存先确认（见 state 注释）
        this.reopenedWithEncoding = true
        this.reopenAutoSaveWarned = false
        useWorkspaceDocsStore().bumpMtime(cur.path)
        /**
         * **不弹「已按 xx 编码重新打开」的通知**（用户口径）。这与 `stores/ui.ts` 里
         * 「动作结果在界面上已经可见的常规成功一律不发通知」是同一条口径 ——
         * 重新解释的结果**当场就看得见**（正文变了、状态栏那个编码格跟着变、菜单里
         * 当前编码打了勾），再弹一条纯属噪声。
         * 失败仍然弹（见下面的 catch）：那条是「点了没反应」的唯一反馈。
         */
        return true
      } catch (err) {
        // 带上原因，别让用户和后来的我们都只能看到一句「失败了」（真出问题时这条日志就是线索）。
        // 日志用英文：主进程/渲染层的 console 走 Windows 控制台代码页，中文会乱码（见 mainConsoleAscii 的说明）
        console.error('[encoding] reopen with encoding failed:', err)
        useUiStore().toast(
          i18n.global.t('toast.encodingFailedDetail', { reason: errorReason(err) }),
          'error'
        )
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
    /**
     * 关窗确认里用户选了「**不保存**」：把这一篇的草稿一起丢掉，并且不再落盘。
     *
     * 为什么必须连草稿一起删：草稿是崩溃兜底（`writeDraft` 在编辑期间一直在写），
     * 用户明确说了"更改将会丢失"，下次启动却弹出「检测到未保存的草稿（比磁盘文件更新）」
     * 让他恢复 —— 那是与刚才那个选择**自相矛盾**的行为。
     *
     * 为什么要置 `discardOnClose`：窗口销毁时 `EditorView.onBeforeUnmount` 还会兜底调一次
     * `flushAll()`，而它会**保存有路径的文档 + 写草稿** —— 不拦住的话，用户刚选的「不保存」
     * 会在窗口消失前被那条兜底路径推翻（实测：草稿被写了回去，断言红；慢盘上甚至可能真的落盘）。
     */
    async discardCurrentDraft(): Promise<void> {
      // 先抓住"可能正在飞"的那一次草稿写盘，再置标志 —— 顺序反过来的话，
      // 那次写盘会在我们删完之后落地，草稿又回到磁盘上
      const inFlight = this.draftWrite
      this.discardOnClose = true
      clearTimeout(this.draftTimer as never)
      this.draftTimer = null
      if (inFlight) await inFlight.catch(() => {})
      const cur = this.current
      if (!cur) return
      const key = this.draftKey(cur.path)
      if (this.draftRestore?.key === key) this.draftRestore = null
      await window.luminAPI.drafts.remove(key).catch(() => {})
    },
    async flushAll(): Promise<void> {
      // 用户已经明确说过"这份改动不要了"：保存与草稿都不做（见 discardCurrentDraft 的说明）。
      // 由 `requestClose` 在每次关窗开始时复位，所以它只可能在本轮关窗内为真。
      if (this.discardOnClose) return
      clearTimeout(this.saveTimer as never)
      clearTimeout(this.draftTimer as never)
      // ⚠️ 关窗/退出这条路径以前**不刷编辑器**：`beforeunload` 里那次 flush 发生在
      // 主进程已经决定关窗之后，写进 store 也来不及落盘。所以先在这里同步刷一次 ——
      // 顺序是「刷编辑器 → 看脏不脏 → 保存 / 写草稿」，账目才是准的。
      flushEditorBeforeReplace()
      // 有路径的文档直接落盘；未命名文档仅写草稿（下次启动恢复）。
      // ⚠️ 走到这里说明"已经决定保存"了：手动保存模式**关窗**时，用户先在
      //    「是否保存更改？」里选了「保存」（选了「不保存」就根本不会走到这里 ——
      //    那条路走 `discardCurrentDraft()`，见 useAppActions 的 requestClose）；
      //    自动保存模式与系统关机则照旧直接落盘、不问（判定见 shared/closePrompt.ts）。
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
