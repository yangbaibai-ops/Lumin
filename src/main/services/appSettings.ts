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
import { mergeSettings, normalizeSettings } from '../../shared/settingsSchema'
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
 * 把一份**已经归一**的设置落地，并按需广播。
 *
 * 广播通道 `settings:changed` 在 preload 的出站白名单里登记（`EVENT_CHANNELS`），
 * `tests/i18nAndIpc.test.mjs` 会拿主进程真实的 `webContents.send(...)` 与它双向对账。
 *
 * ⚠️ `broadcast` 的取舍（波次 2 修的真问题）：**渲染层自己发起的那次写入不要回播**。
 * 回播的是"整份快照"，而渲染层的落库是 **250ms 节流**的 —— 于是有这么一条真实的竞态：
 *   1. 渲染层 `set('historyEnabled', false)`（排进 250ms 后的落库队列）；
 *   2. 上一次落库的**回播**此刻到达（快照取自更早，`historyEnabled` 还是 true）；
 *   3. `applyRemote()` 整份 `$patch` ⇒ 刚改的那条**被打回**，随后的落库把 true 写回 kv；
 *   4. 主进程 `recordHistoryBeforeOverwrite` 读到 true ⇒ 明明关了历史，快照照写。
 * 现场就是 `_verify-md-fidelity` 的"历史 关闭后不再写快照"（`entries=2`），而且**间歇性**
 * 出现（取决于回播与 `set` 的先后）。所以：渲染层发起的写入只落库、不回播（它本来就有这份状态），
 * 只有**主进程侧**的改动（原生菜单主题、备份目录选择）才广播 —— 那才是回播存在的理由。
 */
export function writeSettings(next: AppSettings, opts: { broadcast?: boolean } = {}): AppSettings {
  db.kvSet('settings', next)
  syncNativeTheme(next.theme)
  if (opts.broadcast === false) return next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', next)
  }
  return next
}

/**
 * 合并式写入：读 → 合并（`mergeSettings`：自由映射键整块替换）→ 归一 → 落地并广播。
 * 返回写入的那一份，调用方要回执时可以拿去用。
 *
 * ⚠️ 与 `settings:update` **同一条合并口径**（`mergeSettings`，不是裸 `deepMerge`）：
 * 主进程这条路目前只写主题/备份目录，但两条写入口的语义必须一致 —— 否则
 * "哪条路能删掉 keybindings 里的一条"又会变成两处真相（见 shared/settingsSchema.ts）。
 */
export function patchSettings(partial: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings(mergeSettings(readSettings(), partial), defaultSettings).settings
  return writeSettings(next)
}
