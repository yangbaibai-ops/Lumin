// 必须在任何会（传递）导入 node:sqlite 的模块之前加载，以屏蔽其实验性警告
import './suppressWarnings'
import { app, shell, BrowserWindow, nativeTheme, protocol, net, ipcMain, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { installMenu } from './menu'
import { registerIpc, attachCloseGuard } from './ipc'
import { migrateLegacyStores } from './store'
import { db } from './services/database'
import * as session from './services/session'
import * as openDocs from './services/openDocs'
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

// 应用名 / 模型 ID
app.setName('Lumin')
electronApp.setAppUserModelId('com.lumin.app')

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
    ...(process.platform === 'linux' ? { icon } : {}),
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

  // 会话恢复：按上次的窗口槽位重建窗口（每个槽位一个窗口，各自恢复文档/文件夹与位置）。
  // 「在新窗口打开文件/文件夹」创建的窗口带 --lumin-open(-folder)，优先级高于会话槽位；
  // 设置里关闭 restoreSession 时一律走单窗口（空白未命名缓冲区）。
  const wantRestore = db.kvGet('settings', defaultSettings).restoreSession !== false
  const plan = wantRestore ? session.planRestore() : []
  if (!wantRestore) session.resetSession()
  // 首个窗口先建（「最近使用过的窗口」优先，见 planRestore 的排序），
  // 其余窗口等它加载完首帧后再建 —— 避免 N 个渲染进程同时抢 CPU/磁盘把首屏拖慢。
  const [head, ...rest] = plan
  const first =
    head !== undefined
      ? createWindow({ sessionSlot: head.index })
      : createWindow({ sessionSlot: claimFreshSlot() })
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

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow({ sessionSlot: claimFreshSlot() })
  })
})

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
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
