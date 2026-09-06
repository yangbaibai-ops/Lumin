import { app, shell, BrowserWindow, nativeTheme, protocol, net } from 'electron'
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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: themeBackground(),
    title: 'Lumin',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 隐藏系统原生菜单条：顶部菜单栏由渲染层 TopMenuBar 呈现（位置精确、
  // Alt+F/E/V/H 确定性）；应用菜单仍安装，Ctrl+N/O/S 等加速键继续生效
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(true)

  attachCloseGuard(mainWindow)

  // 开发环境：转发渲染进程控制台日志，便于排查
  if (is.dev) {
    mainWindow.webContents.on(
      'console-message',
      (_event: unknown, detailsOrLevel: unknown, message?: string, line?: number, sourceId?: string) => {
        const details =
          typeof detailsOrLevel === 'object' && detailsOrLevel !== null
            ? (detailsOrLevel as { level: string; message: string; lineNumber: number; sourceId: string })
            : {
                level: String(detailsOrLevel),
                message: message ?? '',
                lineNumber: line ?? 0,
                sourceId: sourceId ?? ''
              }
        if (details.level === 'error' || details.level === 'warning') {
          console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
        }
      }
    )
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    markClean()
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 生产环境强化 CSP
  if (!is.dev) {
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
}

app.whenReady().then(() => {
  // 历史版本 electron-store 数据一次性迁入 SQLite kv（kv 已有数据时跳过）
  migrateLegacyStores()
  installMenu()
  registerIpc()

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
