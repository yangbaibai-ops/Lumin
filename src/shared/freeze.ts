/**
 * ─── 全局防卡死兜底的**纯判据**（主进程 / 渲染进程 / 单测共用）────────────────
 *
 * 这里只放"该怎么判"的纯函数，不做任何 I/O、不认识 Electron：
 *   * 心跳超时（主进程据此弹「页面无响应」）；
 *   * 崩溃后的自动重载节流（避免崩溃循环）；
 *   * 渲染进程内的心跳间隔判定（>2s 的相邻两次 tick ⇒ 记一条 freeze）；
 *   * 「同一文档连续两次崩溃/无响应 ⇒ 下次默认源码模式」的升级规则；
 *   * 「文档多大算大」的估算（>2MB 或 >5 万节点 ⇒ 打开前问一句）。
 *
 * 为什么单独成文件：这些阈值/边界值是验收口径的一部分（心跳 500ms、超时 5s、
 * 冻结 2s、崩溃重载节流 30s），散在 Electron 的接线代码里就只能靠端到端套件守，
 * 而它们全都是毫秒级可测的算术。
 */

// ─── 心跳 ───────────────────────────────────────────────────────────────────

/** 渲染进程心跳间隔（ms）：500ms 一次，够快能在 5s 超时内留出多个采样点 */
export const HEARTBEAT_INTERVAL_MS = 500

/**
 * 心跳超时（ms）。
 *
 * 用户口径是「例如 >5s」。取 4600 而不是 5000：检测定时器本身有 250ms 粒度，
 * 恰好卡在 5000 会让实测落在 5.0~5.25s（CDP 注入还有一个请求往返），验收口径
 * 「≤5s」在边界上不成立。留 400ms 余量后，8s 阻塞的检测稳定落在 4.6~4.85s。
 */
export const HEARTBEAT_TIMEOUT_MS = 4600

/** 主进程巡检心跳的间隔（ms） */
export const HEARTBEAT_CHECK_MS = 250

export interface HeartbeatLiveness {
  /** 这台窗口是否已经发过至少一次心跳（没发过就不判超时：启动慢不是卡死） */
  primed: boolean
  stale: boolean
  /** 距上一次心跳多久（ms）；primed=false 时为 0 */
  ageMs: number
}

/**
 * 判活：`lastHeartbeatAt = 0` 表示还没收到第一次心跳。
 *
 * 为什么要 `primed`：窗口创建到渲染层 `bootstrap()` 之间要加载 2.5MB 的编辑器 chunk，
 * 慢机器上可能 >5s。那段时间主进程还没资格说"页面无响应"——它连一次心跳都没见过。
 */
export function heartbeatLiveness(
  nowMs: number,
  lastHeartbeatAt: number,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS
): HeartbeatLiveness {
  if (!Number.isFinite(lastHeartbeatAt) || lastHeartbeatAt <= 0) {
    return { primed: false, stale: false, ageMs: 0 }
  }
  const ageMs = Math.max(0, nowMs - lastHeartbeatAt)
  return { primed: true, stale: ageMs > timeoutMs, ageMs }
}

// ─── 门控：窗口不可见 / 系统挂起 / 用户关掉提示 ─────────────────────────────
//
// 背景（用户实测误报）：窗口最小化、被完全遮挡或系统休眠时，Chromium 会**节流甚至暂停**
// 渲染进程的定时器 —— 500ms 心跳停了，主进程按 4.6s 超时判"无响应"，于是用户在后台放一会儿
// 就收到一个纯属噪声的原生提示。判活本身没有错，错在"窗口根本不可见时还拿心跳当证据"。
//
// 这一节只放**纯判据**：什么时候该暂停、暂停后是否还要判、恢复时怎么复位。主进程的
// Electron 事件（minimize/hide/powerMonitor/…）与渲染层的 visibilitychange 都接到这里，
// 于是"可见才判"只有一处口径，单测也能毫秒级钉住。

/** 暂停巡检的原因（日志/诊断用；全是 ASCII，主进程 console 有静态守卫） */
export type FreezePauseReason =
  | 'setting-disabled'
  | 'window-minimized'
  | 'window-hidden'
  | 'renderer-hidden'
  | 'system-suspend'
  | 'screen-locked'

/**
 * 窗口状态是否已经不该判活。
 * 最小化与"不可见"（hide / 被系统隐藏）都必须暂停：两者都会让 Chromium 停定时器。
 * 被遮挡（occluded）不在这里判 —— Electron 的 `isVisible()` 仍为 true，那一路由渲染层的
 * `document.visibilitychange` 发 `freeze:pause` 解决。
 */
