import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { db } from './database'
import { defaultSettings } from '../../shared/defaults'
import type { AppSettings } from '../../shared/types'

/**
 * ─── 自动更新（准备好了，但默认不打扰用户）────────────────────────────────────
 * 设计取向：把「能不能更新」与「要不要更新」分开 ——
 *   * 代码随时可用（依赖已在、事件已接）；
 *   * 是否真的去查由三个条件同时决定：① 打包态 ② 设置里打开了「自动检查更新」
 *     ③ publish 配的是**真实渠道**（不是占位地址）。
 * 这样默认状态下用户机器上不会因为一个占位域名冒出网络失败通知，也不会有半截功能埋着。
 *
 * 事件如何告诉用户：**不自己造通知**。主进程把状态原样发给渲染层
 * （`update:status`），由渲染层用它自己的 i18n 文案落成通知卡片 ——
 * 这样文案跟着语言走，且通知中心仍然只有一套实现（见 renderer/stores/notifications.ts）。
 */

/** 打包后 electron-builder 会把 publish 配置写成 resources/app-update.yml */
const UPDATE_CONFIG_FILE = 'app-update.yml'

/** 占位域名：落在这上面的 publish 一律视为「没配渠道」 */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'localhost']

export type UpdateState = 'checking' | 'available' | 'not-available' | 'downloaded' | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** 新版本号（available / downloaded 时有值） */
  version?: string
  /** 失败原因（截断，仅供展示与排查） */
  message?: string
}

/**
 * publish 是否指向真实渠道。
 * 判据是「打包产物里有没有 app-update.yml，且里面的 url/owner 不是占位值」——
 * 直接读文件比猜配置项可靠（开发态没有这个文件，天然返回 false）。
 */
export function updateChannelConfigured(): boolean {
  if (!app.isPackaged) return false
  try {
    const file = join(process.resourcesPath, UPDATE_CONFIG_FILE)
    if (!existsSync(file)) return false
    const text = readFileSync(file, 'utf-8')
    const urls = [...text.matchAll(/(?:url|owner|repo):\s*(\S+)/g)].map((m) => m[1].toLowerCase())
    if (!urls.length) return false
    // provider: github 时 url 不存在、看 owner/repo；此时只要 owner 不是占位就认为配了
    return !urls.some((u) => PLACEHOLDER_HOSTS.some((host) => u.includes(host)))
  } catch {
    return false
  }
}

function notifyRenderer(status: UpdateStatus): void {
  // 交给渲染层落成通知（文案在渲染层的 i18n 里，主进程只传数据）
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

let started = false

/**
 * 初始化自动更新。**永远不要**在开发态调用它去做真实检查：
 * dev 版的版本号来自 package.json，跟发布渠道对不上，检查只会得到噪音。
 */
export function initUpdater(): void {
  if (started) return
  started = true

  // 不自动下载、退出时如已下载则安装：把「要不要装」的决定权留给用户
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => notifyRenderer({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    notifyRenderer({ state: 'available', version: String(info?.version ?? '') })
  )
  autoUpdater.on('update-not-available', () => notifyRenderer({ state: 'not-available' }))
  autoUpdater.on('update-downloaded', (info) =>
    notifyRenderer({ state: 'downloaded', version: String(info?.version ?? '') })
  )
  autoUpdater.on('error', (err) =>
    notifyRenderer({ state: 'error', message: String(err?.message ?? err).slice(0, 200) })
  )

  if (shouldCheck()) void checkNow()
}

/** 现在该不该去查更新（三个条件同时满足） */
function shouldCheck(): boolean {
  if (!app.isPackaged) return false
  const s = db.kvGet<AppSettings>('settings', defaultSettings)
  if (!s.autoCheckUpdate) return false
  return updateChannelConfigured()
}

/**
 * 立即检查一次（设置里打开开关时调用）。
 * 返回是否真的发起了检查 —— 调用方据此决定要不要给用户一句「已开启」的反馈。
 */
export async function checkNow(): Promise<boolean> {
  if (!app.isPackaged || !updateChannelConfigured()) return false
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (err) {
    // 网络类失败很常见（离线、公司代理）：只作为状态告知，不抛给调用方
    notifyRenderer({ state: 'error', message: String((err as Error)?.message ?? err).slice(0, 200) })
    return false
  }
}

/**
 * 设置变更后的钩子：用户刚打开「自动检查更新」时立刻查一次，
 * 否则要等到下次启动才生效，体验上像「开关没反应」。
 */
export function onSettingsChanged(partial: Partial<AppSettings>): void {
  if (partial.autoCheckUpdate === true) void checkNow()
}
