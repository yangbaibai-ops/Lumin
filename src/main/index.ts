// 必须在任何会（传递）导入 node:sqlite 的模块之前加载，以屏蔽其实验性警告
import './devProfile'
import './suppressWarnings'
// 单实例锁：抢不到锁的进程在这里就退出了。**必须**排在会读 userData 的模块（./menu、./ipc
// → services/database：`db` 是模块级 new）之前，理由见 singleInstance.ts 的文件头。
import './singleInstance'
import {
  app,
  shell,
  BrowserWindow,
  nativeTheme,
  protocol,
  net,
  ipcMain,
  screen,
  // ⚠️ 名字冲突：本文件下面还有 `import * as session from './services/session'`（会话恢复），
  // 所以 Electron 的这个 session 必须起别名
  session as electronSession
} from 'electron'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
// 窗口图标与任务栏/开始菜单快捷方式/跳转列表**共用同一个文件**（resources/icon.ico，
// 现行为七档 16/24/32/48/64/128/256 的 32 位 BGRA DIB，由 tools/pack-ico.js 从
// resources/icon.png 打出；Windows 会按场景挑最合适的尺寸）；不要在这里另引 PNG，
// 否则同一应用会出现两种图标。
import appIconPng from '../../resources/icon.png?asset'
import { installMenu } from './menu'
import {
  canRestoreWindow,
  windowStateFor,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT
} from './windowPlacement'
import { planOpenRequest } from './openRequest'
import { mainT } from './i18n'
import { registerIpc, attachCloseGuard } from './ipc'
import * as spellcheck from './services/spellcheck'
import * as freezeGuard from './services/freezeGuard'
import { isServableMedia } from './fileOps'
import * as links from './services/links'
import { migrateLegacyStores } from './store'
import { db } from './services/database'
import * as session from './services/session'
import * as openDocs from './services/openDocs'
// 打印预览作业：退出时清掉它的临时目录（开预览本身走 ipc.ts 的 print:preview）
import * as printPreview from './printPreview'
import * as taskbar from './services/taskbar'
import { recordBuildStamp, recordLaunchIntent } from './services/buildStamp'
import { devProfileDir } from './devProfile'
import { parseLaunchIntent, type LaunchIntent } from './services/launchIntent'
import { initUpdater } from './services/updater'
import { startAutoBackup } from './services/dbBackup'
import { gcDrafts } from './drafts'
import { beginShutdown } from './services/shutdown'
import { bindWindowScope, scopeOfSlot } from './services/windowScope'
import * as pathGrants from './services/pathGrants'
import { defaultSettings } from '../shared/defaults'
import { paperForTheme } from '../shared/theme'
import { CSP_HEADER_ONLY } from '../shared/csp'
// 浏览器级键的拦截策略（纯函数，见该模块顶部说明：刷新族/DevTools/缩放/F7/F11 全拦）
import { blockedShortcut, comboLabel } from '../shared/shortcuts'
import { recordFatal } from './services/appLog'
import { initStartupLog, recordRendererStartup, startupMark } from './services/startupLog'
import { topLevelName } from '../shared/startupLog'
import { mkdirSync, statSync } from 'fs'
import { portableDataDir } from '../shared/portable'

/**
 * ─── 便携版：数据跟着 exe 走（报告 §P2「功能缺口：便携版」）────────────────────
 *
 * electron-builder 的 `portable` target 运行时会把 `PORTABLE_EXECUTABLE_DIR` 注入环境，
 * 据此把 userData 改到 exe 旁边（`<exe 同级>/LuminData`）—— 只有这样做，"绿色版"才是
 * **免安装 + 数据随身**，而不是"免安装但数据仍留在本机的 %APPDATA%"（后者换台机器打开
 * 会像"全空了"，而旧机器上那份数据还在，最难排查）。
 *
 * 三条口径：
 *   * **不在便携模式时什么都不做**（判定在 shared/portable.ts，纯函数、可单测）；
 *   * 目录建不出来（U 盘只读/被占用）时**退回 Electron 默认并留一行日志** ——
 *     宁可数据留在本机，也不能让应用因为写不了 U 盘而起不来；
 *   * 必须在**任何模块级 userData 读取之前**执行：这就是 `drafts.ts` 的草稿目录
 *     改成惰性求值的原因（模块级 `const` 会把 import 期的旧路径钉死）。
 */