export function freezeWindowPauseReason(activity: {
  minimized: boolean
  visible: boolean
}): 'window-minimized' | 'window-hidden' | null {
  if (activity.minimized) return 'window-minimized'
  if (!activity.visible) return 'window-hidden'
  return null
}

export interface FreezeCheckInput {
  nowMs: number
  lastHeartbeatAt: number
  /** 设置里的「页面无响应提示」开关；关闭 = 不巡检、不弹（崩溃恢复不受影响） */
  enabled: boolean
  /** 主进程门控状态（窗口不可见 / 系统挂起 / 渲染层报告隐藏） */
  paused: boolean
  /** 正在 reload / 崩溃恢复中：渲染进程本来就不在，心跳停了不是"无响应" */
  reloading: boolean
  /** 已经有一轮无响应未结束：别重复弹 */
  episodeOpen: boolean
}

export type FreezeCheckResult =
  | {
      action: 'idle'
      reason: 'disabled' | 'paused' | 'reloading' | 'episode-open' | 'unprimed' | 'alive'
    }
  | { action: 'prompt'; ageMs: number }

/**
 * 巡检的一拍：先看门控，再看心跳。门控命中时**连算都不算** —— 这样"后台放 20 秒后恢复"
 * 永远不会在恢复瞬间用一段陈旧心跳弹框（恢复方负责把 `lastHeartbeatAt` 复位成 now）。
 */
export function planFreezeCheck(input: FreezeCheckInput): FreezeCheckResult {
  if (!input.enabled) return { action: 'idle', reason: 'disabled' }
  if (input.paused) return { action: 'idle', reason: 'paused' }
  if (input.reloading) return { action: 'idle', reason: 'reloading' }
  if (input.episodeOpen) return { action: 'idle', reason: 'episode-open' }
  const live = heartbeatLiveness(input.nowMs, input.lastHeartbeatAt)
  if (!live.primed) return { action: 'idle', reason: 'unprimed' }
  if (!live.stale) return { action: 'idle', reason: 'alive' }
  return { action: 'prompt', ageMs: live.ageMs }
}

/**
 * 恢复巡检：**先把计时器复位成 now**，再允许判活。
 *
 * 这是"最小化 20 秒 → 恢复瞬间不弹框"的关键：恢复时 `lastHeartbeatAt` 还停在最小化前，
 * 直接恢复巡检会让第一拍（250ms 内）立刻看到 20s 的 age。复位后第一拍一定"活着"，
 * 真正的卡死仍会在 4.6s 后被抓到（那 4.6s 里渲染层心跳没来）。
 */
export function planWatchResume(nowMs: number): {
  lastHeartbeatAt: number
  paused: false
} {
  return { lastHeartbeatAt: nowMs, paused: false }
}

/**
 * 渲染层可见性变化的心跳计划：
 *   * `hidden`  ⇒ 停定时器，并告诉主进程暂停（不给节流后的"假心跳"留机会）；
 *   * `visible` ⇒ 重置计时并**立刻**发一拍，同时告诉主进程恢复（主进程也会复位 lastBeat）。
 */
export interface HeartbeatVisibilityPlan {
  running: boolean
  sendNow: boolean
  resetTimer: boolean
  notifyMain: 'pause' | 'resume' | null
}

export function planHeartbeatVisibility(
  visibility: 'visible' | 'hidden' | 'prerender'
): HeartbeatVisibilityPlan {
  if (visibility === 'hidden') {
    return { running: false, sendNow: false, resetTimer: false, notifyMain: 'pause' }
  }
  return { running: true, sendNow: true, resetTimer: true, notifyMain: 'resume' }
}

// ─── 崩溃后的自动重载节流 ───────────────────────────────────────────────────

/** 两次自动重载之间至少隔这么久（ms）：崩溃循环里不能无限 reload */
export const CRASH_RELOAD_THROTTLE_MS = 30_000

/** 统计窗口（ms）：再久以前的自动重载不再参与"次数"判定 */
export const CRASH_RELOAD_WINDOW_MS = 5 * 60_000

/** 统计窗口内最多自动重载几次（窗口内超过就只弹提示，等用户点） */
export const CRASH_RELOAD_MAX_IN_WINDOW = 3

export type CrashReloadReason = 'ok' | 'throttled-recent' | 'throttled-window'

export interface CrashReloadDecision {
  reload: boolean
  reason: CrashReloadReason
  /** 被节流时：还要等多久才能再自动重载（ms）；ok 时为 0 */
  retryInMs: number
}

