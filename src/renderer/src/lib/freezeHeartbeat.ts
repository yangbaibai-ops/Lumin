// ─── 渲染进程 → 主进程的心跳（500ms）＋ 主进程防卡死事件接线 ─────────────────────
//
// 用户口径：渲染进程每 500ms 向主进程发一次心跳；主进程记「最后一次心跳时间」与
// 「最近重活摘要」（`window.__LWORK` 的计数，绝不含正文），据此判 5s 超时。
//
// ⚠️ 可见性是这条链的**前提**：窗口最小化 / 被完全遮挡 / 系统休眠时，Chromium 会节流甚至
// 暂停后台定时器 —— 心跳停了并不代表卡死。所以 `document.visibilitychange` 是硬门：
//   * `hidden`  ⇒ 停掉心跳定时器，并发一次 `freeze:pause`（主进程暂停巡检与弹框）；
//   * `visible` ⇒ 重置计时、**立刻**补一拍，并发 `freeze:resume`（主进程复位 lastBeat）。
// 这样主进程永远不会在窗口看不见的时候用一段陈旧心跳判"无响应"。
//
// 这里同时把 `app:freeze`（主进程 → 渲染层）接上：
//   * `flush-draft`：主进程要 reload 了，**尽力**再落一次草稿，然后回 `freeze:draftAck`；
//   * `unresponsive` / `recovered`：只更新 `window.__LFREEZE` 的诊断字段，供排查。
//
// 为什么心跳不放在编辑器里：卡死可能发生在编辑器挂载之前（大文档解析）或源码模式，
// 判活必须覆盖整个渲染进程，所以放在 `main.ts` 的启动期。
import { planHeartbeatVisibility } from '../../../shared/freeze'
import { workBudgetStats } from './editor/workBudget'

export interface FreezeDiagnostics {
  installed: boolean
  /** 当前是否因页面隐藏而暂停心跳（验收用；与主进程的 paused 是同一件事的两侧） */
  paused: boolean
  heartbeats: number
  lastSentAt: number
  lastPayload: {
    at: number
    rafFramesIn500ms: number
    visible: boolean
    work: ReturnType<typeof workPayload>
  } | null
  lastMainEvent: Record<string, unknown> | null
  freezes: ReturnType<typeof workBudgetStats>['freezes']
  state: () => Promise<Record<string, unknown> | null>
}

export interface FreezeHeartbeatOptions {
  /** 心跳间隔（默认 500ms；测量实例可覆盖） */
  intervalMs?: number
  /**
   * 主进程要 reload 前调用：落一次草稿。
   * 返回 Promise；宿主负责在 finally 里回 ack（本模块不吞掉失败）。
   */
  flushDraft?: () => Promise<void>
  /** 收到主进程事件（测试/诊断用；不影响 ack 行为） */
  onEvent?: (payload: Record<string, unknown>) => void
}

function workPayload(): {
  runs: number
  overruns: number
  lastMs: number
  lastName: string
  longTasks: number
  lastLongMs: number
  freezes: number
  lastFreezeMs: number
} {
  const s = workBudgetStats()
  return {
    runs: s.runs,
    overruns: s.overruns,
    lastMs: Math.round(s.lastMs * 10) / 10,
    // 只带"最后一笔重活的名字"（如 serialize / zh-spellcheck），不带任何正文
    lastName: s.lastName.slice(0, 80),
    longTasks: s.longTasks,
    lastLongMs: s.lastLongMs,
    freezes: s.freezes.length,
    lastFreezeMs: s.lastFreezeMs
  }
}

let installed = false
let uninstall: (() => void) | null = null

