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

/** 创建窗口时的启动意图：打开某个文件 / 打开某个文件夹 / 参与会话恢复的槽位 */
interface WindowOpenOptions {
  /** 启动后打开的文件（--lumin-open） */
  openFile?: string
  /** 启动后作为工作区打开的文件夹（--lumin-open-folder） */
  openFolder?: string
  /** 会话槽位（渲染进程据此读写自己的会话；主进程负责单窗关闭时清空） */
  sessionSlot?: number
}

/**
 * 创建应用窗口。openFile / openFolder 通过 additionalArguments 告诉渲染进程
 * 启动后要打开什么（「在新窗口打开」与「最近文件夹」用）；sessionSlot 非空时该窗口
 * 参与会话恢复。首个窗口恢复上次的位置/大小，后续窗口基于最近窗口级联偏移。
 */
function createWindow(options: WindowOpenOptions = {}): BrowserWindow {
  const { openFile, openFolder, sessionSlot } = options
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
      ...(openFile || openFolder || sessionSlot !== undefined
        ? {
            additionalArguments: [
              ...(openFile ? [`--lumin-open=${encodeURIComponent(openFile)}`] : []),
              ...(openFolder ? [`--lumin-open-folder=${encodeURIComponent(openFolder)}`] : []),
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

app.whenReady().then(() => {
  // 历史版本 electron-store 数据一次性迁入 SQLite kv（kv 已有数据时跳过）
  migrateLegacyStores()
  installMenu()
  registerIpc()

  // 多窗口：新建空白窗口 / 在新窗口打开文件 / 在新窗口打开文件夹（IPC 由渲染进程驱动）。
  // 三者都领一个新槽位，这样用户新开的窗口也会被会话记录到。
  ipcMain.on('app:newWindow', () => {
    createWindow({ sessionSlot: claimFreshSlot() })
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
  if (plan.length) {
    for (const { index } of plan) createWindow({ sessionSlot: index })
  } else {
    createWindow({ sessionSlot: claimFreshSlot() })
  }

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