/**
 * 崩溃后要不要自动重载。
 *
 * 两条节流：
 *  1. **30 秒内只自动重载一次** —— 崩溃循环（渲染进程一起来又崩）不会被"自动重载"放大成
 *     无限循环：第二次崩溃时自动重载被拒，改弹一个**要用户点**的提示；
 *  2. **5 分钟内最多 3 次** —— 把"每 31 秒崩一次"的慢循环也拦住。
 *
 * 被拒绝时绝不静默：调用方负责弹提示（`retryInMs` 用来告诉用户还要等多久）。
 */
export function planCrashReload(
  nowMs: number,
  recentAutoReloads: readonly number[],
  opts: {
    throttleMs?: number
    windowMs?: number
    maxInWindow?: number
  } = {}
): CrashReloadDecision {
  const throttleMs = opts.throttleMs ?? CRASH_RELOAD_THROTTLE_MS
  const windowMs = opts.windowMs ?? CRASH_RELOAD_WINDOW_MS
  const maxInWindow = opts.maxInWindow ?? CRASH_RELOAD_MAX_IN_WINDOW
  const recent = recentAutoReloads.filter((t) => Number.isFinite(t) && t <= nowMs)
  const last = recent.length ? Math.max(...recent) : 0
  if (last && nowMs - last < throttleMs) {
    return { reload: false, reason: 'throttled-recent', retryInMs: throttleMs - (nowMs - last) }
  }
  const inWindow = recent.filter((t) => nowMs - t < windowMs).length
  if (inWindow >= maxInWindow) {
    const oldest = Math.min(...recent.filter((t) => nowMs - t < windowMs))
    return {
      reload: false,
      reason: 'throttled-window',
      retryInMs: Math.max(0, windowMs - (nowMs - oldest))
    }
  }
  return { reload: true, reason: 'ok', retryInMs: 0 }
}

/**
 * 渲染进程崩溃后的恢复决策：**门控与开关一律不参与**。
 *
 * 为什么单独留这个函数而不是让调用方直接调 `planCrashReload`：崩溃是"页面已经没了"，
 * 与"看不见时不要误报无响应"是两件事。把它写成一个**显式接收 gate 却刻意忽略**的纯函数，
 * 单测就能钉住"关闭提示 / 窗口最小化时，首次崩溃仍然自动重载一次"这条不能回退的行为
 * —— 将来谁想在崩溃路径上加门控，会先在这里红灯。
 */
export function planCrashRecovery(
  nowMs: number,
  recentAutoReloads: readonly number[],
  gate: { enabled: boolean; paused: boolean },
  opts: Parameters<typeof planCrashReload>[2] = {}
): CrashReloadDecision {
  void gate
  return planCrashReload(nowMs, recentAutoReloads, opts)
}

// ─── 渲染进程内的「同步阻塞」判定 ───────────────────────────────────────────

/** 哨兵 tick 间隔（ms）：低频，别让哨兵自己成为负担 */
export const FREEZE_TICK_MS = 1000

/** 相邻两次 tick 间隔超过它就认为主线程被同步阻塞过（ms） */
export const FREEZE_GAP_MS = 2000

/** `window.__LWORK.freezes` 的环形上限（只留最近几条，绝不记正文） */
export const FREEZE_RING = 10

export interface FreezeRecord {
  /** 发现时刻（wall clock，ms），便于和日志/截图对齐 */
  at: number
  /** 相邻两次心跳的实际间隔（ms）—— 阻塞时长的一个**上界**（含 1s 的正常间隔） */
  durationMs: number
  /** 定位提示：不记内容，只记"当时最后一笔重活 / 长任务 / 调用栈"这类线索 */
  stackHint: string
}

/**
 * 判一次 tick 间隔。
 *
 * ⚠️ 这里**刻意不要求"连续两次"**：一次 3s 的同步阻塞只会让**下一次** tick 迟到一次，
 * 之后间隔立刻恢复正常。若坚持连续两次 >2s，单次阻塞永远记不下来 —— 而那正是要抓的
 * 现场。所以判据是「相邻两次 tick 的间隔 >2s」；`durationMs` 是这个间隔本身（上界）。
 * 连续阻塞时每次迟到的 tick 都会记一条，`FREEZE_RING` 负责不无限增长。
 */
export function detectFreezeGap(
  previousTickAt: number,
  nowMs: number,
  opts: { gapMs?: number; stackHint?: string } = {}
): FreezeRecord | null {
  const gapMs = opts.gapMs ?? FREEZE_GAP_MS
  if (!Number.isFinite(previousTickAt) || previousTickAt <= 0) return null
  const gap = nowMs - previousTickAt
  if (!Number.isFinite(gap) || gap <= gapMs) return null
  return {
    at: Math.round(nowMs),
    durationMs: Math.round(gap),
    stackHint: opts.stackHint ?? ''
  }
}

