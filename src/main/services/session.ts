// ─── 主进程：会话恢复的状态与窗口槽位分配 ──────────────────────────────────
// 模型：每个窗口占一个「槽位」（slots[i]），槽位里只记该窗口上次的文档与位置。
// 为什么按窗口而不是「全局一个」：本项目是「一窗一文档」的多窗口模型，用户开了
// 三个窗口就是三份工作上下文，恢复时应当原样回来。
//
// 职责边界：这里只管 kv 里的读写与槽位分配（纯数据）；窗口生命周期（谁占哪个槽位、
// 关闭时清空）在 index.ts，因为只有那里持有 BrowserWindow。
import { db } from './database'
import type { SessionSlot, SessionState } from '../../shared/types'
import { planRestoreFromSlots } from '../../shared/session'

const KEY = 'session'

/** 启动时最多重建的窗口数：避免上次开了一堆窗口导致启动风暴 */
export const MAX_RESTORE_WINDOWS = 5

/** 本进程内已分配的槽位（窗口创建时领取，进程结束自然释放） */
const claimed = new Set<number>()

/**
 * 其中**属于本次启动恢复计划**的那些槽位（`planRestore()` 一次性预留的）。
 *
 * 与 `claimed` 的区别是语义上的：`claimed` 里既有"恢复出来的老窗口"，也有"用户新开的窗口"。
 * 草稿归属必须区分这两者 —— 同一个槽位号，前者是"我上次没保存的正文"（该还给用户），
 * 后者是"上一个住户留下的"（该挪走，绝不能弹给一个刚按了 Ctrl+N 的空白窗口，见 §4.49）。
 */
const restored = new Set<number>()

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

/**
 * 单独关窗：把这个窗口的槽位**留下**，只标记「已关闭」。
 *
 * 为什么不是直接清掉：用户关掉窗口往往就是「今天先这样」，下次启动应当回到刚才那篇文档。
 * 清掉槽位的结果是——重启后只剩工作区文件夹（它另记在全局 kv 里），文档变成一个不落在
 * 任何实际位置的未命名缓冲区（「文件夹还在、文件是虚空的」就是这么来的）。
 *
 * 只记**最后一个**：更早被单独关掉的窗口是用户明确关掉的，不该在下次启动又冒出来；
 * 而关掉最后一个窗口就等于退出应用，所以「最后关掉的那个」才是用户心里「刚才那篇」。
 */
export function markSlotClosed(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 64) return
  const state = readSession()
  const slot = state.slots[index]
  if (!slot || (!slot.path && !slot.folder)) return
  // 上一份「最后关掉的窗口」记录被这次的取代（连同它的槽位号一起释放）
  const slots = state.slots.map((s) => (s?.closed ? null : s))
  while (slots.length <= index) slots.push(null)
  slots[index] = { ...slot, closed: true, closedAt: Date.now() }
  db.kvSet(KEY, { slots } satisfies SessionState)
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

/**
 * 槽位领取表：单次运行内只增不减。
 * 为什么不做「关窗即释放」：单独关掉的槽位是**故意留着**的（下次启动要回到那篇文档，
 * 见 markSlotClosed），释放它反而会让后来的窗口拿到同一个号、认领到别人的草稿。
 * 原先这里有个没人调用的 releaseSlot()，已删（真要释放，3 行就能加回来）。
 *//**
 * 本次运行**已经分配出去**的槽位（含启动时按恢复计划一次性预留的那些）。
 *
 * 草稿归属要用它：某个槽位的草稿如果属于"这次要恢复的窗口"，就不该被别的窗口抢走。
 * 与 `liveSlots`（已经建出窗口的槽位）不同——恢复计划算出来时就会把槽位全部占上，
 * 而窗口是错峰创建的（先建第一个、首帧之后再建其余），所以"计划内"才是正确的判据。
 */
export function claimedSlots(): number[] {
  return [...claimed]
}

/** 该槽位是不是本次启动恢复出来的（决定"槽位里那份草稿算不算我的"，见 restored 的说明） */
export function isRestoredSlot(slot: number | null): boolean {
  return slot !== null && restored.has(slot)
}

/**
 * 启动时应当重建的窗口清单：读 kv → 交给纯函数判定（shared/session.ts 的
 * planRestoreFromSlots，有单测）→ 落回 kv 的副作用在这里做。
 *
 * 排序按 savedAt 倒序（最近用过的窗口排第一）：调用方会**先只建第一个**、等它加载完
 * 再建其余窗口，所以「用户最后停留的那个窗口」应当最先出现在屏幕上，其余错峰创建。
 */
export function planRestore(): { index: number; slot: SessionSlot }[] {
  const state = readSession()
  const plan = planRestoreFromSlots(state.slots, MAX_RESTORE_WINDOWS)

  // 有窗口活着退出 → 被单独关掉的记录作废（槽位号一并释放）
  if (plan.dropClosed.length) {
    const drop = new Set(plan.dropClosed)
    const slots = state.slots.map((s, i) => (s && drop.has(i) ? null : s))
    db.kvSet(KEY, { slots } satisfies SessionState)
  }

  const windows = plan.windows.map(({ index, slot }) => {
    if (!plan.unmarkClosed.includes(index)) return { index, slot }
    // 摘掉「已关闭」标记再写回：它马上会被建成窗口，不该再挂着那个身份
    const restored: SessionSlot = { ...slot }
    delete restored.closed
    delete restored.closedAt
    writeSessionSlot(index, restored)
    return { index, slot: restored }
  })

  for (const w of windows) claimed.add(w.index)
  for (const w of windows) restored.add(w.index)
  return windows
}
