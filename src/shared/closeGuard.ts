// ─── 关窗兜底的时间判据（纯函数，可单测）────────────────────────────────────
//
// 背景（审计 §2 P1「关窗兜底 2.5s 强杀」）：主进程给渲染层的"保存机会"是一个**固定 2.5 秒**的
// 定时器，到点无条件 `win.close()`。慢盘 / 大文件 / 文档多的时候 `flushAll()` 可能还没跑完，
// 于是最后一次保存与最后一份草稿之间的内容就没了 —— 而这恰恰是用户"以为自己保存了"的部分。
//
// 现在的口径：**渲染层只要还在干活就一直等**，但总时长有硬上限（不能让一个卡死的渲染进程
// 把"关不掉窗口"变成新问题）：
//   * 渲染层在关窗流程里按秒发心跳（`app:closeProgress`）→ 兜底计时器重置；
//   * 连续 `CLOSE_FALLBACK_MS` 没有心跳 → 认定它卡住/没响应，强制关闭；
//   * 从开始关窗起超过 `CLOSE_FALLBACK_MAX_MS` → 无论有没有心跳都强制关闭。
//
// 判据是纯函数：`shouldForceClose(state, nowMs)`。"什么时候该放弃等"这件事以前藏在
// ipc.ts 的一个 setTimeout 里，只能靠真实开关窗去试；现在毫秒级可测。
export const CLOSE_FALLBACK_MS = 2500
export const CLOSE_FALLBACK_MAX_MS = 30_000

export interface CloseGuardState {
  /** 关窗流程开始的时刻（第一次收到 close 事件） */
  startedAtMs: number
  /** 最近一次收到渲染层心跳的时刻 */
  lastProgressMs: number
}

/** 记一次心跳（渲染层还在落盘）。原地改，返回同一个对象便于链式使用。 */
export function noteCloseProgress(state: CloseGuardState, nowMs: number): CloseGuardState {
  state.lastProgressMs = nowMs
  return state
}

export interface CloseForceDecision {
  force: boolean
  /** 已经等了多久（写进日志/排查用） */
  waitedMs: number
  /** 为什么强制关闭（`stalled` = 心跳停了 / `timeout` = 总时长到顶） */
  reason: 'stalled' | 'timeout' | null
}

/**
 * 现在该不该强制关掉这个窗口。
 * 判定顺序：先看总上限（不管有没有心跳），再看心跳间隔。
 * `nowMs` 比 `startedAtMs` 还小（时钟被往回调）时按"还没到点"处理 —— 不强制。
 */
export function shouldForceClose(state: CloseGuardState, nowMs: number): CloseForceDecision {
  const waitedMs = nowMs - state.startedAtMs
  if (!(waitedMs > 0)) return { force: false, waitedMs: 0, reason: null }
  if (waitedMs >= CLOSE_FALLBACK_MAX_MS) return { force: true, waitedMs, reason: 'timeout' }
  const idle = nowMs - state.lastProgressMs
  // idle 为 NaN（心跳时间戳坏了）时按"没有心跳"处理：宁可按时兜底，也不要永远关不掉
  if (!(idle < CLOSE_FALLBACK_MS)) return { force: true, waitedMs, reason: 'stalled' }
  return { force: false, waitedMs, reason: null }
}