function applyPortableDataDir(): void {
  const dir = portableDataDir(process.env)
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
    // 主进程 console 一律 ASCII（见 tests/mainConsoleAscii.test.mjs）
    console.log(`[portable] userData -> ${dir}`)
  } catch (err) {
    console.log(
      `[portable] fallback to default userData: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
applyPortableDataDir()
// 启动诊断日志：必须在 userData 定下来之后、任何模块读 userData 之前初始化
// （"本次是否首次运行"的判据要在开库之前取）。默认开启，`LUMIN_STARTUP_LOG=0` 可关。
initStartupLog()

/**
 * ─── 主进程崩溃 / 未处理 rejection 留证据（审计 §9 P1）────────────────────────
 *
 * 此前主进程异常只在终端上出现（打包态用户根本看不到），用户报「闪退」时我们手里没有任何
 * 现场。现在把异常落一行到 `<userData>/logs/app.log`（位置/轮转见 services/appLog.ts）。
 *
 * 口径：
 *   * `unhandledRejection` —— 只记，不改变行为（Node 默认也只是警告）；
 *   * `uncaughtException` —— 记完 **仍然退出**：Node 对未捕获异常的默认行为就是中止进程，
 *     这里只是让"崩了"留下证据，不是把崩溃吞掉（吞掉会让应用停在一个半坏的状态里）。
 */
process.on('unhandledRejection', (reason) => {
  recordFatal('unhandledRejection', reason)
})
process.on('uncaughtException', (err) => {
  recordFatal('uncaughtException', err)
  process.exit(1)
})

// 本地文件协议（用于 Markdown 内相对路径图片，兼容 dev/prod 与 CSP）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumin-file',
    privileges: { secure: true, supportFetchAPI: true, stream: true }
  }
])

// 应用标识（AppUserModelID）。
// 应用名 `app.setName('Lumin')` 在 singleInstance.ts 里设置：它必须早于单实例锁与 userData 的
// 首次读取，只有那个模块的求值顺序能保证这一点（见该文件头）。
// 不用 electronApp.setAppUserModelId()：它在开发态会把标识设成 process.execPath，
// 于是 Windows 把窗口当成 electron.exe（右键菜单第一项显示「Electron」，点它启动无参数的
// electron.exe）。标识必须由我们自己的 appId() 给，并且配套写一条开始菜单快捷方式，详见
// services/taskbar 的文件头说明。
app.setAppUserModelId(taskbar.appId())

// 可选：通过环境变量开启远程调试端口（用于自动化验证）
if (process.env.LUMIN_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.LUMIN_DEBUG_PORT)
}

// 单实例锁在 ./singleInstance 里完成（import 时即求值）：抢不到锁的进程在那里就已经 app.exit，
// 因此下面这些启动逻辑（IPC 注册、会话恢复、窗口创建）只会被**首个实例**执行。
// 对比：写成 `if (!app.requestSingleInstanceLock()) app.quit()` 是**不够**的 —— quit() 在 ready
// 前只是标记，whenReady 回调照跑，第二个实例仍会开库/建窗/抢 GPU 缓存（详见 singleInstance.ts）。

// ─── 会话恢复：窗口 ↔ 槽位 归属（「整体退出 vs 单独关窗」的判定在 services/session）──
/** window.id → 会话槽位 */
const slotOfWindow = new Map<number, number>()
/**
 * window.id → 该**窗口实例**的 uid（随机生成，随窗口 argv 交给它的渲染进程）。
 * 会话槽位号会被复用，光靠槽位分不清「这格草稿是我自己上次写的」还是「上一个住户留下的」；
 * 草稿带上 uid 才答得准（见 main/drafts.ts 的 takeUntitledDraft / shared/drafts.ts）。
 */
const uidOfWindow = new Map<number, string>()
/**
 * 本次运行的**启动窗口**（第一个建出来的那个）。只有它能认领「无主草稿」：
 * Ctrl+N / 新建窗口是用户明确要一篇空白，不该被上一次没保存的内容打断。
 */
let startupWindowId: number | null = null
app.on('before-quit', () => {
  session.markQuitting()
  beginShutdown('before-quit')
  // 退出前把排队的全文索引落盘（索引是节流的，见 services/database.ts 的 scheduleFtsIndex）
  try {
    db.flushFtsIndex()
  } catch {
    /* 退出路径上的失败不该拦住退出 */
  }
  // 打印预览的临时目录（`<temp>/lumin-print-preview-*`）：退出时一并收掉，
  // 别把用户临时目录里塞满预览 PDF（正常关闭路径在窗口 `closed` 里已经删过一次，这里幂等）
  try {
    printPreview.cleanupPrintPreviews()
  } catch {
    /* 同上：清理失败不拦住退出 */
  }
})

/**
 * 新窗口领一个自动分配的槽位。
 * 同一个槽位号可能被不同时期的窗口用到（重启后旧槽位仍在 kv 里、关掉恢复开关后重新
 * 从 0 分配），所以领到槽位的同时清掉该作用域里上一任窗口遗留的数据（当前是通知），
 * 避免「新开的窗口冒出上一个窗口的提示」。
 * 会话恢复走的是显式槽位（planRestore → createWindow({ sessionSlot })），不经这里，故不受影响。
 */
function claimFreshSlot(): number {
  const slot = session.claimSlot()
  db.deleteNotificationsByScope(scopeOfSlot(slot))
  return slot
}

// 主题背景色（避免启动闪白）：必须等于渲染层写作区的纸色（style.css 的 --paper），
// 否则窗口在页面首次绘制前会先露出一块别的颜色。镜像值见 shared/theme.ts，
// 与 style.css 的一致性由 tests/themeTokens.test.mjs 在 `npm run ci` 里钉住。
function themeBackground(): string {
  return paperForTheme(db.kvGet('settings', defaultSettings).theme, nativeTheme.shouldUseDarkColors)
}

/** 窗口位置/大小持久化（记住上次关闭时的位置与尺寸） */
interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

/**
 * 保存过的窗口位置还能不能用（尺寸够大 + 与某个显示器工作区相交）。
 * 纯规则抽在 `main/windowPlacement.ts`（不 import electron，有单测）——
 * 这里只负责把「当前显示器的工作区」喂进去。
 */
function validWindowBounds(s: WindowState): boolean {
  return canRestoreWindow(
    s,
    screen.getAllDisplays().map((d) => d.workArea)
  )
}

function saveWindowState(win: BrowserWindow): void {
  // 「最大化时存 normalBounds」这条规则抽在 windowPlacement.ts（有单测）：
  // 存 getBounds() 会把"被撑满的屏幕矩形"当成还原尺寸，下次先按大尺寸建窗再最大化，多一次跳变。
  db.kvSet(
    'windowState',
    windowStateFor({
      bounds: win.getBounds(),
      normalBounds: win.getNormalBounds(),
      isMaximized: win.isMaximized()
    }) satisfies WindowState
  )
}

// CSP 的响应头只注册一次（session 为所有窗口共享，避免重复监听）
let cspHeaderInstalled = false

/** 创建窗口时的启动意图：打开某个文件 / 打开某个文件夹 / 干净窗口 / 参与会话恢复的槽位 */
interface WindowOpenOptions {
  /** 启动后打开的文件（--lumin-open） */
  openFile?: string
  /** 启动后作为工作区打开的文件夹（--lumin-open-folder） */
  openFolder?: string
  /**
   * 干净窗口（--lumin-no-workspace）：「新建窗口」用它，不继承当前工作区。
   * 工作区根目录在 kv 里是**全局**的，若不做区分，新窗口会顺带把别人的文件夹树也带出来。
   */
  noWorkspace?: boolean
  /** 会话槽位（渲染进程据此读写自己的会话；主进程负责单窗关闭时清空） */
  sessionSlot?: number
}

/**
 * 创建应用窗口。openFile / openFolder 通过 additionalArguments 告诉渲染进程
 * 启动后要打开什么（「在新窗口打开」与「最近文件夹」用）；sessionSlot 非空时该窗口
 * 参与会话恢复。首个窗口恢复上次的位置/大小，后续窗口基于最近窗口级联偏移。
 */
function createWindow(options: WindowOpenOptions = {}): BrowserWindow {
  const { openFile, openFolder, noWorkspace, sessionSlot } = options
  // 启动参数里带的文件 / 文件夹是**主进程自己解析出来的**，天然可信 → 登记为授权路径
  // （否则"双击一个工作区外的 .md"会在 file:read 的授权闸上被拦掉）
  pathGrants.grantStartup(openFile, openFolder)
  const existing = BrowserWindow.getAllWindows()
  const isFirst = existing.length === 0
  const windowUid = randomUUID()

  let x: number | undefined
  let y: number | undefined
  let width = 1320
  let height = 860
  let restoreMaximized = false

  if (isFirst) {
    const state = db.kvGet<WindowState | null>('windowState', null)
    // 尺寸与位置的判据都在 canRestoreWindow 里（含"小于最小窗口不采用"）
    if (state && validWindowBounds(state)) {
      x = state.x
      y = state.y
      width = state.width
      height = state.height
      restoreMaximized = state.isMaximized
    }
  } else {
    const ref = BrowserWindow.getFocusedWindow() ?? existing[existing.length - 1]
    if (ref) {
      const rb = ref.getBounds()
      x = rb.x + 28
      y = rb.y + 28
      width = rb.width
      height = rb.height
    }
  }

  const mainWindow = new BrowserWindow({
    width,
    height,
    // 与 windowPlacement.ts 的常量同源（波次 2 从 940×600 降到 760×520：
    // 1366×768 @150% 缩放只有 911×512 可用，旧最小尺寸比屏幕还大）
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    show: false,
    autoHideMenuBar: false,
    backgroundColor: themeBackground(),
    title: 'Lumin',
    // 窗口图标 = 任务栏按钮图标。
    // **打包态不传**：图标已经嵌进 Lumin.exe（win.icon），Windows 自己会取 —— 这是
    // 「确实需要另一种图标类型」的正当例外，也免掉一整类图标缓存问题。
    // **开发态必须显式传**：进程是 electron.exe，不自带我们的图标，不传就显示 Electron 的 logo
    // （以前这里只在 linux 传，Windows 下一直是错的）。Windows 用 ICO，其余平台用 PNG。
    ...(app.isPackaged
      ? {}
      : { icon: process.platform === 'win32' ? taskbar.runtimeIconPath() : appIconPng }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 每个窗口实例一个 uid（见 uidOfWindow 的说明）：草稿靠它区分「我自己写的」与
      // 「上一个住户/上一次运行留下的」。窗口 argv 是 per-window 的，reload 后也不变。
      additionalArguments: [
        ...(openFile ? [`--lumin-open=${encodeURIComponent(openFile)}`] : []),
        ...(openFolder ? [`--lumin-open-folder=${encodeURIComponent(openFolder)}`] : []),
        ...(noWorkspace ? ['--lumin-no-workspace=1'] : []),
        ...(sessionSlot !== undefined ? [`--lumin-session-slot=${sessionSlot}`] : []),
        `--lumin-window-uid=${windowUid}`
      ]
    }
  })

  /**
   * 启动分段打点（仅 `LUMIN_STARTUP_LOG=1` 时输出，零成本）：把窗口加载拆成
   * did-start-loading / dom-ready / did-finish-load 三段。只记**首次**（`once`）——
   * 多窗口时后续窗口不该混进首屏口径；`startup()` 的标签取第一次出现的那条。
   */
  mainWindow.webContents.once('did-start-loading', () => {
    startup('window-did-start-loading')
    startupMark('window-did-start-loading', { first: isFirst })
  })
  mainWindow.webContents.once('dom-ready', () => {
    startup('window-dom-ready')
    startupMark('window-dom-ready', { first: isFirst })
  })
  mainWindow.webContents.once('did-finish-load', () => {
    startup('window-did-finish-load')
    startupMark('window-did-finish-load', { first: isFirst })
  })

  /**
   * 「哪个窗口开着哪个文档」这张表**当场登记启动参数里的文件**（审计 §6 P2 打包态覆盖时实测到的缺口）。
   *
   * 为什么不能只靠渲染层上报（`renderer/lib/openFile.ts` 的 `installOpenDocTracking`）：
   * 那条 IPC 要等窗口加载完、首次渲染才到，而这篇文档里的相对图片（`![](./a.png)`）
   * **在首帧就会去请求 `lumin-file://`** —— 协议白名单（`isServableMedia`）查的正是这张表。
   * 晚一步的后果是首屏图片被协议 404，而浏览器对失败的 `<img>` **不会自己重试**：
   * 用户双击一个带相对图片的 .md 看到的是破图（切走再切回来才好）。
   * 打包态实测可复现（`_verify-packaging-fast.js` 的 F5：首次测量 naturalWidth=0、
   * 主进程日志 `[protocol] refused lumin-file request: …`；手动补报同一路径后立刻 1024）。
   * 主进程此刻**已经知道**这件事（openFile 就是它自己从启动参数解出来的），没理由等渲染层告诉它。
   *
   * 渲染层的上报仍然是"文档切换"的唯一来源（这只补上**启动那一篇**），
   * 同时它也让「一个文件只开一个窗口」的判据在首帧就成立。
   */
  if (openFile) openDocs.setWindowDoc(mainWindow, openFile)

  // 会话槽位归属：窗口被「单独关闭」时**保留**它的槽位并标记「已关闭」——
  // 用户关窗往往就是「今天先这样」，下次启动要回到刚才那篇文档（只清掉槽位的话，
  // 重启后只剩工作区文件夹、文档变成不落在任何位置的未命名缓冲区）。
  // 整体退出时不动槽位，让下次启动把当时活着的窗口全部恢复。
  // 同一时刻它的窗口作用域（通知等窗口私有数据）也随窗口一起销毁。
  if (sessionSlot !== undefined) {
    slotOfWindow.set(mainWindow.id, sessionSlot)
    mainWindow.on('closed', () => {
      slotOfWindow.delete(mainWindow.id)
      if (!session.isQuitting()) {
        session.markSlotClosed(sessionSlot)
        db.deleteNotificationsByScope(scopeOfSlot(sessionSlot))
      }
    })
  }
  // 窗口作用域：通知等「属于某个窗口」的数据按它隔离（见 services/windowScope）
  bindWindowScope(mainWindow, sessionSlot)
  // 「哪个窗口开着哪个文档」注册表：窗口关闭即清账，不留已销毁窗口的条目
  mainWindow.on('closed', () => openDocs.forgetWindow(mainWindow.id))
  // 窗口实例 uid：草稿归属靠它（窗口没了就注销，那份草稿随即变成「无主」）
  uidOfWindow.set(mainWindow.id, windowUid)
  mainWindow.on('closed', () => uidOfWindow.delete(mainWindow.id))

  if (restoreMaximized) mainWindow.maximize()

  // 隐藏系统原生菜单条：顶部菜单栏由渲染层 TopMenuBar 呈现（位置精确、
  // Alt+F/E/V/H 确定性）；应用菜单仍安装，Ctrl+N/O/S 等加速键继续生效。
  // autoHideMenuBar=false：彻底禁用「按 Alt 唤出原生菜单条」的行为（true 会
  // 让菜单条在按 Alt 时重新弹出）
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(false)

  // 关闭时记住当前窗口位置/大小（下次启动恢复）
  mainWindow.on('close', () => saveWindowState(mainWindow))

  /**
   * 拼写检查的右键参数来源（`context-menu`）。
   * 必须在窗口加载前挂上：正文的 DOM contextmenu 有意**不** preventDefault
   * （见 services/spellcheck.ts 的说明），第一次右键就该拿到 misspelledWord。
   */
  spellcheck.attachSpellcheckContextMenu(mainWindow.webContents)

  attachCloseGuard(mainWindow)
  // 全局防卡死兜底：心跳巡检 + unresponsive/responsive/render-process-gone 事件。
  // 每个窗口一份状态（见 services/freezeGuard.ts），窗口关闭自动清理。
  freezeGuard.attachFreezeGuard(mainWindow)

  // 开发环境：转发渲染进程控制台日志，便于排查（Electron 39 新签名：单个 Event 对象）
  if (is.dev) {
    mainWindow.webContents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning') {
        console.log(
          `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`
        )
      }
    })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    startup('window-shown')
    startupMark('window-shown', { first: isFirst })
  })

  // 外部链接交给系统浏览器 —— 一律先过 `safeExternalUrl` 的 scheme 白名单
  //（不许自己写 `/^https?:\/\//` 这种就地判据：口径只该有一处，见 services/links.ts）
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const safe = links.safeExternalUrl(details.url)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })

  /**
   * 导航兜底：文档里的链接若没被渲染层的点击拦截逻辑覆盖（中键点击、表格里、或脚本里
   * `location.href = …`），窗口会被**整个导航走** —— 应用 UI 消失、CSP 随导航失效，
   * 用户看到的是一个浏览器窗口。这里只允许停留在我们自己的页面上，其余拦下来并交给系统浏览器
   * （与上面的 setWindowOpenHandler、以及 shell:openExternal 的白名单同一口径）。
   * 注意：应用内路由是 hash 变化，走的是 did-navigate-in-page，不会触发本事件。
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const here = new URL(mainWindow.webContents.getURL())
      const next = new URL(url)
      if (next.origin === here.origin && next.pathname === here.pathname) return // 同页（仅 hash 变化时通常不会走到这里）
    } catch {
      /* URL 解析失败 → 当作不可信，继续走拦截 */
    }
    event.preventDefault()
    const safe = links.safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
  })

  /**
   * ─── CSP 的**响应头**那一半（`<meta>` 里无效的指令只能这么下发）──────────────────
   *
   * 背景：`frame-ancestors`（以及 `report-uri` / `sandbox`）通过 `<meta>` 下发时**会被浏览器
   * 直接忽略**，控制台还会打一条
   * `The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a
   * <meta> element.` —— 也就是说那条指令此前**根本没生效**（"以为设了其实没设"）。
   *
   * 所以：`<meta>` 版（`PROD_CSP`）里删掉它们，改由这里用响应头下发；头里**只放**
   * `CSP_HEADER_ONLY`（目前就一条 `frame-ancestors 'none'`）—— 不把 `PROD_CSP` 整串塞进头里，
   * 否则头 + meta 两份策略会**取交集**，一旦漂移就成了谁都没写过的第三份策略。
   *
   * ⚠️ 两条覆盖要求（都靠 `tools/_verify-csp.js` 在真窗口里读响应头来守）：
   *   * **不分 dev/prod**：以前这里带着 `!is.dev` 的门 —— 开发态（`http://localhost:5173`）
   *     与打包态（`file://` 文档 + `lumin-file://` 图片）都要走到；
   *   * **不设 URL 过滤**：`onHeadersReceived` 不做 filter，主文档 / 子资源 / 自定义协议全过。
   *     （`file://` 是否真的经过 webRequest 是这套机制里最可疑的一环 —— 所以验收是"读响应头"，
   *     不是"看代码写了"。）
   */
  if (!cspHeaderInstalled) {
    cspHeaderInstalled = true
    /** 「自定义协议也走过头」只报一次（下面的日志用，见注释） */
    let loggedLuminFile = false
    electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // 先按**大小写无关**的方式摘掉原有的 `Content-Security-Policy`（HTTP 头名不分大小写，
      // 留一个原名再来一个规范名就等于给浏览器发**两条**策略 —— 那会取交集，正是要避免的事），
      // 再放我们这一条（只含 meta 里无效的那几条指令）。
      const responseHeaders: Record<string, string[]> = {}
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (name.toLowerCase() === 'content-security-policy') continue
        responseHeaders[name] = value
      }
      responseHeaders['Content-Security-Policy'] = [CSP_HEADER_ONLY]

      /**
       * 取证日志（**只在两种情况下各报一条**，不会刷屏）：
       *   * `mainFrame`：每个窗口的文档加载一次 —— 证明"响应头真的过到了文档请求上"；
       *   * 第一条 `lumin-file:`：打包态文档里的相对图片走的就是这个自定义协议，
       *     证明 URL 模式**两种 scheme 都覆盖**（用户点名要确认的那件事）。
       *
       * 为什么非得由主进程自己报：CDP 的 Network 域**看不到** `webRequest` 注入的头
       * （实测：handler 明明被调用、注入也确实生效，但 `Network.getResponseHeaders` 是空的），
       * 所以"注入有没有发生"只能用这行日志当证据（`tools/_verify-csp.js` 读它）。
       * ⚠️ 输出必须 ASCII：只打 `details.resourceType` 与 URL 的 **scheme**（路径可能含中文）。
       */
      const schemeOf = (url: string): string => {
        try {
          return new URL(url).protocol
        } catch {
          return 'unknown'
        }
      }
      if (details.resourceType === 'mainFrame') {
        console.log(
          `[csp] frame-ancestors header set for mainFrame scheme=${schemeOf(details.url)}`
        )
      } else if (!loggedLuminFile && details.url.startsWith('lumin-file:')) {
        loggedLuminFile = true
        console.log(
          `[csp] frame-ancestors header set for ${details.resourceType} scheme=${schemeOf(details.url)}`
        )
      }

      callback({ responseHeaders })
    })
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/** 启动耗时探针：仅在 LUMIN_STARTUP_LOG 打开时输出（渲染层对应 performance.mark('lumin:*')） */
const startupT0 = performance.now()
function startup(label: string): void {
  if (process.env['LUMIN_STARTUP_LOG']) {
    console.log(
      `[startup] ${label} t+${(performance.now() - startupT0).toFixed(0)}ms uptime=${(process.uptime() * 1000).toFixed(0)}ms`
    )
  }
}

