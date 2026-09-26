/**
 * ─── 「重命名」的撤销（审计 §8 P2「危险/不可逆操作还缺确认与撤销」）──────────────
 *
 * 与 `lib/recentUndo.ts` 同一套机制：通知会**持久化在 SQLite 里**、重启后仍可能被渲染出来，
 * 所以「点了按钮做什么」不能是随通知序列化的闭包，只能按 `payload.kind` 在启动时注册处理器
 * （见 `lib/notificationActions.ts`）。注册点在 `App.vue`（与另外两个安装器并排）。
 *
 * 为什么处理器只做"转发"：真正的改名 + 后续修正（当前文档路径、最近列表子孙路径、刷新目录树）
 * 全在 `stores/files.ts` 的 `undoRename` 里 —— 那是唯一知道这些状态的地方。
 */
import { registerNotificationActions } from './notificationActions'
import { RENAME_KIND, useFilesStore } from '../stores/files'

interface RenameUndoPayload {
  oldPath?: string
  newPath?: string
  type?: 'file' | 'directory'
  name?: string
}

/** 启动时调用一次：把通知卡片上的「撤销」接到 files store 上 */
export function installRenameUndoAction(): void {
  registerNotificationActions(RENAME_KIND, (notification, actionId) => {
    if (actionId !== 'undo') return
    const payload = notification.payload as RenameUndoPayload | null
    if (!payload?.oldPath || !payload?.newPath || !payload.type) return
    void useFilesStore().undoRename({
      oldPath: payload.oldPath,
      newPath: payload.newPath,
      type: payload.type
    })
  })
}
