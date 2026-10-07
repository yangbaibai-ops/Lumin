import { defineStore } from 'pinia'
import type {
  EditorMode,
  HistoryEntryMeta,
  NotificationLevel,
  SearchResult
} from '../../../shared/types'
import { useNotificationsStore } from './notifications'

export interface ToastItem {
  id: number
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
}

/** 旧 toast 类型 → 通知级别（保持既有调用点可用） */
const TOAST_LEVEL: Record<ToastItem['type'], NotificationLevel> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error'
}

export interface ConfirmOptions {
  title: string
  body: string
  danger?: boolean
}

/**
 * **三选一**确认框：比 `ConfirmOptions` 多一个"否定但非取消"的出口。
 *
 * 为什么需要它（而不是把两键的 `confirm` 用两次）：关窗那条口径里三个答案语义完全不同 ——
 * 「保存」= 落盘后关闭、「不保存」= 丢弃改动关闭、「取消」= **不关窗**。
 * 两键对话框表达不了第三种，而"用两张对话框串起来"会让用户在两个弹窗之间二选一，
 * 最容易出的事故是"我问了保存吗？他以为是取消"。
 *
 * 文案由调用方给（本 store 不认识任何业务），`confirmLabel` 是主按钮。
 */
export interface TripleConfirmOptions {
  title: string
  body: string
  /** 主按钮文案（关窗场景 = 保存） */
  confirmLabel: string
  /** 中间那个出口的文案（关窗场景 = 不保存） */
  altLabel: string
}

/**
 * 用户选了哪一个：主按钮 / 中间出口 / 取消。
 *
 * ⚠️ 「取消」只剩**两条**入口：提示上的「取消」按钮，以及 **Esc**（两者返回同一个值）。
 * 第二轮口径起「点提示之外」**不再**算取消（用户原话：「不可点击其他地方取消这个提示，
 * 只能通过按上面的按钮操作」）—— ModalHost 那一层因此不再挂 `@click.self`。
 */
export type TripleConfirmResult = 'confirm' | 'alt' | 'cancel'

export interface ContextMenuItem {
  label: string
  icon?: string
  danger?: boolean
  action: string
  disabled?: boolean
  /**
   * 勾选态：菜单项左侧显示一枚对勾（用于「当前已开启」这类开关型条目）。
   * 与 submenu 标记互不影响，可以同时用。
   */
  checked?: boolean
  /**
   * 子菜单条目（惰性求值）：菜单项右侧出现 › ，悬停/右方向键展开。
   * 点这类条目**不**触发 onSelect —— 它只负责展开，真正的动作用子条目回调。
   * 写成函数是为了每次展开都拿到最新的状态（勾选态会随用户操作变化）。
   */
  children?: () => ContextMenuItem[]
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  onSelect: (action: string) => void
  /** 面板的无障碍名称（可选）；工具栏右键菜单用它，验收脚本也靠它定位面板 */
  ariaLabel?: string
}

