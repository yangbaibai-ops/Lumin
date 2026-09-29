import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useFindStore } from '../stores/find'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useExport } from './useExport'
import { useEditorMode } from './useEditorMode'
import { useOutlineSide } from './useOutlineSide'
import { flushSession } from '../lib/session'
import { openExternalFile } from '../lib/openFile'
import { confirmDiscardIfDirty, resolveCloseIntent } from '../lib/dialog'
import { registerNotificationActions } from '../lib/notificationActions'
import { SAVE_CONFLICT_KIND } from '../lib/saveConflict'
import { exportFormatByAction } from '../../../shared/exportFormats'
import type { CloseReason } from '../../../shared/closePrompt'
import type { MenuAction } from '../../../shared/types'

/** 未保存更改确认：薄适配器 —— 文案与语义只有一份，在 lib/dialog */
export async function confirmIfDirty(): Promise<boolean> {
  return confirmDiscardIfDirty(() => useFilesStore().dirty)
}

/**
 * 「新建」的单一实现：**开一个新窗口**（工作区不变）+ 一篇**未命名**文档。
 *
 * 三个入口共用它：文件 → 新建（含原生菜单）、Ctrl+N（命令表 `file.new`）、顶部栏的「新建」按钮。
 *
 * 为什么不沿用「在当前窗口里建一个工作区文件」：用户要的是「新建 → 直接开始写 → 保存时再决定放哪」，
 * 而不是先替他造一个 `未命名.md`。未命名缓冲区没有 path，于是 Ctrl+S（`files.save()`）天然走
 * 「另存为」对话框 —— 这正是「点击 Ctrl+S 时选择保存到的位置」。
 *
 * 也因此**不需要脏数据确认**：当前窗口一个字节都没动（对比「最近文档/最近文件夹 → 新窗口」的同一口径）。
 */
export async function newDocumentWindow(): Promise<void> {
  const root = useFilesStore().root
  // 有工作区 → 新窗口以同一个文件夹为工作区（磁盘上不产生任何文件）；
  // 没有工作区 → 退化成干净窗口（空白 + 未命名文档）
  if (root) window.luminAPI.app.openFolderInNewWindow(root)
  else window.luminAPI.app.newWindow()
}

