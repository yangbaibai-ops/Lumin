// ─── 通知卡片上的操作按钮：渲染层处理器注册表 ──────────────────────────────
// 通知（含按钮与负载）会持久化在 SQLite 里，卡片随时可能被渲染出来——包括应用
// 重启之后。因此「点击后做什么」不能是随通知一起序列化的闭包，而应按
// payload.kind 在此注册：卡片只负责显示与派发，业务逻辑留在各自模块
// （如 lib/linkOpen.ts 的「创建缺失的目标」）。
import type { AppNotification } from '../../../shared/types'

export type NotificationActionHandler = (
  notification: AppNotification,
  actionId: string
) => void | Promise<void>

const handlers = new Map<string, NotificationActionHandler>()

/** 注册某类可交互通知的处理器（同 kind 覆盖注册，幂等，可在启动时调用） */
export function registerNotificationActions(
  kind: string,
  handler: NotificationActionHandler
): void {
  handlers.set(kind, handler)
}

/** 某类通知是否已有处理器（供调试/自检使用） */
export function hasNotificationActions(kind: string): boolean {
  return handlers.has(kind)
}

/**
 * 派发一次按钮点击。
 * @returns 是否找到了处理器；未注册时返回 false（调用方仍会收起卡片，不会出现死按钮）
 */
export async function dispatchNotificationAction(
  notification: AppNotification,
  actionId: string
): Promise<boolean> {
  const kind = notification.payload?.kind
  if (!kind) return false
  const handler = handlers.get(kind)
  if (!handler) return false
  await handler(notification, actionId)
  return true
}
