// 必须在任何会（传递）导入 node:sqlite 的模块之前加载，以屏蔽其实验性警告
import './devProfile'
import './suppressWarnings'
import { app, shell, BrowserWindow, nativeTheme, protocol, net, ipcMain, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { optimizer, is } from '@electron-toolkit/utils'
// 窗口图标与任务栏/开始菜单快捷方式/跳转列表**共用同一个文件**（resources/icon.ico，内含 16~256 七档，
// Windows 会按场景挑最合适的尺寸）；不要在这里另引 PNG，否则同一应用会出现两种图标。
import appIconPng from '../../resources/icon.png?asset'
import { installMenu } from './menu'
import { registerIpc, attachCloseGuard } from './ipc'
import { migrateLegacyStores } from './store'
import { db } from './services/database'
import * as session from './services/session'
import * as openDocs from './services/openDocs'
import * as taskbar from './services/taskbar'
import { recordBuildStamp, recordLaunchIntent } from './services/buildStamp'
import { devProfileDir } from './devProfile'
import { parseLaunchIntent, type LaunchIntent } from './services/launchIntent'
import { initUpdater } from './services/updater'
import { bindWindowScope, scopeOfSlot } from './services/windowScope'
import { defaultSettings } from '../shared/defaults'
import { markRunning, markClean } from './drafts'

// 本地文件协议（用于 Markdown 内相对路径图片，兼容 dev/prod 与 CSP）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumin-file',
    privileges: { secure: true, supportFetchAPI: true, stream: true }
  }
])

// 应用名 / 应用标识（AppUserModelID）
app.setName('Lumin')
// 不用 electronApp.setAppUserModelId()：它在开发态会把标识设成 process.execPath，
// 于是 Windows 把窗口当成 electron.exe（右键菜单第一项显示「Electron」，点它启动无参数的
// electron.exe）。标识必须由我们自己的 appId() 给，并且配套写一条开始菜单快捷方式，详见
// services/taskbar 的文件头说明。
app.setAppUserModelId(taskbar.appId())

// 可选：通过环境变量开启远程调试端口（用于自动化验证）
if (process.env.LUMIN_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.LUMIN_DEBUG_PORT)
}

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// ─── 会话恢复：窗口 ↔ 槽位 归属（「整体退出 vs 单独关窗」的判定在 services/session）──
/** window.id → 会话槽位 */
const slotOfWindow = new Map<number, number>()
app.on('before-quit', () => session.markQuitting())

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

// 主题背景色（避免启动闪白）
function themeBackground(): string {
  const theme = db.kvGet('settings', defaultSettings).theme
  if (theme === 'dark') return '#111318'
  if (theme === 'sepia') return '#f4ecd8'
  if (theme === 'auto') return nativeTheme.shouldUseDarkColors ? '#111318' : '#f7f7f8'
  return '#f7f7f8'
}

/** 窗口位置/大小持久化（记住上次关闭时的位置与尺寸） */
interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

/** 校验保存的窗口位置是否仍落在某个显示器工作区内（防止显示器配置变化后窗口跑到屏幕外） */
function validWindowBounds(s: WindowState): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y
  })
}

function saveWindowState(win: BrowserWindow): void {
  const isMaximized = win.isMaximized()
  const b = isMaximized ? win.getNormalBounds() : win.getBounds()
  db.kvSet('windowState', {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    isMaximized
  } satisfies WindowState)
}

