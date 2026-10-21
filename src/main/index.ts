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
  session as electronSession,
  type Display
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
import {
  clampBoundsToWorkArea,
  computeDefaultBounds,
  displayStateKey,
  type Rect,
  type Size
} from './windowBounds'
import {
  attachWindowBoundsGuard,
  installWindowDebugHook,
  resyncWindowBounds
} from './windowBoundsGuard'
import { planOpenRequest } from './openRequest'
import { mainT } from './i18n'
import { registerIpc, attachCloseGuard } from './ipc'
import * as spellcheck from './services/spellcheck'
import * as freezeGuard from './services/freezeGuard'
import { isServableMedia } from './fileOps'
import * as links from './services/links'
import { migrateLegacyStores } from './store'
import { db, databaseReady, ensureDatabase } from './services/database'
import { readSettings, syncNativeTheme } from './services/appSettings'
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
import {
  drainAtomicWrites,
  markQuitDrained,
  pendingAtomicWrites,
  quitDrainComplete
} from './services/writeDrain'
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
/**
 * 「库就绪」入口在 whenReady 里赋值：模块级的第二实例 / open-file / activate 处理也要等它。
 * 为什么不在模块级直接 import ensureDatabase：这里需要的是**带历史迁移与打点**的那一个。
 */
let whenReadyEnsureDb: (() => Promise<void>) | null = null
/** 等库就绪（若 whenReady 还没跑到就立即继续 —— 此时也还没有窗口，走不到读库的分支） */
function readyForDb(): Promise<void> {
  return whenReadyEnsureDb ? whenReadyEnsureDb() : Promise.resolve()
}
app.on('before-quit', (event) => {
  session.markQuitting()
  beginShutdown('before-quit')
  // 退出前把排队的全文索引落盘（索引是节流的，见 services/database.ts 的 scheduleFtsIndex）。
  // ⚠️ 只在库**已经开过**时做：启动懒等待之后，用户完全可能在库还没打开时就退出
  // （秒开秒关），此时 `db.flushFtsIndex()` 会当场同步开库 —— 退出路径不该再付这笔钱。
  try {
    if (databaseReady()) db.flushFtsIndex()
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
  /**
   * ─── 退出**必须等在飞的原子写收尾**（用户报障：保存后残留 `<doc>.<8hex>.lumin-tmp`）──
   *
   * 现场：关窗确认点「保存」后，窗口销毁 → 进程退出，而另一次（重复注册导致的）保存在
   * 退出瞬间才发出 `file:write`：临时文件已经写出，`fsync/rename/finally 清理` 没来得及跑，
   * 于是 D 盘留下 `.lumin-tmp`，直到下次启动才被扫掉。
   *
   * 做法：`before-quit` 先 `preventDefault()`，等 `drainAtomicWrites()`（计数归零 + 安静
   * `QUIT_DRAIN_IDLE_MS`，最多 `QUIT_DRAIN_TIMEOUT_MS`）再 `app.quit()`。第二次进入时
   * `quitDrainComplete()` 为真，直接放行 —— 否则每次 `app.quit()` 都会被自己拦住，退不掉。
   *
   * 用户在关窗确认里点「取消」时，`main/ipc.ts` 的 `app:cancelClose` 会 `resetQuitDrain()`：
   * 那一轮退出作废，下一次必须重新排空。
   */
  if (quitDrainComplete()) return
  event.preventDefault()
  const pending = pendingAtomicWrites()
  if (pending > 0) console.log(`[quit] waiting for ${pending} in-flight write(s)`)
  void drainAtomicWrites().then((r) => {
    if (!r.ok) console.log(`[quit] drain timeout, ${r.pending} write(s) still pending`)
    markQuitDrained()
    app.quit()
  })
})

/**
 * `will-quit` 兜底：`before-quit` 放行之后仍可能有写冒出来（例如窗口 `closed` 瞬间
 * 到达的 IPC）。这里再拦一次，等它收尾后 `app.exit()` —— 已经没有任何窗口，直接退出即可。
 */
app.on('will-quit', (event) => {
  if (pendingAtomicWrites() === 0) return
  event.preventDefault()
  console.log(`[quit] will-quit drain, ${pendingAtomicWrites()} write(s) pending`)
  void drainAtomicWrites(2000).then(() => app.exit(0))
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

/**
 * 启动验收专用的「人为慢渲染」开关（`LUMIN_BOOT_DELAY_MS`，默认 0）。
 *
 * 只做一件事：把它经 additionalArguments 传给窗口，渲染层在 bootstrap 最前面 await 这么久。
 * 为什么需要它：真机上「JS 已经解析、但界面迟迟挂不上」才是骨架屏要扛的场景；本机太快，
 * 不人为放慢就量不到「慢渲染时会不会白屏」。产品路径上环境变量不存在 ⇒ 0，零开销。
 * 上限 30s，避免误配把窗口拖死。
 */
const bootDelayMs = (() => {
  const raw = Number(process.env['LUMIN_BOOT_DELAY_MS'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 30000) : 0
})()

/** 窗口位置/大小持久化（记住上次关闭时的位置与尺寸） */
interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

/** 最小窗口尺寸（与 windowPlacement.ts 同源，也给纯函数 clamp 用） */
const MIN_WINDOW_SIZE: Size = { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT }
/** kv 键：最近一次窗口（旧版本也读它；新版作为诊断/迁移源保留） */
const WINDOW_STATE_KV = 'windowState'
/** kv 键：按 `display.id@scaleFactor` 分屏保存的窗口记录 */
const WINDOW_STATE_BY_DISPLAY_KV = 'windowStateByDisplay'
/** kv 键：上次退出时窗口所在的显示器 id（启动时优先恢复到那块屏） */
const WINDOW_STATE_LAST_DISPLAY_KV = 'windowStateLastDisplay'
/** 最多记住几块屏的记录（换接口/改缩放会累积 key，不能让 kv 无限长） */
const MAX_REMEMBERED_DISPLAYS = 8

/** 分屏保存的一条记录：除 bounds 外还带显示器标识，避免把 A 屏尺寸套到 B 屏 */
interface DisplayWindowState extends WindowState {
  displayId: number
  scaleFactor: number
  savedAt: number
}

type WindowStateMap = Record<string, DisplayWindowState>

/**
 * 启动时该恢复到哪块显示器：优先上次退出时那块（还在的话），否则主屏。
 * 必须在数据库就绪之后调用（要读 kv）。
 */
function displayToRestore(): Display {
  const displays = screen.getAllDisplays()
  const lastId = db.kvGet<number | null>(WINDOW_STATE_LAST_DISPLAY_KV, null)
  return displays.find((d) => d.id === lastId) ?? screen.getPrimaryDisplay()
}

/**
 * 取某块显示器上保存的窗口记录。
 *
 * **按显示器 + 缩放**取（`display.id@scaleFactor`）：A 屏保存的尺寸绝不会套到 B 屏；
 * 同一块屏改了缩放（key 变了）就重新用默认尺寸，避免旧 DIP 尺寸在新缩放下显得忽大忽小。
 * `windowState` 是旧版本的单条记录：只在**还没有任何分屏记录**时迁移用，且必须仍与这块
 * 屏的工作区相交；一旦写过新表，就不再回头读它（否则拔掉副屏后旧记录会串到主屏）。
 */
function savedWindowStateFor(display: Display): WindowState | null {
  const map = db.kvGet<WindowStateMap>(WINDOW_STATE_BY_DISPLAY_KV, {})
  const entry = map[displayStateKey(display)]
  if (entry) {
    return {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      isMaximized: !!entry.isMaximized
    }
  }
  if (Object.keys(map).length === 0) {
    const legacy = db.kvGet<WindowState | null>(WINDOW_STATE_KV, null)
    if (legacy && canRestoreWindow(legacy, [display.workArea], MIN_WINDOW_SIZE)) return legacy
  }
  return null
}

/**
 * 首次建窗/启动 seed 的尺寸：有该屏的保存记录就**夹进当前工作区**再恢复，
 * 没有就按当前工作区算默认尺寸（居中、不越界）。
 */
function startupWindowBounds(): { bounds: Rect; isMaximized: boolean } {
  const display = displayToRestore()
  const saved = savedWindowStateFor(display)
  if (!saved) {
    return {
      bounds: computeDefaultBounds(display.workArea, { minSize: MIN_WINDOW_SIZE }),
      isMaximized: false
    }
  }
  return {
    bounds: clampBoundsToWorkArea(saved, display.workArea, MIN_WINDOW_SIZE),
    isMaximized: saved.isMaximized
  }
}

function saveWindowState(win: BrowserWindow): void {
  // 「最大化时存 normalBounds」这条规则抽在 windowPlacement.ts（有单测）：
  // 存 getBounds() 会把"被撑满的屏幕矩形"当成还原尺寸，下次先按大尺寸建窗再最大化，多一次跳变。
  const saved = windowStateFor({
    bounds: win.getBounds(),
    normalBounds: win.getNormalBounds(),
    isMaximized: win.isMaximized()
  }) satisfies WindowState
  // 写清这块窗口属于哪块屏 + 什么缩放：下次同样配置才按原尺寸恢复
  const display = screen.getDisplayMatching(saved)
  const map = db.kvGet<WindowStateMap>(WINDOW_STATE_BY_DISPLAY_KV, {})
  map[displayStateKey(display)] = {
    ...saved,
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    savedAt: Date.now()
  }
  const kept = Object.entries(map)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_REMEMBERED_DISPLAYS)
  db.kvSet(WINDOW_STATE_BY_DISPLAY_KV, Object.fromEntries(kept))
  db.kvSet(WINDOW_STATE_LAST_DISPLAY_KV, display.id)
  // 旧版本（以及 tools/_check-windowstate.js）仍读单条 key；保留写入，便于降级与排障
  db.kvSet(WINDOW_STATE_KV, saved)
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
  /**
   * 「启动窗口」：槽位**延迟分配**（窗口先出、库后开）。带它时：
   *   * 不读 kv 里的 windowState（库还没开）—— 位置/主题由 applyWindowSeed 在 show 前补；
   *   * 不写 `--lumin-session-slot`，改写 `--lumin-startup-head=1`，渲染层认领后才知道槽位
   *     （见 ipc.ts 的 `app:claimStartupSlot` 与 renderer lib/sessionSlot.ts）。
   */
  restoreHead?: boolean
  /**
   * 兜底显示窗口的时限（ms，仅首窗用）：慢盘上渲染层可能迟迟画不完，到点先把
   * 已上好背景色的空窗口显示出来 —— 「窗口先出」是用户可感知的第一指标。
   */
  earlyShowMs?: number
}

/**
 * 创建应用窗口。openFile / openFolder 通过 additionalArguments 告诉渲染进程
 * 启动后要打开什么（「在新窗口打开」与「最近文件夹」用）；sessionSlot 非空时该窗口
 * 参与会话恢复。首个窗口恢复上次的位置/大小，后续窗口基于最近窗口级联偏移。
 */
function createWindow(options: WindowOpenOptions = {}): BrowserWindow {
  const { openFile, openFolder, noWorkspace, sessionSlot, restoreHead, earlyShowMs } = options
  // 启动参数里带的文件 / 文件夹是**主进程自己解析出来的**，天然可信 → 登记为授权路径
  // （否则"双击一个工作区外的 .md"会在 file:read 的授权闸上被拦掉）
  pathGrants.grantStartup(openFile, openFolder)
  const existing = BrowserWindow.getAllWindows()
  const isFirst = existing.length === 0
  const windowUid = randomUUID()

  // 默认尺寸按当前显示器工作区自适应（小屏不越界、大屏不铺满、居中）。
  // 纯函数在 windowBounds.ts，有 tests/windowBounds.test.mjs 的模拟显示器表格钉住。
  let bounds: Rect = computeDefaultBounds(screen.getPrimaryDisplay().workArea, {
    minSize: MIN_WINDOW_SIZE
  })
  let restoreMaximized = false

  if (isFirst && !restoreHead) {
    // 启动窗口之外的「首窗」路径（第二实例/open-file/activate 抢在库就绪之前）：
    // 库没开就先用默认位置，绝不在这里同步开库（见 whenReady 的启动顺序说明）。
    if (databaseReady()) {
      const seed = startupWindowBounds()
      bounds = seed.bounds
      restoreMaximized = seed.isMaximized
    }
  } else if (!isFirst) {
    const ref = BrowserWindow.getFocusedWindow() ?? existing[existing.length - 1]
    if (ref) {
      const rb = ref.getBounds()
      // 级联位置也要夹进目标显示器：否则“在新窗口打开”可能把窗口推出屏幕
      const display = screen.getDisplayMatching(rb)
      bounds = clampBoundsToWorkArea(
        { x: rb.x + 28, y: rb.y + 28, width: rb.width, height: rb.height },
        display.workArea,
        MIN_WINDOW_SIZE
      )
    }
  }

  const mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    // 显式给 x/y：默认尺寸的居中由 computeDefaultBounds 算好（不依赖 Electron 的默认摆放）
    x: bounds.x,
    y: bounds.y,
    // 与 windowPlacement.ts 的常量同源（波次 2 从 940×600 降到 760×520：
    // 1366×768 @150% 缩放只有 911×512 可用，旧最小尺寸比屏幕还大）
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: false,
    // 启动窗口不读库（库还没开）：先用**出厂主题**的纸色，库就绪后 applyWindowSeed
    // 会在 show 之前把它换成持久化主题的纸色。其它窗口此时库已就绪，照旧读设置。
    backgroundColor:
      restoreHead || !databaseReady()
        ? paperForTheme(defaultSettings.theme, nativeTheme.shouldUseDarkColors)
        : themeBackground(),
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
        // 启动窗口的槽位是延迟分配的（见 WindowOpenOptions.restoreHead / lib/sessionSlot.ts）
        ...(restoreHead ? ['--lumin-startup-head=1'] : []),
        // 启动验收用的人为慢渲染（默认不传；见上面的 bootDelayMs）
        ...(bootDelayMs > 0 ? [`--lumin-boot-delay-ms=${bootDelayMs}`] : []),
        `--lumin-window-uid=${windowUid}`
      ]
    }
  })

  /**
   * 跨 DPI / 拔屏的 bounds 守卫（接线在 windowBoundsGuard.ts，纯规则在 windowBounds.ts）：
   * 监听 moved/resized（节流 120ms）与 display-metrics-changed，只有 scaleFactor 真的变了
   * 才用**拖动前的 DIP 尺寸**纠正，并把坐标夹进新工作区。防回环标志在守卫内部。
   */
  attachWindowBoundsGuard(mainWindow)
  if (!app.isPackaged && process.env['LUMIN_WINDOW_DEBUG'] === '1') installWindowDebugHook()

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
  // 窗口作用域：通知等「属于某个窗口」的数据按它隔离（见 services/windowScope）。
  // 启动窗口此时还没有槽位：先给一个随机作用域，认领槽位时再重新绑定（见 index.ts 的
  // claimStartupSlot）。这样「通知不可能串台」的底线在整个启动过程中都成立。
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

  /**
   * 显示窗口（只做一次）。
   *
   * 为什么除了 `ready-to-show` 还有一条 `timeout`：慢盘/杀软把渲染层拖慢时，
   * `ready-to-show` 可能几百毫秒都不来，而用户对「点了图标有没有反应」的容忍度很低。
   *
   * 兜底取 **600ms**（本轮从 150ms 上调，实测依据见启动报告）：
   *   * 150ms 会在页面**还没画出第一帧**时先把窗口亮出来 —— 用户看到的是纯纸色空窗，
   *     随后骨架才到（热启动实测：窗口 230ms、骨架首帧 345ms，白等了 115ms）；
   *   * 600ms 让正常机器走 `ready-to-show`（热启动 ~278ms），窗口一出现**骨架已经在上面**；
   *   * 真遇到 ready-to-show 迟迟不来（冷启动/杀软扫描），600ms 仍然会先把纸色窗口亮出来，
   *     绝不会回到「点了图标没反应」。两条路径的背景色都是纸色，不存在白屏。
   */
  let revealed = false
  let earlyShowTimer: NodeJS.Timeout | null = null
  const reveal = (reason: 'ready-to-show' | 'timeout'): void => {
    if (revealed || mainWindow.isDestroyed()) return
    revealed = true
    if (earlyShowTimer) {
      clearTimeout(earlyShowTimer)
      earlyShowTimer = null
    }
    mainWindow.show()
    startup('window-shown')
    startupMark('window-shown', { first: isFirst, reason })
  }
  mainWindow.on('ready-to-show', () => reveal('ready-to-show'))
  if (earlyShowMs && earlyShowMs > 0) {
    earlyShowTimer = setTimeout(() => reveal('timeout'), earlyShowMs)
  }
  mainWindow.on('closed', () => {
    if (earlyShowTimer) {
      clearTimeout(earlyShowTimer)
      earlyShowTimer = null
    }
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

  /**
   * 启动参数解析（纯字符串，不碰库）：越早越好 —— 首窗要按它决定打开哪篇文档/哪个目录。
   * 落一行日志也是「静默失败」重灾区（关联双击没反应之类）的唯一证据，见 services/buildStamp。
   */
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const intent = parseLaunchIntent(process.argv, { appPath, cwd })
  recordLaunchIntent({ argv: process.argv, intent, ignored: intent.ignored, cwd, appPath })
  startupMark('launch-intent')

  /**
   * ─── 启动顺序（本轮：窗口先出、库与跳转列表后置）──────────────────────────────
   *
   * 用户报障：Typora 打开 <1s，Lumin 5–6s；本机冷启 524ms —— 差距是机器相关的
   * （慢盘/漫游 profile/Defender/大工作区/库迁移）。旧顺序把**所有东西**都压在
   * 「建窗口」之前：开库 + electron-store 迁移（本机 ~58ms）→ 拼写检查 → IPC →
   * 读设置 → 跳转列表（写 .lnk，慢盘上可能是秒级）→ 会话恢复计划 → 才建窗口。
   *
   * 新顺序：
   *   ① 解析启动参数（纯字符串）→ **立刻建窗口**（位置/主题先用默认值，show 前补）；
   *   ② 窗口建好之后再并行开库（`ensureDatabase` 让到下一轮事件循环）：
   *      渲染层加载 JS/CSS 的同时，主进程把库打开、迁移、FTS 对账做完；
   *   ③ 库就绪后、窗口显示前：把持久化的**主题与窗口位置**补上（用户看不到跳变）；
   *   ④ 拼写检查 / 最近列表 / 跳转列表：**首屏可交互之后**的空闲时段（startup:report）；
   *   ⑤ 会话恢复计划：渲染层**认领槽位时**才算（`app:claimStartupSlot`），此时首屏已出；
   *   ⑥ 其余窗口仍在首窗加载完之后错峰创建。
   *
   * 依赖库的每一处（IPC handler、窗口槽位认领、首屏后任务）都 `await ensureDb()` ——
   * 库只会打开一次，且 UI 永远不会被同步开库卡住。
   */
  let dbReadyPromise: Promise<void> | null = null
  /** 唯一的「库就绪」入口：打开 + 历史 electron-store 迁移 + db-ready 打点 */
  const ensureDb = (): Promise<void> => {
    if (!dbReadyPromise) {
      dbReadyPromise = (async () => {
        const t = performance.now()
        startupMark('db-open-start', { deferred: true })
        await ensureDatabase()
        // 历史版本 electron-store 数据一次性迁入 SQLite kv（kv 已有数据时跳过）。
        // 必须早于任何设置读取：否则 readSettings 会先把默认值写进 kv，旧设置再也迁不进来。
        const tLegacy = performance.now()
        migrateLegacyStores()
        const legacyMs = Math.round(performance.now() - tLegacy)
        startup('db-ready')
        const openStats = db.openStats
        startupMark('db-ready', {
          // 只记耗时/条数/版本，不记库路径（userData 已在 environment 里脱敏）
          migrateLegacyMs: legacyMs,
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
        startupMark('db-open-end', {
          durationMs: Math.round(performance.now() - t),
          legacyMs
        })
      })()
    }
    return dbReadyPromise
  }
  // 模块级的「第二实例 / open-file / activate」也要能等到库就绪（见 readyForDb）
  whenReadyEnsureDb = ensureDb

  /** 把持久化的主题/窗口位置补到**还没显示**的窗口上（show 之前完成 ⇒ 用户看不到跳变） */
  const applyWindowSeed = (win: BrowserWindow): void => {
    const t = performance.now()
    startupMark('window-seed-start')
    try {
      if (win.isDestroyed()) return
      const settings = readSettings()
      syncNativeTheme(settings.theme)
      const visible = win.isVisible()
      if (!visible) win.setBackgroundColor(themeBackground())
      // 隐藏时预置尺寸：有保存记录就夹进当前工作区，没有就按当前屏算默认（居中、不越界）。
      // 同样在 show 之前完成，用户看不到跳变。
      const seed = visible ? null : startupWindowBounds()
      if (seed) {
        win.setBounds(seed.bounds, false)
        if (seed.isMaximized) win.maximize()
        // 这次是程序化移动：重置跨屏守卫的基线，避免被误判成“跨 DPI 拖动”
        resyncWindowBounds(win)
      }
      startupMark('window-seed-end', {
        applied: !!seed,
        alreadyVisible: visible,
        maximized: !!seed?.isMaximized,
        durationMs: Math.round(performance.now() - t)
      })
    } catch (err) {
      startupMark('window-seed-end', {
        applied: false,
        error: err instanceof Error ? err.name : 'unknown',
        durationMs: Math.round(performance.now() - t)
      })
    }
  }

  /**
   * 会话恢复计划（延迟计算）：渲染层认领槽位时 / 首窗加载完时才算。
   * 「在新窗口打开文件/文件夹」的意图优先于会话槽位；设置里关了 restoreSession 时一律单窗口。
   */
  let planPromise: Promise<ReturnType<typeof session.planRestore>> | null = null
  const ensureRestorePlan = (): Promise<ReturnType<typeof session.planRestore>> => {
    if (!planPromise) {
      planPromise = (async () => {
        await ensureDb()
        startupMark('session-plan-start')
        const t = performance.now()
        const settings = readSettings()
        const wantRestore = settings.restoreSession !== false
        // macOS：open-file 可能在 ready 之前到达（Finder 双击）。合并进本次启动的意图，
        // 这样首个窗口就直接打开它，而不是先开一个空窗口再补一个。
        if (pendingOpenPaths.length) {
          const merged = intentFromPaths(pendingOpenPaths.splice(0))
          intent.openFile ??= merged.openFile
          intent.openFolder ??= merged.openFolder
        }
        // 明确要求打开某篇文档 / 某个目录时（跳转列表的「最近打开」、双击文件、拖文件夹给应用），
        // 意图很清楚：就打开它。此时不拉会话恢复；槽位数据仍留在 kv 里，下次正常启动照旧恢复。
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
          restoreClosedSlot: plan.some((w) => !!w.slot.closed),
          deferred: true
        })
        startupMark('session-plan-end', {
          windows: plan.length,
          durationMs: Math.round(performance.now() - t)
        })
        return plan
      })()
    }
    return planPromise
  }

  /** 启动窗口（本次运行唯一能认领「无主草稿」的窗口）：首窗，槽位延迟分配 */
  let startupWin: BrowserWindow | null = null
  let startupSlot: number | null = null
  let startupSlotClaimed = false
  const claimStartupSlot = async (windowId: number): Promise<number | null> => {
    if (!startupWin || startupWin.isDestroyed() || windowId !== startupWin.id) return null
    if (startupSlotClaimed) return startupSlot
    const plan = await ensureRestorePlan()
    // 恢复计划的第一项就是「最近用过的那个窗口」（见 services/session 的排序）
    const slot = plan[0]?.index ?? claimFreshSlot()
    startupSlot = slot
    startupSlotClaimed = true
    slotOfWindow.set(windowId, slot)
    startupWin.on('closed', () => {
      slotOfWindow.delete(windowId)
      if (!session.isQuitting()) {
        session.markSlotClosed(slot)
        db.deleteNotificationsByScope(scopeOfSlot(slot))
      }
    })
    // 认领后重绑窗口作用域：认领前用的是随机作用域（启动期间的通知不会串台）
    bindWindowScope(startupWin, slot)
    startupMark('startup-slot-claimed', { slot, restored: plan.length > 0 })
    return slot
  }

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
  // IPC 必须在任何窗口加载之前注册（渲染层启动就会发 IPC）；每个 handler 注册期都套了
  // 「先等库就绪」的包装（见 ipc.ts 的 registerIpc）。
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
    mayClaimUntitledDraft: (windowId) => windowId === startupWindowId,
    ensureDb,
    claimStartupSlot
  })
  startup('ipc-registered')
  startupMark('ipc-registered', { ms: Math.round(performance.now() - tIpc) })

  /**
   * 启动诊断上报：渲染层在「壳出帧 / 路由就绪 / 首屏可交互」时发来一条。
   * 只收 stage 名与数字 marks（见 shared/startupLog 的清洗），不接受任何文本。
   * **首屏可交互之后**才跑拼写检查/最近列表/跳转列表 —— 这些都不该压首屏。
   */
  /**
   * 自动更新：**首屏可交互之后**再初始化（启动性能，实测见 services/updater.ts）。
   *
   * 两个理由：
   *  1. `import('electron-updater')` 实测 ≈52ms（模块图解析 + 求值），默认又不检查更新，
   *     这笔钱不该出现在首屏路径上；
   *  2. 更新检查会联网、会读 app-update.yml，放在窗口之后做，即使慢也只影响后台。
   *
   * 由 runPostShowTasks 触发；3s 兜底保证渲染层没上报时也会初始化（`initUpdater` 自己幂等）。
   */
  const initUpdaterDeferred = (): void => {
    startupMark('updater-init', { deferred: true })
    void initUpdater()
  }

  let postShowTasksStarted = false
  const runPostShowTasks = (): void => {
    if (postShowTasksStarted) return
    postShowTasksStarted = true
    setTimeout(() => {
      void (async () => {
        try {
          await ensureDb()
          // 原生菜单：它读语言设置（库），且菜单栏默认隐藏 —— 首屏画完再装。
          const tMenu = performance.now()
          startupMark('menu-start')
          installMenu()
          startupMark('menu-installed', { ms: Math.round(performance.now() - tMenu) })
          startupMark('menu-end', { durationMs: Math.round(performance.now() - tMenu) })
          // 拼写检查：把持久化的开关与语言落到 session（首屏已经画出来了，不再赶时间）
          const tSpell = performance.now()
          startupMark('spellcheck-start')
          spellcheck.initializeSpellcheck()
          startup('spellcheck-ready')
          startupMark('spellcheck-ready', { ms: Math.round(performance.now() - tSpell) })
          startupMark('spellcheck-end', { durationMs: Math.round(performance.now() - tSpell) })
          // 最近列表（设置整份从 kv 读出，含 recentFiles/recentFolders）：只记条数与耗时
          const tRecent = performance.now()
          startupMark('recent-list-start')
          const startupSettings = readSettings()
          const recentCount = Array.isArray(startupSettings.recentFiles)
            ? startupSettings.recentFiles.length
            : 0
          startupMark('recent-list', {
            ms: Math.round(performance.now() - tRecent),
            recentCount,
            recentFolderCount: Array.isArray(startupSettings.recentFolders)
              ? startupSettings.recentFolders.length
              : 0
          })
          startupMark('recent-list-end', { durationMs: Math.round(performance.now() - tRecent) })
          // 跳转列表（右键任务栏图标）：写开始菜单快捷方式 + 任务列表 —— 慢盘上是秒级开销
          const tJumpList = performance.now()
          startupMark('jump-list-start')
          taskbar.ensureShortcut()
          taskbar.refreshJumpList()
          startupMark('jump-list', {
            ms: Math.round(performance.now() - tJumpList),
            recentCount
          })
          startupMark('jump-list-end', { durationMs: Math.round(performance.now() - tJumpList) })
          // 自动更新：与上面同一时机（见 initUpdaterDeferred 的说明）
          initUpdaterDeferred()
        } catch (err) {
          // 非关键工作失败不该影响应用：留一行证据（只记错误名，不记路径/正文）
          startupMark('post-show-tasks-failed', {
            error: err instanceof Error ? err.name : 'unknown'
          })
        }
      })()
    }, 0)
  }
  ipcMain.on('startup:report', (_event, payload) => {
    recordRendererStartup(payload)
    const stage = (payload as { stage?: unknown } | null)?.stage
    if (stage === 'first-interactive') runPostShowTasks()
  })

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

  // 主题（原生标题栏/`prefers-color-scheme`）不在这里读库：启动窗口建出来之后由
  // applyWindowSeed 在 show 之前补上（见 whenReady 的启动顺序说明）。

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

  /**
   * ─── 第一个窗口：**立刻建**（不读库）────────────────────────────────────────
   *
   * 槽位延迟分配（restoreHead）：位置/主题在库就绪后、show 之前由 applyWindowSeed 补上；
   * `earlyShowMs: 600` 是慢盘兜底 —— 正常走 ready-to-show（骨架已在画面上），
   * 到点仍未绘制则先把已上好纸色背景的窗口显示出来。
   */
  if (bootDelayMs > 0) startupMark('boot-delay', { ms: bootDelayMs })
  const tWindow = performance.now()
  startupMark('first-window-create-start')
  const first = createWindow({
    openFile: intent.openFile ?? undefined,
    openFolder: intent.openFolder ?? undefined,
    // 冷启动时 --lumin-no-workspace=1 同样要认（「新建窗口」那条快捷方式在应用没跑时就走这条路）
    noWorkspace: intent.noWorkspace || undefined,
    restoreHead: true,
    earlyShowMs: 600
  })
  // 启动窗口 = 本次运行里唯一能认领「无主草稿」的窗口（见 main/drafts.ts：
  // Ctrl+N / 新建窗口是用户明确要一篇空白，不该被上一次没保存的内容打断）
  startupWindowId = first.id
  startupWin = first
  startup('first-window-created')
  startupMark('first-window-created', {
    deferredSlot: true,
    durationMs: Math.round(performance.now() - tWindow)
  })
  startupMark('first-window-create-end', { durationMs: Math.round(performance.now() - tWindow) })

  /**
   * 窗口已建好：从这里开始**并行开库**（不 await，渲染层同时加载自己的 JS/CSS）。
   * 库就绪后按顺序补窗口外观、装原生菜单 —— 通常都发生在 show 之前。
   */
  void (async () => {
    try {
      await ensureDb()
      applyWindowSeed(first)
    } catch (err) {
      startupMark('startup-db-failed', { error: err instanceof Error ? err.name : 'unknown' })
    }
  })()

  first.once('ready-to-show', () => {
    startup('first-window-painted')
    startupMark('first-window-painted')
  })

  /**
   * 其余窗口：等首窗加载完再错峰建（避免 N 个渲染进程同时抢 CPU/磁盘把首屏拖慢）。
   * 会话恢复计划也在这里才计算（或更早，于渲染层认领槽位时）—— 不再压在建首窗之前。
   */
  let remainingOpened = false
  const openRemaining = (): void => {
    if (remainingOpened) return
    remainingOpened = true
    startup('first-window-loaded')
    startupMark('first-window-loaded')
    void ensureRestorePlan()
      .then((plan) => {
        const rest = plan.slice(1)
        for (const { index } of rest) createWindow({ sessionSlot: index })
        if (rest.length) {
          startup('remaining-windows-created')
          startupMark('remaining-windows-created', { count: rest.length })
        }
      })
      .catch(() => {
        /* 恢复计划失败时只保留首窗：用户仍能正常使用 */
      })
  }
  // 首帧之后再建其余窗口：load 事件即「首屏内容已就绪」；兜底 2.5s，避免异常时窗口永远不建。
  first.webContents.once('did-finish-load', openRemaining)
  setTimeout(openRemaining, 2500)
  // 首屏可交互之后才做拼写检查/最近列表/跳转列表（渲染层在 doc-visible 时上报
  // `first-interactive`，由上面的 startup:report 处理器触发）。
  // 兜底 5s：渲染层没上报（例如崩溃/白屏）时也要把非关键工作做完 —— 但不能更早，
  // 跳转列表写 .lnk 在本机要 ~50ms，压在渲染层的 IPC 上会把首屏可交互往后推。
  setTimeout(runPostShowTasks, 5000)

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
  /**
   * 自动更新：由 runPostShowTasks 在首屏可交互之后触发（见上面的定义）。
   * 3s 兜底：渲染层没上报（崩溃/白屏）时也要把监听装上，否则用户在设置里打开
   * 「自动检查更新」会看起来毫无反应。`initUpdater` 自己有幂等闸。
   */
  setTimeout(initUpdaterDeferred, 3000)
  // 自动备份数据库（审计 §2 P1）：延迟 20 秒再跑第一次，之后每 6 小时看一次该不该备。
  // 同样放在窗口之后 —— 复制库文件、checkpoint WAL 都会占用主进程，不该压在首屏上。
  startAutoBackup()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      void readyForDb().then(() => createWindow({ sessionSlot: claimFreshSlot() }))
    }
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
  // 落点要等库就绪：新窗口会读 kv（槽位/窗口位置），不能在这里同步开库
  void readyForDb().then(() => handleOpenRequest(intent))
})

app.on('second-instance', (_event, argv) => {
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const intent = parseLaunchIntent(argv, { appPath, cwd })
  // 与冷启动同样留证据：用户「双击了没反应」时，先看这行日志
  recordLaunchIntent({ argv, intent, ignored: intent.ignored, cwd, appPath })
  void readyForDb().then(() => handleOpenRequest(intent))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
