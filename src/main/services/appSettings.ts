// ─── 设置的**唯一读写入口**（主进程侧）────────────────────────────────────────
//
// 为什么要有这个文件（报告 §3.2 P0-1「设置是两处真相」）：
//   * 渲染层的 Pinia settings store 通过 `settings:update` **单向下推**；
//   * 主进程另有三处直接 `db.kvSet('settings', …)` —— 备份目录选择/恢复默认，以及
//     **原生菜单的主题子菜单**。它们写完不通知渲染层，于是界面显示旧值直到重启；
//     反过来 store 的 `persist()` 会把整份设置回写，又把主进程那一步悄悄打回去
//     （实测症状："选了别的盘，重启后变回默认目录"）。
//
// 现在：主进程写设置只走 `patchSettings()`（kv + 原生主题 + 广播 `settings:changed`），
// 渲染层订阅广播后就地 patch store —— 两侧永远同源，且新增"主进程改设置"的调用点
// 不可能再漏掉同步（这正是把补偿逻辑从调用点搬进数据层的意思）。
import { BrowserWindow, nativeTheme } from 'electron'
import { db } from './database'
import { defaultSettings } from '../../shared/defaults'
import { deepMerge, normalizeSettings } from '../../shared/settingsSchema'
import type { AppSettings } from '../../shared/types'

/**
 * 读设置：顺手归一（丢掉 defaults 里没有的键、补上缺的键、盖 `settingsVersion`）。
 * 只要结果与 kv 里那份不同就写回一次（第二次读不再写，见 shared/settingsSchema.ts）。
 */
export function readSettings(): AppSettings {
  const { settings, changed } = normalizeSettings(
    db.kvGet<AppSettings>('settings', defaultSettings),
    defaultSettings
  )
  if (changed) db.kvSet('settings', settings)
  return settings
}

/**
 * 原生主题跟随设置（Windows 标题栏颜色 / `prefers-color-scheme`）。
 * 切换主题时标题栏也要跟着变，否则顶部原生标题栏颜色不跟应用主题。
 */
export function syncNativeTheme(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme === 'sepia' ? 'light' : theme
}

/**
 * 把一份**已经归一**的设置落地并广播。
 *
 * 广播通道 `settings:changed` 在 preload 的出站白名单里登记（`EVENT_CHANNELS`），
 * `tests/i18nAndIpc.test.mjs` 会拿主进程真实的 `webContents.send(...)` 与它双向对账。
 */
export function writeSettings(next: AppSettings): AppSettings {
  db.kvSet('settings', next)
  syncNativeTheme(next.theme)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', next)
  }
  return next
}

/**
 * 合并式写入：读 → 深合并 → 归一（渲染层多送的键不该进库）→ 落地并广播。
 * 返回写入的那一份，调用方要回执时可以拿去用。
 */
export function patchSettings(partial: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings(deepMerge(readSettings(), partial), defaultSettings).settings
  return writeSettings(next)
}