// ─── 文档风险：连续两次崩溃/无响应 ⇒ 下次默认源码模式 ─────────────────────────

/** 同一文档"连续"出事的阈值：达到就开始默认源码模式 */
export const DOC_RISK_INCIDENTS = 2

/** 记录多久没再出事就自动衰减（30 天）；避免永久把一份文档钉死在源码模式 */
export const DOC_RISK_DECAY_MS = 30 * 24 * 60 * 60 * 1000

export type DocIncidentKind = 'crash' | 'unresponsive'

export interface DocRiskRecord {
  /** 最近一次事故时刻（ms） */
  at: number
  /** 连续事故次数（崩溃 + 无响应；成功以富文本打开会清零） */
  incidents: number
  /** 下一次打开是否默认源码模式（incidents ≥ DOC_RISK_INCIDENTS） */
  safeMode: boolean
  /** 最近一次事故类型（诊断用） */
  lastKind: DocIncidentKind
}

export function emptyDocRisk(): DocRiskRecord {
  return { at: 0, incidents: 0, safeMode: false, lastKind: 'crash' }
}

/**
 * 记一次事故。**只有连续**才算：两次事故之间如果用户成功打开过（`clearDocRisk`），
 * 计数从头开始 —— 所以这里只负责 `+1`，清零由打开成功/用户明确选择负责。
 */
export function noteDocIncident(
  previous: DocRiskRecord | null | undefined,
  kind: DocIncidentKind,
  nowMs: number
): DocRiskRecord {
  const base = previous ?? emptyDocRisk()
  const expired = base.at > 0 && nowMs - base.at > DOC_RISK_DECAY_MS
  const incidents = (expired ? 0 : base.incidents) + 1
  return {
    at: nowMs,
    incidents,
    safeMode: incidents >= DOC_RISK_INCIDENTS,
    lastKind: kind
  }
}

/** 读的时候顺手判过期：太久以前的事故不该继续影响今天 */
export function liveDocRisk(
  record: DocRiskRecord | null | undefined,
  nowMs: number
): DocRiskRecord {
  if (!record || !Number.isFinite(record.at) || record.at <= 0) return emptyDocRisk()
  if (nowMs - record.at > DOC_RISK_DECAY_MS) return emptyDocRisk()
  return record
}

export type DocOpenDecision = 'normal' | 'prompt-large' | 'source-risk'

/**
 * 打开一篇文档时该怎么走：
 *   * 先看历史风险（连续两次崩溃/无响应）⇒ 直接源码模式（`source-risk`）；
 *   * 再看规模（>2MB 或 >5 万节点）⇒ 问一句（`prompt-large`）；
 *   * 其余照常。
 */
export function planDocOpen(
  risk: DocRiskRecord | null | undefined,
  estimate: { bytes: number; nodes: number }
): DocOpenDecision {
  if (risk?.safeMode && risk.incidents >= DOC_RISK_INCIDENTS) return 'source-risk'
  if (isLargeDoc(estimate)) return 'prompt-large'
  return 'normal'
}

// ─── 「大文档」估算 ─────────────────────────────────────────────────────────

/** 大文档提示阈值：>2MB */
export const LARGE_DOC_BYTES = 2 * 1024 * 1024

/** 大文档提示阈值：>5 万节点（按非空行估算，见 estimateDocNodes） */
export const LARGE_DOC_NODES = 50_000

/** UTF-8 字节数（浏览器 / Node 都有 TextEncoder；失败按字符数兜底） */
export function utf8Bytes(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

/**
 * 估算 Markdown 的块级节点数：**非空行数**。
 *
 * 不需要精确 —— 这道闸只回答"要不要在打开前提醒一句"，阈值是 5 万。非空行数对
 * 段落/列表项/表格行/标题都成立，对多行代码块会略微高估（保守方向：宁可多提醒一次，
 * 也不要在 10 万行表格里点开才发现卡死）。
 */
export function estimateDocNodes(text: string): number {
  if (!text) return 0
  let nodes = 0
  let inFence = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence
      nodes += 1
      continue
    }
    // 代码块里的行不单独算节点（整块是一个 node）
    if (!inFence) nodes += 1
  }
  return nodes
}

export function estimateDocLoad(text: string): { bytes: number; nodes: number } {
  return { bytes: utf8Bytes(text), nodes: estimateDocNodes(text) }
}

export function isLargeDoc(
  estimate: { bytes: number; nodes: number },
  limits: { bytes?: number; nodes?: number } = {}
): boolean {
  const maxBytes = limits.bytes ?? LARGE_DOC_BYTES
  const maxNodes = limits.nodes ?? LARGE_DOC_NODES
  return estimate.bytes > maxBytes || estimate.nodes > maxNodes
}