// 生产环境 CSP 只注册一次（session 为所有窗口共享，避免重复监听）
let cspInstalled = false

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
  const existing = BrowserWindow.getAllWindows()
  const isFirst = existing.length === 0

  let x: number | undefined
  let y: number | undefined
  let width = 1320
  let height = 860
  let restoreMaximized = false

  if (isFirst) {
    const state = db.kvGet<WindowState | null>('windowState', null)
    if (state && state.width >= 940 && state.height >= 600 && validWindowBounds(state)) {
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
    minWidth: 940,
    minHeight: 600,
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
      ...(openFile || openFolder || noWorkspace || sessionSlot !== undefined
        ? {
            additionalArguments: [
              ...(openFile ? [`--lumin-open=${encodeURIComponent(openFile)}`] : []),
              ...(openFolder ? [`--lumin-open-folder=${encodeURIComponent(openFolder)}`] : []),
              ...(noWorkspace ? ['--lumin-no-workspace=1'] : []),
              ...(sessionSlot !== undefined ? [`--lumin-session-slot=${sessionSlot}`] : [])
            ]
          }
        : {})
    }
  })

  // 会话槽位归属：窗口被「单独关闭」（非整体退出）时清空它的槽位，
  // 这样下次启动不会把一个用户已经关掉的窗口又拉回来。
  // 同一时刻它的窗口作用域（通知等窗口私有数据）也随窗口一起销毁；
  // 整体退出时保留，让下次启动的会话恢复到「同一个窗口」里。
  if (sessionSlot !== undefined) {
    slotOfWindow.set(mainWindow.id, sessionSlot)
    mainWindow.on('closed', () => {
      slotOfWindow.delete(mainWindow.id)
      if (!session.isQuitting()) {
        session.clearSessionSlot(sessionSlot)
        db.deleteNotificationsByScope(scopeOfSlot(sessionSlot))
      }
    })
  }
  // 窗口作用域：通知等「属于某个窗口」的数据按它隔离（见 services/windowScope）
  bindWindowScope(mainWindow, sessionSlot)
  // 「哪个窗口开着哪个文档」注册表：窗口关闭即清账，不留已销毁窗口的条目
  mainWindow.on('closed', () => openDocs.forgetWindow(mainWindow.id))

  if (restoreMaximized) mainWindow.maximize()

  // 隐藏系统原生菜单条：顶部菜单栏由渲染层 TopMenuBar 呈现（位置精确、
  // Alt+F/E/V/H 确定性）；应用菜单仍安装，Ctrl+N/O/S 等加速键继续生效。
  // autoHideMenuBar=false：彻底禁用「按 Alt 唤出原生菜单条」的行为（true 会
  // 让菜单条在按 Alt 时重新弹出）
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(false)

  // 关闭时记住当前窗口位置/大小（下次启动恢复）
  mainWindow.on('close', () => saveWindowState(mainWindow))

  attachCloseGuard(mainWindow)

  // 开发环境：转发渲染进程控制台日志，便于排查（Electron 39 新签名：单个 Event 对象）
  if (is.dev) {
    mainWindow.webContents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning') {
        console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
      }
    })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 生产环境强化 CSP（仅首次注册）
  if (!is.dev && !cspInstalled) {
    cspInstalled = true
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: file:; font-src 'self' data:; connect-src 'self'"
          ]
        }
      })
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
  // 历史版本 electron-store 数据一次性迁入 SQLite kv（kv 已有数据时跳过）
  migrateLegacyStores()
  // 顺序要点：IPC 必须在任何窗口加载之前注册（渲染层启动就会发 IPC）；
  // 原生菜单不影响首屏，放到窗口创建之后再装。
  registerIpc()
  startup('ipc-registered')

  // 多窗口：新建空白窗口 / 在新窗口打开文件 / 在新窗口打开文件夹（IPC 由渲染进程驱动）。
  // 三者都领一个新槽位，这样用户新开的窗口也会被会话记录到。
  // 「新建窗口」是干净窗口：带 --lumin-no-workspace，不继承当前工作区（详见 WindowOpenOptions）。
  ipcMain.on('app:newWindow', () => {
    createWindow({ sessionSlot: claimFreshSlot(), noWorkspace: true })
  })
  ipcMain.on('app:openInNewWindow', (_event, path: string) => {
    if (path) createWindow({ openFile: path, sessionSlot: claimFreshSlot() })
  })
  ipcMain.on('app:openFolderInNewWindow', (_event, path: string) => {
    if (path) createWindow({ openFolder: path, sessionSlot: claimFreshSlot() })
  })

  // 本地文件协议处理器
  protocol.handle('lumin-file', (request) => {
    try {
      const url = new URL(request.url)
      const p = decodeURIComponent(url.pathname.replace(/^\//, ''))
      return net.fetch(pathToFileURL(p).href)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  const theme = db.kvGet('settings', defaultSettings).theme
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme === 'sepia' ? 'light' : theme

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  markRunning()
  // 开发态记录「这份构建是什么时候的」：主进程不热更新，排查错配时第一眼看它
  recordBuildStamp()
  if (devProfileDir) console.log(`[profile] 开发态隔离 profile 生效: ${devProfileDir}`)

  // 任务栏跳转列表（右键图标）：一条「新建窗口」任务 + 一栏最近文档。
  // 顺序有讲究：先写「开始菜单快捷方式」——任务栏右键菜单第一项的名字与点击行为都来自它
  // （没有它时 Windows 退回进程路径，就显示成「Electron」并启动无参数的 electron.exe）。
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  const intent = parseLaunchIntent(process.argv, { appPath, cwd })
  // 落一行日志：启动参数解析是「静默失败」重灾区（关联双击没反应之类），解出来的意图与被忽略的
  // 参数必须留证据，否则只能靠猜。见 services/buildStamp 的说明。
  recordLaunchIntent({ argv: process.argv, intent, ignored: intent.ignored, cwd, appPath })
  taskbar.ensureShortcut()
  taskbar.refreshJumpList()

  // 会话恢复：按上次的窗口槽位重建窗口（每个槽位一个窗口，各自恢复文档/文件夹与位置）。
  // 「在新窗口打开文件/文件夹」创建的窗口带 --lumin-open(-folder)，优先级高于会话槽位；
  // 设置里关闭 restoreSession 时一律走单窗口（空白未命名缓冲区）。
  const wantRestore = db.kvGet('settings', defaultSettings).restoreSession !== false
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
  first.once('ready-to-show', () => startup('first-window-painted'))
  let firstShown = false
  const openRemaining = (): void => {
    if (firstShown) return
    firstShown = true
    startup('first-window-loaded')
    for (const { index } of rest) createWindow({ sessionSlot: index })
    if (rest.length) startup('remaining-windows-created')
  }
  // 首帧之后再建其余窗口：load 事件即「首屏内容已就绪」；兜底 1.5s，避免异常时窗口永远不建。
  first.webContents.once('did-finish-load', openRemaining)
  setTimeout(openRemaining, 1500)
  installMenu()
  // 自动更新：默认不检查（设置里关着、或 publish 还是占位地址时都不会联网）。
  // 放在窗口创建之后：更新检查再重要也不该跟首屏抢时间。
  initUpdater()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow({ sessionSlot: claimFreshSlot() })
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
  if (intent.newWindow) {
    createWindow({
      openFile: intent.openFile ?? undefined,
      openFolder: intent.openFolder ?? undefined,
      // 只有「纯新窗口」才是干净窗口（不继承当前工作区）；带了目标就按目标的落点规则走
      noWorkspace: !intent.openFile && !intent.openFolder,
      sessionSlot: claimFreshSlot()
    })
    return
  }
  if (intent.openFile) {
    const existing = openDocs.findWindowWithDoc(intent.openFile)
    if (existing) {
      openDocs.focusWindow(existing)
      return
    }
    createWindow({ openFile: intent.openFile, sessionSlot: claimFreshSlot() })
    return
  }
  if (intent.openFolder) {
    createWindow({ openFolder: intent.openFolder, sessionSlot: claimFreshSlot() })
    return
  }
  focusExistingWindow()
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
  markClean()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  markClean()
})