/** 安装心跳与主进程事件监听；返回卸载函数（单测/热更新用） */
export function installFreezeHeartbeat(opts: FreezeHeartbeatOptions = {}): () => void {
  if (typeof window === 'undefined' || !window.luminAPI?.freeze) return () => {}
  if (installed) return uninstall ?? (() => {})
  installed = true

  const intervalMs = Math.max(200, Math.round(opts.intervalMs ?? 500))
  const diag: FreezeDiagnostics = {
    installed: true,
    paused: false,
    heartbeats: 0,
    lastSentAt: 0,
    lastPayload: null,
    lastMainEvent: null,
    freezes: workBudgetStats().freezes,
    state: () => window.luminAPI.freeze.state()
  }
  try {
    ;(window as unknown as { __LFREEZE?: FreezeDiagnostics }).__LFREEZE = diag
  } catch {
    /* 非浏览器环境：忽略 */
  }

  /**
   * rAF 帧计数：验收要 `rafFramesIn500ms`（窗口被遮挡时 rAF 会停，正好用它证明
   * "窗口确实在可见状态"）。每拍归零，按实际经过时间折算到 500ms。
   */
  let frames = 0
  let rafId = 0
  const countFrame = (): void => {
    frames += 1
    rafId = requestAnimationFrame(countFrame)
  }
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(countFrame)

  let lastTick = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  /** 发一拍心跳。隐藏期间不调用它（避免定时器被节流后打出"假心跳"）。 */
  const beat = (): void => {
    const now = Date.now()
    const elapsed = Math.max(1, now - lastTick)
    lastTick = now
    const rawFrames = frames
    frames = 0
    const payload = {
      at: now,
      // 折算到 500ms 口径：默认间隔就是 500ms，这里只是防测量实例改间隔
      rafFramesIn500ms: Math.round((rawFrames * 500) / elapsed),
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      work: workPayload()
    }
    diag.heartbeats += 1
    diag.lastSentAt = now
    diag.lastPayload = payload
    try {
      window.luminAPI.freeze.heartbeat(payload)
    } catch {
      /* 主进程正在退出：下一拍再试 */
    }
  }

  const stopTimer = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }

  const startTimer = (): void => {
    stopTimer()
    lastTick = Date.now()
    timer = setInterval(beat, intervalMs)
  }

  const onVisibilityChange = (): void => {
    const plan = planHeartbeatVisibility(
      typeof document === 'undefined' ? 'visible' : document.visibilityState
    )
    if (plan.notifyMain === 'pause') {
      // 先告诉主进程暂停，再停表：这两步之间不允许再打出一拍"假心跳"。
      diag.paused = true
      stopTimer()
      try {
        window.luminAPI.freeze.pause()
      } catch {
        /* 主进程正在退出：它那一侧还有窗口事件兜底 */
      }
      return
    }
    // 可见：复位计时并立刻补一拍。主进程收到 resume 也会把自己的 lastBeat 复位，
    // 因此"隐藏 20s 后恢复"的第一拍不会被当成 20s 的超时。
    diag.paused = false
    startTimer()
    try {
      window.luminAPI.freeze.resume()
    } catch {
      /* 同上 */
    }
    beat()
  }

  // 启动时页面就不可见（最小化启动 / 后台恢复）也不该跑表。
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    diag.paused = true
    try {
      window.luminAPI.freeze.pause()
    } catch {
      /* 忽略 */
    }
  } else {
    startTimer()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  const off = window.luminAPI.events.on('app:freeze', (raw) => {
    const payload = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    diag.lastMainEvent = payload
    try {
      opts.onEvent?.(payload)
    } catch {
      /* 诊断回调失败不影响主流程 */
    }
    if (payload.kind !== 'flush-draft') return
    const done = (): void => {
      try {
        window.luminAPI.freeze.draftAck()
      } catch {
        /* 主进程已不在：算了 */
      }
    }
    if (!opts.flushDraft) {
      done()
      return
    }
    // 无论成功失败都要 ack：主进程最多等 1.2s，ack 只是让它早点继续
    void Promise.resolve()
      .then(opts.flushDraft)
      .catch(() => {})
      .then(done)
  })

  uninstall = () => {
    stopTimer()
    if (rafId) cancelAnimationFrame(rafId)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    off()
    installed = false
    uninstall = null
  }
  return uninstall
}
