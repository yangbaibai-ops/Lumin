import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'

/**
 * ─── 窗口作用域（window scope）─────────────────────────────────────────────
 * 「哪些状态属于哪一个窗口」在 Electron 里没有原生答案：主进程能力（IPC handler、
 * SQLite、协议）是所有窗口共享的，渲染进程无法自证身份。因此需要一层主进程侧的
 * 窗口身份：创建窗口时登记，之后由 IPC 发送方（event.sender）反查。
 *
 * 为什么用「会话槽位」当身份：槽位是本项目里唯一跨启动稳定的窗口身份（会话恢复
 * 按槽位重建窗口），所以「窗口 A 的未读提示」在重启后仍回到窗口 A 而不是串到别处。
 * 没有槽位的窗口（理论上不存在）退化成一次性随机作用域，保证「宁可各自独立，
 * 不可互相串台」这条底线。
 *
 * 用法：主进程按作用域读写窗口私有数据（当前是 notifications 表），渲染进程既不
 * 传也不该知道作用域——伪造无从谈起。
 */

/** 作用域键前缀：w<槽位> / w#<随机> */
const PREFIX = 'w'
/** window.id → 作用域 */
const scopeOfWindow = new Map<number, string>()

/** 槽位对应的作用域键（新建窗口领槽位时用它清理上一任窗口的残留数据） */
export function scopeOfSlot(slot: number): string {
  return `${PREFIX}${slot}`
}

/** 登记窗口作用域（窗口关闭时自动注销）；返回该窗口的作用域键 */
export function bindWindowScope(win: BrowserWindow, slot?: number): string {
  const scope = typeof slot === 'number' ? scopeOfSlot(slot) : `${PREFIX}#${randomUUID()}`
  scopeOfWindow.set(win.id, scope)
  win.on('closed', () => scopeOfWindow.delete(win.id))
  return scope
}

/** 反查 IPC 发送方所属的窗口作用域；未知窗口返回空串（落到「无主」分区，不会串台） */
export function scopeOfSender(sender: WebContents): string {
  const win = BrowserWindow.fromWebContents(sender)
  return (win && scopeOfWindow.get(win.id)) || ''
}
