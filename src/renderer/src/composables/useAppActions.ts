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
import { DOC_SAFE_MODE_KIND, PASTE_PLAIN_KIND } from '../lib/safety'
import { pastePlainIntoEditor } from '../lib/plainPaste'
import { ctrlFTarget, type CtrlFTarget } from '../lib/ctrlFRoute'
import { installPointerRegionTracker, pointerIsMoreRecentThanFocus } from '../lib/pointerRegion'
import { exportFormatByAction } from '../../../shared/exportFormats'
import { exportStartupDiagnostics } from '../lib/startupDiagnostics'
import type { CloseReason } from '../../../shared/closePrompt'
import type { MenuAction, AppSettings } from '../../../shared/types'

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

/**
 * 本窗口的「动作 / 事件订阅」只装一次。
 *
 * 为什么必须有这个闸（用户报障的真根因）：`useAppActions()` 会被**两个**组件各调一次 ——
 * `App.vue`（第 47 行）与常驻挂载的 `CommandPalette.vue`（它也要拿 `handleMenu` 组命令表）。
 * 这个函数此前把所有副作用（`app:before-close` / `menu:action` / `settings:changed` /
 * 主题媒体查询 / 指针区域 / 通知动作）都写在函数体里，于是每个订阅都注册了**两份**：
 *   * 实测：一次 Ctrl+W 收到两次 `app:before-close` → 两个 `requestClose` 同时弹框/保存；
 *   * 第二个保存的 `file:write` 在窗口销毁后才落地，临时文件来不及 rename/清理 ——
 *     这正是 D 盘残留 `数学公式保存后 .lumin-tmp` 的来源（见 `main/services/writeDrain.ts`）。
 *
 * 修法：建函数（返回 handleMenu/requestClose）保持无副作用，只有**第一次**调用安装订阅；
 * 卸载时复位（正常退出时不会走到，但热更新/测试里要能重装）。
 */