export function useAppActions(): {
  handleMenu: (action: string) => void
  requestClose: () => void
} {
  const router = useRouter()
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const { runExport, runPrint } = useExport()
  const { setMode, cycleMode } = useEditorMode()
  const { toggleOutlineSide } = useOutlineSide()

  async function openFileDialog(): Promise<void> {
    if (!(await confirmIfDirty())) return
    const path = await window.luminAPI.file.chooseOpenFile()
    if (!path) return
    // 落点规则（本窗口无工作区 → 就本窗口打开并把侧栏切到它的文件夹；
    // 已有工作区 → 新窗口打开）统一在 lib/openFile.ts 里
    await openExternalFile(path)
    await router.push('/editor')
  }

  async function openFolderDialog(): Promise<void> {
    if (!(await confirmIfDirty())) return
    // 不发通知：文件树本身就是「打开成功了」的结果（见 stores/ui.ts 里 toast() 的分流口径）
    await files.openFolder()
  }

  async function saveDoc(): Promise<void> {
    // 不发通知：保存结果的可见反馈是窗口标题的脏标记与状态栏（同上）
    await files.save()
  }

  async function saveAsDoc(): Promise<void> {
    await files.saveAs()
  }

  /**
   * 焦点是否落在侧栏的**文件面板**里（文件树 / 列表 / 底部那行搜索与视图切换都在这个容器内）。
   *
   * 两个边界说清楚：
   *   * 侧栏里的**大纲**面板不算 —— 大纲是对当前正文的导航，在那里按 Ctrl+F 想找的仍是正文；
   *   * 侧栏头部（工作区名 / 最近 / 新建 / 刷新）也不算：那几枚按钮点完焦点不在面板里，
   *     此时 Ctrl+F 落回正文查找（想找文件名的话，点一下文件树任意一行即可）。
   * `closest` 存在性判断只为防御非元素 activeElement（如 SVG 环境下的 document 自身）。
   */
  function isFocusInSidebarFiles(): boolean {
    return typeof document === 'undefined'
      ? false
      : !!document.activeElement?.closest?.('[data-sidebar-files]')
  }

  function handleMenu(action: string): void {
    const a = action as MenuAction
    /**
     * 导出先走**清单查表**（审计 §6 P2「格式清单存在 5 处」）：`export-pdf/html/word/epub`
     * 这四条不再各写一个 case —— 加一种格式只改 `shared/exportFormats.ts`，
     * 这里与快捷键表、原生菜单、设置页那张表都自动跟上。
     */
    const exportHit = exportFormatByAction(a)
    if (exportHit) {
      void runExport(exportHit.id)
      return
    }
    switch (a) {
      case 'new':
        // 新窗口 + 工作区不变 + 未命名文档（Ctrl+S 时再选保存位置），见 newDocumentWindow
        void newDocumentWindow()
        break
      case 'new-window':
        window.luminAPI.app.newWindow()
        break
      case 'cycle-mode':
        cycleMode()
        break
      case 'open':
        void openFileDialog()
        break
      case 'open-folder':
        void openFolderDialog()
        break
      case 'save':
        void saveDoc()
        break
      case 'save-as':
        void saveAsDoc()
        break
      case 'print':
        // 打印与导出共用同一份 HTML + CSS，但落点是打印机而不是文件（也不落盘），
        // 所以它不进 EXPORT_FORMATS 清单，走这条独立动作（Ctrl+P / 菜单「打印…」）。
        void runPrint()
        break
      case 'find':
        // Ctrl+F / 菜单「查找」：打开右上角查找栏（再按一次关闭）。
        // 只展开查找 —— 替换那一行由栏里的折叠三角或 Ctrl+H 拉出来。
        //
        // 例外：**焦点在侧栏的文件面板里**时，Ctrl+F 进侧栏的文件名搜索（用户口径）。
        // 判定用「焦点落在哪个容器」而不是「鼠标在哪、侧栏是否可见」：
        //   * 文件树的行、底部搜索行、树/列表切换都在 `[data-sidebar-files]` 里，
        //     点一下它们焦点就进去了 —— 正是「人在侧栏里」的可判定证据；
        //   * 焦点在大纲 / 编辑区 / 其它任何地方（含没有工作区时）→ 照旧是正文查找。
        if (files.root && isFocusInSidebarFiles()) {
          ui.requestSidebarSearch()
          break
        }
        useFindStore().toggle()
        break
      case 'replace':
        // Ctrl+H / 菜单「替换」：打开查找栏并**直接展开替换行**（栏已开着时就地展开）
        useFindStore().showReplace()
        break
      case 'global-search':
        ui.openGlobalSearch()
        break
      case 'toggle-sidebar':
        ui.sidebarVisible = !ui.sidebarVisible
        settings.set('sidebarVisible', ui.sidebarVisible)
        break
      case 'toggle-toolbar':
        // 快捷工具栏的显隐（关闭后右键菜单也随栏消失，这是唯一的开关型入口）
        settings.set('toolbarVisible', !settings.toolbarVisible)
        break
      case 'outline-side':
        // 大纲位置（原生菜单 / 快捷键那两条路走到这里）：实现只有一份，见 useOutlineSide
        toggleOutlineSide()
        break
      case 'mode-wysiwyg':
        setMode('wysiwyg')
        break
      case 'mode-source':
        setMode('source')
        break
      case 'mode-split':
        setMode('split')
        break
      case 'toggle-focus':
        ui.focusMode = !ui.focusMode
        break
      // 「打字机模式」这一档已整体摘掉（菜单项 + Ctrl+Shift+T + 状态字段）：
      // 它此前只是一句「功能待接入」的提示，留着等于承诺一个不存在的能力（审计 §7）。
      case 'settings':
        ui.openSettings()
        break
      case 'about':
        void router.push('/about')
        break
      case 'theme-changed':
        void settings.init()
        break
    }
  }

  // ── 全局快捷键 ──
  // 已迁移到命令注册表 + keybinding 服务（composables/useKeymap.ts + lib/keymap/）：
  // 键位集中声明、用户可在「设置 → 快捷键」里改，且与原生菜单共用同一份 handleMenu 实现，
  // 因此这里不再保留任何硬编码按键判断（避免两套真相/重复触发）。

  // ── 关闭守卫：保存全部并放行 ──
  /**
   * 主进程的兜底从"固定 2.5 秒"改成了"心跳停了才强杀"（审计 §2 P1：慢盘/大文件下
   * `flushAll()` 没跑完窗口就没了，丢的正是用户以为已保存的那一段）。所以这里在落盘期间
   * **按秒发心跳**：只要还在干活，主进程就一直等；卡死超过 2.5 秒才兜底，
   * 总时长另有 30 秒上限（见 shared/closeGuard.ts）。
   *
   * ── 手动保存模式下要**先问一次**（用户口径，对齐 Typora）────────────────────
   * 自动保存关着时（本项目出厂默认），关窗前弹「是否保存更改？／如果不保存，您的更改将会丢失。」
   * （保存 / 不保存 / 取消）。判定与文案在 `lib/dialog.ts` 的 `resolveCloseIntent`，
   * 纯规则在 `shared/closePrompt.ts`（自动保存开着不问、系统关机不问）。
   * 三条出路各自要收尾：
   *   * 保存 → `files.save()`；未命名文档会走「另存为」，**取消/失败就别关窗**（否则等于丢字）；
   *   * 不保存 → **不**走 `flushAll()`（它会保存有路径的文档！），改成丢掉草稿后直接放行；
   *   * 取消 → 让主进程撤掉这一轮的守卫（`app:cancelClose`）。不撤的话兜底计时器照跑，
   *     2.5 秒没心跳就强关 —— 用户点了取消却看着窗口关掉。
   * 心跳在这三种情况下都得继续发（对话框可能被用户晾着），所以 interval 只在函数末尾清。
   */
  async function requestClose(payload?: { reason?: CloseReason }): Promise<void> {
    const reason: CloseReason = payload?.reason ?? 'window'
    // 每轮关窗都从"还没决定不保存"开始：`discardOnClose` 是上一轮可能留下的状态
    // （见 files store 的 discardCurrentDraft —— 它让窗口销毁时的兜底 flushAll 变成空操作）
    files.discardOnClose = false
    /**
     * 心跳里带 `deciding`：正等用户回答「是否保存更改？」时告诉主进程"这段等待不算卡死"，
     * 否则用户犹豫超过 30 秒（总上限）会在点「取消」之前被强关（见 main/ipc.ts）。
     */
    let deciding = false
    const beat = setInterval(() => window.luminAPI.app.closeProgress({ deciding }), 1000)
    window.luminAPI.app.closeProgress()
    try {
      deciding = true
      const intent = await resolveCloseIntent({
        autoSave: settings.autoSave,
        reason,
        dirty: () => files.dirty
      })
      // 用户已经答完了（或者压根没问）：后面的落盘不算"等人"，照常计入兜底时限
      deciding = false
      if (intent === 'cancel') {
        window.luminAPI.app.cancelClose()
        return
      }
      if (intent === 'save') {
        const ok = await files.save()
        // 另存为被取消、或写盘失败：**不关窗**（用户以为自己保存了才是最糟的结果）
        if (!ok) {
          window.luminAPI.app.cancelClose()
          return
        }
      }
      if (intent === 'discard') {
        await files.discardCurrentDraft()
        await flushSession()
        return
      }
      await files.flushAll()
      // 会话位置（光标/滚动）也补一次：窗口销毁前最后的状态
      await flushSession()
    } finally {
      clearInterval(beat)
    }
    await window.luminAPI.app.confirmClose()
  }

  // ── 事件绑定 ──
  /**
   * 外部改动冲突通知卡片上的两个按钮（审计 §2 P1）。
   *
   * 为什么是通知而不是把确认框扩成三选一：确认框只有两键，而冲突有三条出路
   * （覆盖 → 手动保存时问的那一次；另存为 / 重新打开 → 这里）。通知卡支持按钮，
   * 而且它会一直留在通知中心里 —— 用户什么时候决定都行，不会因为对话框被关掉而丢。
   */
  registerNotificationActions(SAVE_CONFLICT_KIND, async (n, actionId) => {
    const path = String(n.payload?.path ?? '')
    if (actionId === 'save-as') {
      await files.saveAs()
      return
    }
    if (actionId === 'reload' && path) {
      // `discardChanges`：用户在卡片上**明确点过**"放弃我的改动"，这里不再问第二次
      await files.openPath(path, { discardChanges: true })
    }
  })

  const offMenu = window.luminAPI.events.on('menu:action', (payload) => handleMenu(String(payload)))
  // `app:before-close` 的 payload 带 `reason`（window / quit / session-end）：
  // 系统关机（session-end）不弹「是否保存更改？」—— 没人能点那个按钮，见 shared/closePrompt.ts
  const offClose = window.luminAPI.events.on(
    'app:before-close',
    (payload) => void requestClose((payload ?? {}) as { reason?: CloseReason })
  )
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemTheme = (): void => {
    if (settings.theme === 'auto') settings.applyAll()
  }
  media.addEventListener('change', onSystemTheme)

  onBeforeUnmount(() => {
    offMenu()
    offClose()
    media.removeEventListener('change', onSystemTheme)
  })

  return { handleMenu, requestClose }
}