// ─── UI 状态壳子 ──────────────────────────────────────────────────────────
// 编辑器命令通道（formatCmd/findTick/大纲跳转等）随渲染内核剥离，
// 保留界面状态与全局组件状态，供后续重构接入新内核。
export const useUiStore = defineStore('ui', {
  state: () => ({
    sidebarVisible: true,
    sidebarTab: 'files' as 'files' | 'outline',
    /** 文件标签页展示形态：树 / 列表（Typora 式元数据列表） */
    sidebarFilesView: 'tree' as 'tree' | 'list',
    /**
     * 树内拖放时**当前高亮**的落点行路径（null = 没有落点）。
     *
     * 为什么进 store 而不是各行的局部 ref：高亮的**清除**有两处只有容器看得见 ——
     * 拖拽被 Esc 取消、或落下之后源行的 `dragend`（它会冒泡到 `FileTree.vue` 的容器）。
     * 一个全局唯一的值让"整棵树同时最多亮一行"成为结构性事实，也让那两处兜底清除
     * 有一个明确的落点（见 `TreeNode.vue` 的 dragenter/leave 与 `FileTree.vue` 的 dragend）。
     */
    dropTargetPath: null as string | null,
    /**
     * 「请把焦点交给侧栏的文件搜索框」的信号（自增计数器，0 = 还没请求过）。
     *
     * 为什么是计数器而不是一个 boolean：搜索框的展开/收起状态、失焦规则、DOM 引用都在
     * `FileTree.vue` 内部（那是一枚会「长出输入框」的放大镜，收起规则三条），
     * 把它搬进 store 等于把三段动画状态机拆成两半。这里只发一个**可以被重复触发的请求**：
     * 消费方（FileTree）watch 到数字变化就 `openSearch()` —— 连续按两次 Ctrl+F 也能再聚焦。
     */
    sidebarSearchTick: 0,
    /**
     * 「把大纲放到编辑区右侧」**之前**左栏显示的是哪一页（null = 没有记录）。
     *
     * 用户口径（第十轮）：大纲搬去右侧、再搬回左侧之后，左栏要**回到打开前的那一页** ——
     * 打开前在「文件」就回「文件」，在「大纲」就回「大纲」。
     * 三栏模式打开期间页签行是隐藏的（左栏只承担文件树），所以这个值只能由
     * `useOutlineSide` 在**打开的那一刻**记下来（见那里的说明）；一次搬回即消费掉。
     * 只在会话内有效，不落库：它是"刚才在看哪一页"的临时记忆，重启后无从得知
     * （启动时若 `outlineOnRight` 已经是 true，没有记录 → 搬回时退回「大纲」）。
     */
    sidebarTabBeforeOutlineRight: null as 'files' | 'outline' | null,
    editorMode: 'wysiwyg' as EditorMode,
    focusMode: false,
    confirmState: null as (ConfirmOptions & { resolve: (v: boolean) => void }) | null,
    /** 三选一确认框（关窗「保存 / 不保存 / 取消」）：同一时刻只会有一个对话框 */
    tripleState: null as
      (TripleConfirmOptions & { resolve: (v: TripleConfirmResult) => void }) | null,
    promptState: null as {
      title: string
      placeholder: string
      value: string
      resolve: (v: string | null) => void
    } | null,
    contextMenu: null as ContextMenuState | null,
    cursor: { line: 1, col: 1 },
    booting: true,
    /**
     * 命令面板是否打开（Ctrl+Shift+P）。
     *
     * 为什么进 store 而不是组件内的 ref：打开它的入口在**快捷键服务**里
     * （`composables/useKeymap.ts` 的命令表），而组件要能被 store 的旗标驱动 ——
     * 两者不在同一棵组件树上，用一个旗标让"谁打开的"和"谁关的"都无歧义。
     */
    commandPaletteOpen: false,
    // 设置浮层（模态面板，X/Esc/遮罩可关，不抢占路由）
    settingsOpen: false,
    settingsSection: 'general',
    /**
     * 设置是否要为「调整工具栏」区块做一次定位高亮：
     * 由工具栏右键菜单的「调整工具项」置位，打开设置后滚到该区块并闪一下边框；
     * 关闭设置时清除（下次从菜单/状态栏进来不该再高亮）。
     */
    toolbarAdjustFocus: false,
    globalSearch: {
      open: false,
      query: '',
      results: [] as SearchResult[],
      loading: false,
      docs: 0,
      fts: 0
    },
    /** 本地历史浮层（Wave 2）：列出当前文档保存前的快照，可预览/载入 */
    localHistory: {
      open: false,
      path: null as string | null,
      entries: [] as HistoryEntryMeta[],
      loading: false
    }
  }),
  actions: {
    /**
     * 兼容入口：旧的 `ui.toast(message, type)` 调用点全部转发到通知中心
     * （消息作为标题；相同级别+标题会自动合并，不会刷屏）。
     * 需要「标题 + 详情」结构的调用方直接用 useNotificationsStore().notify()。
     * duration 参数保留只为签名兼容——通知中心按需求不自动消失。
     *
     * ── **什么才该发通知（分流口径）** ────────────────────────────────────────
     * 通知区在编辑区上方、**持久**存在（不自动消失，要手动关），所以每一条噪音都会一直挂着。
     * 只发这三类：
     *   1. **失败 / 降级**：打开失败、导出失败、重命名失败、链接被协议白名单拦下、
     *      重文档降级为源码模式、会话恢复时文件已不在、更新检查失败；
     *   2. **需要用户作答**：链接目标不存在时的「创建并打开 / 取消」；
     *   3. **结果不在界面上**：导出成功（落盘路径）、更新检查结果、「功能待接入」占位。
     * 反过来，**动作结果在界面上已经可见的常规成功一律不发**：
     *   保存 / 另存为（标题与状态栏的脏标记会变）、打开文件夹 / 关闭工作区（文件树即结果）、
     *   重命名 / 删除（那一行会跟着变）、切换保存方式（状态栏与勾选态会变）、
     *   全部替换（查找栏自己的计数会变）、链接创建成功（文件随即被打开）。
     * 用户口径原话：「保存文件这个时间无需通知……把无需通知但现在通知的取消掉，保留必要的通知」。
     */
    toast(message: string, type: ToastItem['type'] = 'info'): void {
      const notifications = useNotificationsStore()
      void notifications.notify({ level: TOAST_LEVEL[type] ?? 'info', title: message })
    },
    confirm(options: ConfirmOptions): Promise<boolean> {
      return new Promise((resolve) => {
        this.confirmState = { ...options, resolve }
      })
    },
    resolveConfirm(v: boolean): void {
      this.confirmState?.resolve(v)
      this.confirmState = null
    },
    /** 三选一确认框（关窗「保存 / 不保存 / 取消」）：见 TripleConfirmOptions 的说明 */
    confirmTriple(options: TripleConfirmOptions): Promise<TripleConfirmResult> {
      return new Promise((resolve) => {
        this.tripleState = { ...options, resolve }
      })
    },
    resolveTriple(v: TripleConfirmResult): void {
      this.tripleState?.resolve(v)
      this.tripleState = null
    },
    prompt(title: string, placeholder: string, value = ''): Promise<string | null> {
      return new Promise((resolve) => {
        this.promptState = { title, placeholder, value, resolve }
      })
    },
    resolvePrompt(v: string | null): void {
      this.promptState?.resolve(v)
      this.promptState = null
    },
    openContextMenu(state: ContextMenuState): void {
      this.contextMenu = state
    },
    closeContextMenu(): void {
      this.contextMenu = null
    },
    openSettings(section = 'general'): void {
      this.settingsSection = section
      this.settingsOpen = true
    },
    /**
     * 打开设置并直接落到「调整工具栏」区块。
     * 用 ui 的一个旗标而不是给设置面板加参数：设置弹层本身就是模态浮层，
     * 再开一个「调整工具栏」浮层会形成模态套模态（Esc / 遮罩层级都会打架）。
     */
    openToolbarAdjust(): void {
      this.settingsSection = 'editor'
      this.openSettings('editor')
      this.toolbarAdjustFocus = true
    },
    clearToolbarAdjustFocus(): void {
      this.toolbarAdjustFocus = false
    },
    closeSettings(): void {
      this.settingsOpen = false
    },
    /**
     * 请侧栏的文件搜索框接管焦点（消费方见 `FileTree.vue`）。
     *
     * 触发点是「用户人在侧栏里按 Ctrl+F」：那时他要搜的是**文件名**，不是正文
     * （正文查找栏在编辑区，由 `find` 命令照常打开）。所以这里不改可见性 ——
     * 侧栏不可见时焦点根本不可能落在文件面板里，路由判定已经把那种情况排除掉了。
     */
    requestSidebarSearch(): void {
      this.sidebarTab = 'files'
      this.sidebarSearchTick += 1
    },
    /**
     * 命令面板（Ctrl+Shift+P）：与设置/全局搜索同一类**模态浮层**，
     * 所以同样只用一个旗标表示"开着"，面板自己负责输入、过滤与执行。
     */
    openCommandPalette(): void {
      this.commandPaletteOpen = true
    },
    closeCommandPalette(): void {
      this.commandPaletteOpen = false
    },
    toggleCommandPalette(): void {
      this.commandPaletteOpen = !this.commandPaletteOpen
    },
    openGlobalSearch(): void {
      this.globalSearch.open = true
      this.globalSearch.query = ''
      this.globalSearch.results = []
      void window.luminAPI.db.stats().then((s) => {
        this.globalSearch.docs = s.docs
        this.globalSearch.fts = s.fts
      })
    },
    closeGlobalSearch(): void {
      this.globalSearch.open = false
      this.globalSearch.results = []
      this.globalSearch.loading = false
    },
    /** 打开本地历史浮层：只列当前文档的快照（正文按需取，见 files.restoreHistory） */
    async openLocalHistory(path: string): Promise<void> {
      this.localHistory.open = true
      this.localHistory.path = path
      this.localHistory.entries = []
      this.localHistory.loading = true
      try {
        this.localHistory.entries = await window.luminAPI.history.list(path, 50)
      } catch {
        this.localHistory.entries = []
      } finally {
        this.localHistory.loading = false
      }
    },
    closeLocalHistory(): void {
      this.localHistory.open = false
      this.localHistory.path = null
      this.localHistory.entries = []
    }
  }
})