app.whenReady().then(() => {
  startup('app-ready')
  startupMark('app-ready')
  // 历史版本 electron-store 数据一次性迁入 SQLite kv（kv 已有数据时跳过）
  const tMigrateLegacy = performance.now()
  migrateLegacyStores()
  // 数据库打开/迁移/schema 就绪：`[db] schema migration` 那行日志背后的实际耗时
  startup('db-ready')
  const openStats = db.openStats
  startupMark('db-ready', {
    // 只记耗时/条数/版本，不记库路径（userData 已在 environment 里脱敏）
    migrateLegacyMs: Math.round(performance.now() - tMigrateLegacy),
    dbOpenMs: Math.round(openStats.openMs),
    dbMigrationMs: Math.round(openStats.migrationMs),
    dbFtsReconcileMs: Math.round(openStats.ftsReconcileMs),
    dbMigrationsFrom: openStats.migrationsFrom,
    dbMigrationsTo: openStats.migrationsTo,
    dbMigrated: openStats.migrated,
    dbFtsMissing: openStats.ftsMissing,
    dbFtsOrphans: openStats.ftsOrphans,
    dbSizeMb: (() => {
      try {
        return Math.round((statSync(db.path).size / (1024 * 1024)) * 10) / 10
      } catch {
        return null
      }
    })()
  })
  // 拼写检查：把持久化的开关与语言落到 session。必须在建窗之前（首帧正文就要按它对）；
  // 语言清单只取 availableSpellCheckerLanguages，不写死（见 services/spellcheck.ts）。
  const tSpell = performance.now()
  spellcheck.initializeSpellcheck()
  startup('spellcheck-ready')
  startupMark('spellcheck-ready', { ms: Math.round(performance.now() - tSpell) })
  // 开发/测试专用：把 LUMIN_TRUSTED_PATHS 里的目录加进路径授权表（打包态忽略，见 pathGrants 的说明）
  const tGrants = performance.now()
  const trusted = pathGrants.grantTrustedPathsFromEnv(is.dev, process.env.LUMIN_TRUSTED_PATHS)
  if (trusted) console.log(`[grants] trusted paths from env: ${trusted}`)
  startup('grants-ready')
  startupMark('grants-ready', {
    ms: Math.round(performance.now() - tGrants),
    // 只记授权目录**数量**，不记路径
    trustedDirs: trusted
  })
  // 草稿目录的垃圾回收（审计 §2 P1：`userData/drafts` 只增不减）：
  // 清掉写盘临时文件残留与"有磁盘正本、且 30 天没动过"的 file-* 草稿。
  // 不 await：它只碰我们自己的草稿目录，不该拖慢首屏；失败也不影响启动。
  void gcDrafts().catch(() => {})
  // 顺序要点：IPC 必须在任何窗口加载之前注册（渲染层启动就会发 IPC）；
  // 原生菜单不影响首屏，放到窗口创建之后再装。
  // 注入「窗口 ↔ 槽位」归属：草稿认领要看「还有哪些窗口活着」，那份状态只有这里持有。
  const tIpc = performance.now()
  registerIpc({
    slotOf: (windowId) => slotOfWindow.get(windowId) ?? null,
    liveSlots: () => [...new Set(slotOfWindow.values())],
    // 计划内的槽位（含还没建出来的窗口）：草稿归属判据，见 SlotRegistry.plannedSlots
    plannedSlots: () => session.claimedSlots(),
    // 恢复出来的槽位 vs 新开的槽位：同一个槽位号里那份"写它的窗口已不在"的草稿
    // 到底是"我上次没保存的"还是"上一个住户的"，靠这个信号区分
    slotRestored: (slot) => session.isRestoredSlot(slot),
    uidOf: (windowId) => uidOfWindow.get(windowId) ?? null,
    liveUids: () => [...new Set(uidOfWindow.values())],
    mayClaimUntitledDraft: (windowId) => windowId === startupWindowId
  })
  startup('ipc-registered')
  startupMark('ipc-registered', { ms: Math.round(performance.now() - tIpc) })

  /**
   * 启动诊断上报：渲染层在「壳出帧 / 路由就绪 / 首屏可交互」时发来一条。
   * 只收 stage 名与数字 marks（见 shared/startupLog 的清洗），不接受任何文本。
   */
  ipcMain.on('startup:report', (_event, payload) => recordRendererStartup(payload))

  // 多窗口：新建空白窗口 / 在新窗口打开文件 / 在新窗口打开文件夹（IPC 由渲染进程驱动）。
  // 三者都领一个新槽位，这样用户新开的窗口也会被会话记录到。
  // 「新建窗口」是干净窗口：带 --lumin-no-workspace，不继承当前工作区（详见 WindowOpenOptions）。
  ipcMain.on('app:newWindow', () => {
    createWindow({ sessionSlot: claimFreshSlot(), noWorkspace: true })
  })
  ipcMain.on('app:openInNewWindow', (_event, path: string) => {
    if (!path) return
    /**
     * 去重（审计 §2 P1：同一个文件被两个窗口打开并各自保存）：
     * 常规打开路径一直有这道闸（`window:focusByDoc` / `openFile.ts`），但"在新窗口打开"
     * 这里以前直接建窗 —— 侧栏右键与文档内链接都走它。两个窗口各持一份缓冲区、
     * 各自保存，正文可能互相覆盖（现在还有外部改动检测兜底，但那是"报冲突"，
     * 不如一开始就不让它发生）。命中已开窗口就把那个窗口唤到前面，并给它一张提示。
     */
    const existing = openDocs.findWindowWithDoc(path)
    if (existing) {
      openDocs.focusWindow(existing)
      const slot = slotOfWindow.get(existing.id) ?? null
      db.addNotification(slot === null ? '' : scopeOfSlot(slot), {
        level: 'info',
        title: mainT('open.alreadyOpenTitle'),
        body: mainT('open.alreadyOpenBody', { name: path.split(/[\\/]/).pop() ?? path }),
        mergeKey: `open-already:${path}`
      })
      return
    }
    createWindow({ openFile: path, sessionSlot: claimFreshSlot() })
  })
  ipcMain.on('app:openFolderInNewWindow', (_event, path: string) => {
    if (path) createWindow({ openFolder: path, sessionSlot: claimFreshSlot() })
  })

  /**
   * ─── 本地媒体协议 `lumin-file://` ────────────────────────────────────────────
   * 用途：Markdown 里的**相对路径图片**（`![](img/a.png)`）由渲染层解析成
   * `lumin-file:///<绝对路径>` 后走这里加载（见 renderer/lib/imageSrc.ts）。
   *
   * 为什么要校验：这个协议等价于「把本地文件读给渲染层」，而渲染层渲染的是**用户文档**。
   * 一旦文档内容能影响 URL，不加限制就等于开放任意文件读取。两道闸：
   *  1. **媒体扩展名白名单** —— 它只该送图片/音视频/PDF，永远不该送 `.txt/.json/.db/.env`；
   *  2. **位置白名单** —— 必须落在「当前工作区」或「某个已打开文档所在目录」之内
   *     （相对图片本来就只可能在这两处；`..` 逃出工作区的一律 404）。
   */
  protocol.handle('lumin-file', (request) => {
    try {
      const url = new URL(request.url)
      const decoded = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const p = resolve(decoded)
      if (!isServableMedia(p)) {
        // 主进程 console 输出一律 ASCII：Windows 控制台按代码页解读字节（中文系统 936/GBK），
        // 写中文只会得到乱码（详见 singleInstance.ts 的说明）。
        console.warn(`[protocol] refused lumin-file request: ${p}`)
        return new Response('Not Found', { status: 404 })
      }
      return net.fetch(pathToFileURL(p).href)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  const theme = db.kvGet('settings', defaultSettings).theme
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme === 'sepia' ? 'light' : theme

  /**
   * ─── 浏览器级快捷键：**显式列举**，不再整包交给 `optimizer.watchWindowShortcuts` ──────
   *
   * 口径（用户原话，第四轮）：「取消 Electron/Chromium 自带但本项目不需要的功能」，
   * 点名「按 Ctrl+R 刷新页面」。**任何构建下（含开发态）都拦**，清单与逐条理由都在
   * `shared/shortcuts.ts`（纯函数 + 单测 `tests/shortcuts.test.mjs`）：
   *   * 刷新族 `Ctrl/Cmd+R`、`Ctrl+Shift+R`、`F5`、`Ctrl+F5` —— 这不是浏览器，刷新只会丢
   *     未保存内容；开发态也不再需要（`electron-vite dev --watch` 改文件会自动重建/重启）；
   *   * DevTools 族 `F12`、`Ctrl+Shift+I/J/C`、`Cmd+Alt+I/J/C` —— 改用顶部工具栏那一项
   *     （少一个键盘入口就少一条说不清的隐式路径）；
   *   * 查看源码 `Ctrl/Cmd+U`；整页缩放 `Ctrl/Cmd + = - 0`（另有两道鼠标闸，见下）；
   *   * `F7`（caret browsing）、`F11`（浏览器/系统全屏）。
   *
   * ⚠️ **拦 = 这个键在应用里彻底失效**：`before-input-event` 的 `preventDefault()` 会同时吃掉
   * 渲染层 keydown 与菜单加速键（Electron 文档原话：prevent the page keydown/keyup events
   * and the menu shortcuts）。所以 `blockedShortcut()` 里第一件事就是放行 `APP_OWNED_COMBOS`
   * （应用自己绑过的组合，含 `Mod+P` 打印、`Mod+Shift+F` 专注模式、`Mod+B/I`、`Mod+Z/Y`…）——
   * 那份清单是**应用赢**的兜底。新增拦截规则前先在那份清单里核对。
   *
   * 关于旧的 `optimizer.watchWindowShortcuts`：它在开发态用 F12 开/关 DevTools、打包态屏蔽
   * `Ctrl+R` 与 `Ctrl+Shift+I`（还漏了 macOS 的 `Cmd+Alt+I`），只能整包开关 ——
   * 「只去掉某几条」在那一层做不到，留在那里也永远说不清「还有没有别的隐式路径」。
   */
  app.on('browser-window-created', (_, window) => {
    const wc = window.webContents
    /**
     * ─── 整页缩放：两道闸 ────────────────────────────────────────────────────
     * 为什么：应用自己有**字号设置**（`settings.fontSize`），而 Chromium 的整页缩放是另一套
     * 东西 —— 它会把版式、度量、缓存的行宽一起放大/缩小，用户会以为"排版坏了"。
     *   * `setVisualZoomLevelLimits(1, 1)`：关掉**捏合/触控板**那类视觉缩放；
     *   * `zoom-changed`（Ctrl+滚轮）：先 `preventDefault()`，再把缩放**复位为 1**
     *     （只靠 preventDefault 在部分 Electron 版本上不够，复位是兜底）。
     * 键盘那三档（Ctrl+= / Ctrl+- / Ctrl+0）由下面的 `blockedShortcut` 拦。
     */
    void wc.setVisualZoomLevelLimits(1, 1)
    wc.on('zoom-changed', (event) => {
      event.preventDefault()
      if (!window.isDestroyed()) wc.setZoomFactor(1)
    })

    /**
     * 被拦过的键：**每个窗口**每个组合只记一次（`before-input-event` 每次按键都触发，
     * 不设闸的话按住 Ctrl+R 会把日志刷满）。这行日志是"键真的被拦下了"的取证点
     * （`tools/_verify-devtools.js` 读实例日志断言），所以必须是 ASCII。
     */
    const loggedBlocks = new Set<string>()
    wc.on('before-input-event', (event, input) => {
      // window 在被销毁的瞬间仍可能收到一次事件（`webContents` 已不可用）——先看 isDestroyed
      if (window.isDestroyed()) return
      const reason = blockedShortcut(input)
      if (!reason) return
      event.preventDefault()
      const combo = comboLabel(input)
      if (!loggedBlocks.has(combo)) {
        loggedBlocks.add(combo)
        console.log(`[shortcuts] blocked ${combo} (${reason})`)
      }
    })
  })

  // 开发态记录「这份构建是什么时候的」：主进程不热更新，排查错配时第一眼看它
  recordBuildStamp()
  // 同上：console 输出一律 ASCII（Windows 控制台代码页不接受 UTF-8 字节）
  if (devProfileDir) console.log(`[profile] isolated dev profile active: ${devProfileDir}`)

  // 任务栏跳转列表（右键图标）：一条「新建窗口」任务 + 一栏最近文档。
  // 顺序有讲究：先写「开始菜单快捷方式」——任务栏右键菜单第一项的名字与点击行为都来自它
  // （没有它时 Windows 退回进程路径，就显示成「Electron」并启动无参数的 electron.exe）。
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const intent = parseLaunchIntent(process.argv, { appPath, cwd })
  // 落一行日志：启动参数解析是「静默失败」重灾区（关联双击没反应之类），解出来的意图与被忽略的
  // 参数必须留证据，否则只能靠猜。见 services/buildStamp 的说明。
  recordLaunchIntent({ argv: process.argv, intent, ignored: intent.ignored, cwd, appPath })
  const tSettingsRead = performance.now()
  const startupSettings = db.kvGet('settings', defaultSettings)
  const startupRecentCount = Array.isArray(startupSettings.recentFiles)
    ? startupSettings.recentFiles.length
    : 0
  // 「recent 列表加载耗时」：设置整份从 kv 读出（含 recentFiles/recentFolders）的那一段。
  // 只记条数与耗时 —— 路径不进日志。
  startupMark('recent-list', {
    ms: Math.round(performance.now() - tSettingsRead),
    recentCount: startupRecentCount,
    recentFolderCount: Array.isArray(startupSettings.recentFolders)
      ? startupSettings.recentFolders.length
      : 0
  })
  const tJumpList = performance.now()
  taskbar.ensureShortcut()
  taskbar.refreshJumpList()
  startupMark('jump-list', {
    ms: Math.round(performance.now() - tJumpList),
    recentCount: startupRecentCount
  })

  // 会话恢复：按上次的窗口槽位重建窗口（每个槽位一个窗口，各自恢复文档/文件夹与位置）。
  // 「在新窗口打开文件/文件夹」创建的窗口带 --lumin-open(-folder)，优先级高于会话槽位；
  // 设置里关闭 restoreSession 时一律走单窗口（空白未命名缓冲区）。
  const wantRestore = startupSettings.restoreSession !== false
  // macOS：open-file 事件可能在 ready 之前到达（Finder 双击）。合并进本次启动的意图，
  // 这样首个窗口就直接打开它，而不是先开一个空窗口再补一个。Windows 走命令行裸路径，这段恒为空。
  if (pendingOpenPaths.length) {
    const merged = intentFromPaths(pendingOpenPaths.splice(0))
    intent.openFile ??= merged.openFile
    intent.openFolder ??= merged.openFolder
  }

  // 明确要求打开某篇文档 / 某个目录时（跳转列表的「最近打开」、双击文件、把文件夹拖给应用），
  // 意图很清楚：就打开它。此时不拉会话恢复（否则会先恢复一堆旧窗口再把目标插进去，观感很乱）；
  // 槽位数据仍留在 kv 里，下次正常启动照旧恢复。
  const explicitOpen = !!(intent.openFile || intent.openFolder)
  const plan = wantRestore && !explicitOpen ? session.planRestore() : []
  if (!wantRestore) session.resetSession()
  startupMark('session-plan', {
    wantRestore,
    explicitOpen,
    // 恢复的窗口/文档数（**只记数量**，路径不落盘）
    restoredWindows: plan.length,
    restoredDocs: plan.filter((w) => !!w.slot.path).length,
    restoredWithFolder: plan.filter((w) => !!w.slot.folder).length,
    workspaceTop: topLevelName(plan.find((w) => !!w.slot.folder)?.slot.folder ?? ''),
    restoreClosedSlot: plan.some((w) => !!w.slot.closed)
  })
  // 首个窗口先建（「最近使用过的窗口」优先，见 planRestore 的排序），
  // 其余窗口等它加载完首帧后再建 —— 避免 N 个渲染进程同时抢 CPU/磁盘把首屏拖慢。
  const [head, ...rest] = plan
  const first =
    head !== undefined
      ? createWindow({ sessionSlot: head.index })
      : createWindow({
          openFile: intent.openFile ?? undefined,
          openFolder: intent.openFolder ?? undefined,
          // 冷启动时 --lumin-no-workspace=1 同样要认（「新建窗口」那条快捷方式在应用没跑时就走这条路）
          noWorkspace: intent.noWorkspace || undefined,
          sessionSlot: claimFreshSlot()
        })
  startup('first-window-created')
  startupMark('first-window-created', {
    restored: head !== undefined,
    sessionSlot: head?.index ?? null
  })
  // 启动窗口 = 本次运行里唯一能认领「无主草稿」的窗口（见 main/drafts.ts：
  // Ctrl+N / 新建窗口是用户明确要一篇空白，不该被上一次没保存的内容打断）
  startupWindowId = first.id
  first.once('ready-to-show', () => {
    startup('first-window-painted')
    startupMark('first-window-painted')
  })
  let firstShown = false
  const openRemaining = (): void => {
    if (firstShown) return
    firstShown = true
    startup('first-window-loaded')
    startupMark('first-window-loaded')
    for (const { index } of rest) createWindow({ sessionSlot: index })
    if (rest.length) {
      startup('remaining-windows-created')
      startupMark('remaining-windows-created', { count: rest.length })
    }
  }
  // 首帧之后再建其余窗口：load 事件即「首屏内容已就绪」；兜底 1.5s，避免异常时窗口永远不建。
  first.webContents.once('did-finish-load', openRemaining)
  setTimeout(openRemaining, 1500)
  installMenu()
  /**
   * 自动更新：**首窗真正显示之后**再初始化（启动性能，实测见 services/updater.ts）。
   *
   * 两个理由：
   *  1. `import('electron-updater')` 实测 ≈52ms（模块图解析 + 求值），默认又不检查更新，
   *     这笔钱不该出现在首屏路径上；
   *  2. 更新检查会联网、会读 app-update.yml，放在窗口之后做，即使慢也只影响后台。
   *
   * 兜底 3s：`ready-to-show` 因异常没来（例如窗口被立刻关闭）时也要把监听装上，
   * 否则用户在设置里打开「自动检查更新」会看起来毫无反应。`initUpdater` 自己有幂等闸。
   */
  const initUpdaterDeferred = (): void => {
    startupMark('updater-init', { deferred: true })
    void initUpdater()
  }
  first.once('ready-to-show', () => setTimeout(initUpdaterDeferred, 0))
  setTimeout(initUpdaterDeferred, 3000)
  // 自动备份数据库（审计 §2 P1）：延迟 20 秒再跑第一次，之后每 6 小时看一次该不该备。
  // 同样放在窗口之后 —— 复制库文件、checkpoint WAL 都会占用主进程，不该压在首屏上。
  startAutoBackup()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ sessionSlot: claimFreshSlot() })
  })
})

