/**
 * ─── 会话恢复计划（纯函数，可单测）────────────────────────────────────────────
 * 「启动时该重建哪些窗口」这件事原先埋在 main/services/session.ts 的 kv 读写里，
 * 只能靠端到端套件验证；而它的语义恰好是踩过坑的地方（单独关窗 vs 整体退出，见 manual §4.45）。
 * 抽到这里之后：主进程只负责「读 kv → 问这个函数 → 照做」，判定本身毫秒级可测。
 */

/** 槽位里与「恢复计划」相关的字段（结构上兼容 shared/types 的 SessionSlot） */
export interface SessionSlotLike {
  path: string | null
  folder?: string | null
  savedAt: number
  /** 该窗口是被用户**单独关掉**的 */
  closed?: boolean
  /** 被单独关掉的时刻 */
  closedAt?: number
}

export interface RestorePlan<T extends SessionSlotLike> {
  /** 要重建的窗口：槽位索引 + 槽位内容（已按「最近用过」排序，并截到上限） */
  windows: { index: number; slot: T }[]
  /** 这些槽位要**清空**：被单独关掉、但同时还有窗口「活着退出」——用户明确关掉的窗口不该回来 */
  dropClosed: number[]
  /** 这些槽位的 `closed` 标记要**摘掉**：它马上会被建成窗口，不再是「已关闭」 */
  unmarkClosed: number[]
}

/**
 * 两种退出方式对应两种恢复：
 *  - **整体退出**（菜单退出 / 系统关机 / 崩溃）：窗口都是「活着死的」，全部按原样恢复；
 *  - **挨个关窗**：那些窗口是用户明确关掉的，只恢复**最后关掉的那一个**
 *    （关掉最后一个窗口 = 退出应用，所以它就是用户心里「刚才那篇」）。
 *
 * @param slots       kv 里的槽位数组（可能含 null）
 * @param maxWindows  单次最多重建几个窗口（避免上次开了一堆窗口导致启动风暴）
 */
export function planRestoreFromSlots<T extends SessionSlotLike>(
  slots: readonly (T | null)[],
  maxWindows: number
): RestorePlan<T> {
  const live: { index: number; slot: T }[] = []
  let lastClosed: { index: number; slot: T } | null = null

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]
    if (!slot || (!slot.path && !slot.folder)) continue
    if (slot.closed) {
      const at = slot.closedAt ?? slot.savedAt ?? 0
      if (!lastClosed || at >= (lastClosed.slot.closedAt ?? lastClosed.slot.savedAt ?? 0)) {
        lastClosed = { index, slot }
      }
      continue
    }
    live.push({ index, slot })
  }

  if (live.length) {
    live.sort((a, b) => (b.slot.savedAt ?? 0) - (a.slot.savedAt ?? 0) || a.index - b.index)
    const windows = live.slice(0, Math.max(0, maxWindows))
    return {
      windows,
      // 有窗口活着退出 → 单独关掉的那个不跟着回来；顺手把作废记录清掉（槽位号也释放）
      dropClosed: lastClosed ? [lastClosed.index] : [],
      unmarkClosed: []
    }
  }

  if (lastClosed) {
    return {
      windows: [lastClosed],
      dropClosed: [],
      // 这个窗口马上会被建起来：`closed` 身份必须立刻摘掉，否则用户再开一个窗口、
      // 然后整体退出时，它会被当成「被单独关掉的」而丢掉（明明当时开着）。
      unmarkClosed: [lastClosed.index]
    }
  }

  return { windows: [], dropClosed: [], unmarkClosed: [] }
}