let appActionListenersInstalled = false

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
   * Ctrl+F 的分流现场：把事实读出来喂给纯函数 `ctrlFTarget`（规则与理由都在那个文件里）。
   *
   * 判据从「焦点在 `[data-sidebar-files]` 里」放宽成「焦点**或指针**在左侧栏里」（§4.84），
   * 再到第十轮的"**上一次交互**在哪儿"（`lib/pointerRegion.ts`）—— 三次修正的现场都在
   * `_verify-sidebar-search.js` 的 B/D 两段：那两段的"焦点 + 此刻指针"完全一样，
   * 只有时间顺序能区分（B 是先动鼠标再点正文，D 是先点正文再动鼠标）。
   */
  function ctrlFTargetNow(): CtrlFTarget {
    if (typeof document === 'undefined') return 'document'
    const sidebar = document.querySelector('[data-sidebar-root]')
    const active = document.activeElement
    return ctrlFTarget({
      workspaceOpen: !!files.root,
      filesPanelVisible: settings.outlineOnRight || ui.sidebarTab === 'files',
      focusInSidebar: !!active?.closest?.('[data-sidebar-root]'),
      focusInEditor: !!active?.closest?.('[data-editor-kernel]'),
      sidebarPointerRecent: pointerIsMoreRecentThanFocus('sidebar'),
      pointerInSidebar: !!sidebar?.matches?.(':hover')
    })
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
        // 例外：**人在左侧栏里**时，Ctrl+F 进侧栏的文件名搜索（用户口径 §4.84）。
        // 「人在侧栏里」= 焦点或指针在左侧栏内（详见 lib/ctrlFRoute.ts 的说明）——
        // 旧判据只看"焦点在文件面板内"，于是页签上 / 侧栏空白处 / 鼠标在侧栏但焦点在编辑器
        // 这三种情况仍然开着正文查找栏，正是用户报的那个现象。
        if (ctrlFTargetNow() === 'sidebar-files') {
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
      case 'paste-plain':
        // 粘贴为纯文本（Ctrl+Shift+V / 编辑菜单 / 右键菜单 / 粘贴护栏提示按钮）：
        // 唯一实现在 lib/plainPaste.ts —— 不解析 HTML、表格、公式或 Markdown。
        void pastePlainIntoEditor()
        break
      case 'settings':
        ui.openSettings()
        break
      case 'about':
        void router.push('/about')
        break
      case 'export-startup-diagnostics':
        // 原生菜单「帮助 → 导出启动诊断」走到这里；顶部栏/状态栏/设置页直接调同一个函数
        void exportStartupDiagnostics()
        break
      /**
       * `theme-changed` 这条菜单动作**已删除**（报告 §3.2 P0-2）：原生菜单的主题项以前写
       * electron-store（那只是历史配置的一次性迁移源）再发这条动作让渲染层 `settings.init()`
       * 从 SQLite 重读 —— 于是永远读到旧主题，点了没反应。现在菜单直接走主进程的
       * `services/appSettings.patchSettings()`，由广播通道 `settings:changed` 通知渲染层
       * （订阅见文件末尾），不需要这条动作。
       */
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
   * ── 手动保存模式下要**先问一次**（用户口径，对齐主流编辑器）────────────────────
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
    /**
     * "这一轮关窗要真的放行吗"。
     *
     * ⚠️ 以前这里靠 `return` 提前退出，而 `confirmClose()` 写在 try 之后 ——
     * 「不保存」那条路正好 `return`，于是**跳过了确认关窗**，窗口只能等主进程
     * 2.5 秒的 stalled 兜底强杀才关（功能上能关，但白等，且与"显式确认"的设计意图不符；
     * 本项的回归断言在 `tools/_verify-close-save-prompt.js`）。
     * 改成"一条出口 + 一个标志"之后，任何新增分支都不会再漏掉确认（取消/保存失败必须置 false）。
     */
    let closeNow = true
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
        closeNow = false
      } else if (intent === 'save') {
        const ok = await files.save()
        // 另存为被取消、或写盘失败：**不关窗**（用户以为自己保存了才是最糟的结果）
        if (!ok) {
          window.luminAPI.app.cancelClose()
          closeNow = false
        }
      } else if (intent === 'discard') {
        await files.discardCurrentDraft()
        await flushSession()
      } else {
        await files.flushAll()
        // 会话位置（光标/滚动）也补一次：窗口销毁前最后的状态
        await flushSession()
      }
      /**
       * **设置也要在放行前落盘**（用户实测：改完快捷键/恢复默认 → 顺手关应用 → 重开后改动没了）。
       *
       * 为什么必须在这里：设置落库是 **250ms 节流**的，而"改完设置就关应用"正是最常见的路径 ——
       * 窗口一旦销毁，挂起的定时器和还没回来的 IPC 全都不存在了，这一次修改就永远写不下去。
       * `flush()` 会掐掉挂起的节流写入并把**当前整份 state** 立刻推给主进程（可 await）。
       * 放在 try 内、`clearInterval(beat)` 之前：心跳还活着，主进程的兜底（连续 2.5s 无心跳才强杀）
       * 不会因为我们多等这一次毫秒级 IPC 而提前关窗。
       * 只在**真要关**的时候写（取消/保存失败那条路窗口继续活着，节流定时器照常会落地）。
       */
      if (closeNow) await settings.flush()
    } finally {
      clearInterval(beat)
    }
    if (closeNow) await window.luminAPI.app.confirmClose()
  }

  // ── 事件绑定（每个窗口只装一次，见文件上方 `appActionListenersInstalled` 的说明）──
  if (!appActionListenersInstalled) {
    appActionListenersInstalled = true
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

    /**
     * 粘贴护栏提示上的「改用纯文本粘贴」。
     * 按钮本身不带剪贴板内容（正文绝不进通知表），点的时候重新读一次剪贴板。
     */
    registerNotificationActions(PASTE_PLAIN_KIND, async (_n, actionId) => {
      if (actionId === 'plain') await pastePlainIntoEditor()
    })

    /**
     * 连续两次崩溃/无响应后的安全模式提示（见 stores/files.openPath）：
     * 用户明确点「仍然以富文本打开」⇒ 清零这份文档的风险记录并切回实时渲染。
     */
    registerNotificationActions(DOC_SAFE_MODE_KIND, async (n, actionId) => {
      if (actionId !== 'rich') return
      const path = String(n.payload?.path ?? '')
      if (path) await window.luminAPI.freeze.clearDocRisk(path).catch(() => {})
      ui.editorMode = 'wysiwyg'
    })

    const offMenu = window.luminAPI.events.on('menu:action', (payload) =>
      handleMenu(String(payload))
    )
    // `app:before-close` 的 payload 带 `reason`（window / quit / session-end）：
    // 系统关机（session-end）不弹「是否保存更改？」—— 没人能点那个按钮，见 shared/closePrompt.ts
    const offClose = window.luminAPI.events.on(
      'app:before-close',
      (payload) => void requestClose((payload ?? {}) as { reason?: CloseReason })
    )
    /**
     * 主进程改了设置（原生菜单的主题项、备份目录选择…）→ 就地 patch store。
     *
     * 报告 §3.2 P0-1：设置此前是"两处真相"，主进程写 kv 不通知渲染层 ⇒ 界面显示旧值到重启。
     * 现在主进程只走 `services/appSettings.ts` 的写入口并广播这条通道（preload 白名单里已登记，
     * `tests/i18nAndIpc.test.mjs` 双向对账），这里订阅它即可 —— 不再需要"每个调用点自己记得同步"。
     */
    const offSettings = window.luminAPI.events.on('settings:changed', (payload) => {
      if (payload && typeof payload === 'object') settings.applyRemote(payload as AppSettings)
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemTheme = (): void => {
      if (settings.theme === 'auto') settings.applyAll()
    }
    media.addEventListener('change', onSystemTheme)

    /**
     * 指针区域跟踪（Ctrl+F 分流用，见 `lib/ctrlFRoute.ts` 与 `lib/pointerRegion.ts`）：
     * 装上之后"最近一次指针交互在侧栏还是编辑区"就有据可查 ——
     * 只看"焦点 + 此刻悬停"分不清 B 段（先动鼠标再点正文）与 D 段（先点正文再动鼠标）。
     */
    const offPointerRegion = installPointerRegionTracker()

    onBeforeUnmount(() => {
      appActionListenersInstalled = false
      offMenu()
      offClose()
      offSettings()
      offPointerRegion()
      media.removeEventListener('change', onSystemTheme)
    })
  }

  return { handleMenu, requestClose }
}