/**
 * 聚焦已有窗口（没有任何打开要求时的兜底）。
 * 只判断 isMinimized 是不够的：窗口在应用处于后台时被最小化，Electron 可能报 false，
 * 只调 focus() 会得到「焦点给了它、但它还最小化着」的怪状态（见 services/openDocs.focusWindow 的说明），
 * 所以这里与它保持同一套口径。
 */
function focusExistingWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized() || !win.isVisible()) win.restore()
  win.focus()
}

/**
 * 把一次「打开请求」落到具体窗口。
 * 第二实例（任务栏跳转列表 / 双击文件 / 再点一次图标）与 macOS open-file 都走这里 ——
 * 同一套落点规则只留一份实现，尤其「一个文件只开一个窗口」不会被绕过。
 *
 * 顺序即优先级：
 *  ① 要新窗口 → 开新窗口（若同时带文件/目录就一并装进去，不丢参数）
 *  ② 打开文件 → 已在别的窗口开着就聚焦过去，否则新窗口打开
 *  ③ 打开目录 → 新窗口以它为工作区
 *  ④ 都没有 → 聚焦已有窗口
 */
function handleOpenRequest(intent: LaunchIntent): void {
  // 落点规则本身是纯函数（main/openRequest.ts，有单测）；这里只做"问一句 + 照做"。
  // 问一次就够：`existing` 既是"要不要聚焦"的输入，也是要聚焦的那个窗口（两次调用可能拿到不同对象）。
  const existing = intent.openFile ? openDocs.findWindowWithDoc(intent.openFile) : null
  const plan = planOpenRequest(intent, { docAlreadyOpen: existing !== null })
  switch (plan.kind) {
    case 'focus-doc':
      if (existing) openDocs.focusWindow(existing)
      return
    case 'focus-any':
      focusExistingWindow()
      return
    case 'new-window':
      createWindow({
        openFile: plan.openFile,
        openFolder: plan.openFolder,
        noWorkspace: plan.noWorkspace,
        sessionSlot: claimFreshSlot()
      })
      return
  }
}

