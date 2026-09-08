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

/**
 * 创建应用窗口。openPath 非空时通过 additionalArguments 告诉渲染进程启动后
 * 打开该文件（用于「在新窗口打开」）；首个窗口恢复上次的位置/大小，
 * 后续窗口基于最近窗口级联偏移，避免完全重叠。
 */
function createWindow(openPath?: string): BrowserWindow {
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
      ...(openPath ? { additionalArguments: [`--lumin-open=${encodeURIComponent(openPath)}`] } : {})
    }
  })

  if (restoreMaximized) mainWindow.maximize()

  // 隐藏系统原生菜单条：顶部菜单栏由渲染层 TopMenuBar 呈现（位置精确、
  // Alt+F/E/V/H 确定性）；应用菜单仍安装，Ctrl+N/O/S 等加速键继续生效
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(true)

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

  // 多窗口：新建空白窗口 / 在新窗口打开文件（IPC 由渲染进程驱动）
  ipcMain.on('app:newWindow', () => {
    createWindow()
  })
  ipcMain.on('app:openInNewWindow', (_event, path: string) => {
    if (path) createWindow(path)
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
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
