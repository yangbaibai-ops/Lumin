/**
 * ─── 「从最近列表移除」的撤销（审计 §8 P2「危险/不可逆操作还缺撤销」）────────────
 *
 * 通知卡片会**持久化在 SQLite 里**、重启后仍可能被渲染出来，所以「点了按钮做什么」不能是
 * 随通知序列化的闭包，只能按 `payload.kind` 在启动时注册处理器（与 `lib/linkOpen.ts` 同一套机制，
 * 见 `lib/notificationActions.ts`）。
 *
 * 为什么放在独立模块而不是写在 `stores/recent.ts` 里：
 * store 只负责「列表怎么变」，安装器负责「通知按钮接到哪个动作」——后者需要在应用启动时调用
 * （`App.vue`），而 store 是惰性的（第一次 use 才创建）。两者分开后，store 不需要认识
 * 处理器注册表，处理器注册表也不需要在没有通知时把一个 store 提前实例化。
 */
import type { RecentFile, RecentFolder } from '../../../shared/types'
import { RECENT_REMOVE_KIND } from './recent'
import { registerNotificationActions } from './notificationActions'
import { useRecentStore } from '../stores/recent'

interface RecentRemovePayload {
  list?: 'files' | 'folders'
  entry?: RecentFile | RecentFolder
}

/** 启动时调用一次：把「撤销」按钮接到最近列表上 */
export function installRecentUndoAction(): void {
  registerNotificationActions(RECENT_REMOVE_KIND, (notification, actionId) => {
    if (actionId !== 'undo') return
    const payload = notification.payload as RecentRemovePayload | null
    const entry = payload?.entry
    if (!entry?.path) return
    const recent = useRecentStore()
    if (payload?.list === 'folders') recent.restoreFolder(entry as RecentFolder)
    else recent.restoreFile(entry as RecentFile)
  })
}