/**
 * 把若干「已知是文件/目录的路径」包成一次打开请求。
 * 刻意复用同一套解析器（而不是另写一份判断）：先是文件还是目录、是否存在、要不要忽略，
 * 规则只有一处，避免「命令行能开、open-file 不能开」这种分裂。
 */
function intentFromPaths(paths: string[]): LaunchIntent {
  return parseLaunchIntent([process.execPath, ...paths], {
    appPath: app.getAppPath(),
    cwd: process.cwd()
  })
}

/**
 * macOS：Finder 里双击文件走这个事件（Windows 是命令行裸路径，不进这里）。
 * 成本极低，为将来留口 —— 而且与第二实例共用落点规则，不另写一份。
 */
const pendingOpenPaths: string[] = []
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!app.isReady()) {
    pendingOpenPaths.push(filePath)
    return
  }
  const intent = intentFromPaths([filePath])
  recordLaunchIntent({
    argv: [process.execPath, filePath],
    intent,
    ignored: intent.ignored,
    cwd: process.cwd(),
    appPath: app.getAppPath()
  })
  handleOpenRequest(intent)
})

app.on('second-instance', (_event, argv) => {
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const intent = parseLaunchIntent(argv, { appPath, cwd })
  // 与冷启动同样留证据：用户「双击了没反应」时，先看这行日志
  recordLaunchIntent({ argv, intent, ignored: intent.ignored, cwd, appPath })
  handleOpenRequest(intent)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
