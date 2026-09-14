// ─── 主进程：会话恢复的状态与窗口槽位分配 ──────────────────────────────────
// 模型：每个窗口占一个「槽位」（slots[i]），槽位里只记该窗口上次的文档与位置。
// 为什么按窗口而不是「全局一个」：本项目是「一窗一文档」的多窗口模型，用户开了
// 三个窗口就是三份工作上下文，恢复时应当原样回来。
//
// 职责边界：这里只管 kv 里的读写与槽位分配（纯数据）；窗口生命周期（谁占哪个槽位、
// 关闭时清空）在 index.ts，因为只有那里持有 BrowserWindow。
import { db } from './database'
import type { SessionSlot, SessionState } from '../../shared/types'

const KEY = 'session'

/** 启动时最多重建的窗口数：避免上次开了一堆窗口导致启动风暴 */
export const MAX_RESTORE_WINDOWS = 5

/** 本进程内已分配的槽位（窗口创建时领取，进程结束自然释放） */
const claimed = new Set<number>()

/**
 * 应用是否正在整体退出。只有「整体退出」才保留各窗口槽位；用户单独关掉某个窗口时
 * 要清空它的槽位，否则下次启动会把已经关掉的窗口又拉回来。
 * 放在这里作为单一事实来源：index.ts（窗口生命周期）与 ipc.ts（关闭守卫）都要用。
 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

function normalize(state: SessionState | null | undefined): SessionState {
  if (!state || !Array.isArray(state.slots)) return { slots: [] }
  return {
    slots: state.slots.map((s) =>
      s && typeof s === 'object' && typeof s.path === 'string' ? (s as SessionSlot) : null
    )
  }
}

export function readSession(): SessionState {
  return normalize(db.kvGet<SessionState | null>(KEY, null))
}

/** 写入某个槽位（slot=null → 清空；数组按需补长，避免越界丢数据） */
export function writeSessionSlot(index: number, slot: SessionSlot | null): void {
  if (!Number.isInteger(index) || index < 0 || index > 64) return
  const state = readSession()
  const slots = state.slots.slice()
  while (slots.length <= index) slots.push(null)
  slots[index] = slot
  db.kvSet(KEY, { slots } satisfies SessionState)
}

/** 清空某个槽位（窗口被单独关闭时调用；应用整体退出时不清） */
export function clearSessionSlot(index: number): void {
  writeSessionSlot(index, null)
}

/**
 * 丢弃整份会话。用于「设置里关闭了会话恢复」的启动：此时旧的槽位已无意义，
 * 留着会让用户日后重新打开该开关时突然冒出一堆早已不相关的窗口。
 */
export function resetSession(): void {
  db.kvSet(KEY, { slots: [] } satisfies SessionState)
}

/** 领取一个槽位：给定 index（启动恢复）或自动分配下一个空闲索引 */
export function claimSlot(index?: number): number {
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
    claimed.add(index)
    return index
  }
  const state = readSession()
  const used = new Set<number>(claimed)
  state.slots.forEach((s, i) => {
    if (s) used.add(i)
  })
  let next = 0
  while (used.has(next)) next += 1
  claimed.add(next)
  return next
}

export function releaseSlot(index: number): void {
  claimed.delete(index)
}

/**
 * 启动时应当重建的窗口清单：只挑「有文档」或「有文件夹」的槽位，最多
 * MAX_RESTORE_WINDOWS 个。同时把这些槽位标记为已领取，后续新建窗口不会撞车。
 *
 * 排序按 savedAt 倒序（最近用过的窗口排第一）：调用方会**先只建第一个**、等它加载完
 * 再建其余窗口，所以「用户最后停留的那个窗口」应当最先出现在屏幕上，其余错峰创建。
 */
export function planRestore(): { index: number; slot: SessionSlot }[] {
  const state = readSession()
  const plan: { index: number; slot: SessionSlot }[] = []
  state.slots.forEach((slot, index) => {
    if (!slot || (!slot.path && !slot.folder)) return
    plan.push({ index, slot })
  })
  plan.sort((a, b) => (b.slot.savedAt ?? 0) - (a.slot.savedAt ?? 0) || a.index - b.index)
  const limited = plan.slice(0, MAX_RESTORE_WINDOWS)
  for (const p of limited) claimed.add(p.index)
  return limited
}
