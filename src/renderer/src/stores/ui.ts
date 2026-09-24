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
     * 「请把焦点交给侧栏的文件搜索框」的信号（自增计数器，0 = 还没请求过）。
     *
     * 为什么是计数器而不是一个 boolean：搜索框的展开/收起状态、失焦规则、DOM 引用都在
     * `FileTree.vue` 内部（那是一枚会「长出输入框」的放大镜，收起规则三条），
     * 把它搬进 store 等于把三段动画状态机拆成两半。这里只发一个**可以被重复触发的请求**：
     * 消费方（FileTree）watch 到数字变化就 `openSearch()` —— 连续按两次 Ctrl+F 也能再聚焦。
     */
    sidebarSearchTick: 0,
    editorMode: 'wysiwyg' as EditorMode,
    focusMode: false,
    typewriterMode: false,
    confirmState: null as (ConfirmOptions & { resolve: (v: boolean) => void }) | null,
    promptState: null as {
      title: string
      placeholder: string
      value: string
      resolve: (v: string | null) => void
    } | null,
    contextMenu: null as ContextMenuState | null,
    cursor: { line: 1, col: 1 },
    booting: true,
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
