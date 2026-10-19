/**
 * ─── 主进程侧的「防卡死」兜底：心跳 / 无响应 / 崩溃 / 重载恢复 ───────────────────
 *
 * 这一层存在的理由：渲染进程一旦被同步代码卡住，**它自己什么都做不了**（弹不出提示、
 * 写不了草稿、甚至连"我卡了"都喊不出来）。所以判活必须在主进程：
 *
 *   1. 渲染层每 500ms 发一条 `freeze:heartbeat`（同时带 `window.__LWORK` 的摘要）；
 *   2. 主进程既看心跳（>4.8s 没来 ⇒ 判定无响应），也听 Electron 的
 *      `unresponsive` / `responsive` / `render-process-gone` 事件（两条独立证据）；
 *   3. 判定无响应 ⇒ 弹一个**异步、非阻塞主进程**的原生对话框：等待 / 重新加载并恢复；
 *   4. 崩溃 ⇒ 节流自动重载（30s 一次），并在重载前**尽力**让渲染层落一次草稿；
 *      拿不到响应就依赖既有自动草稿（渲染层 `files.writeDraft` 本身有 1.2s 防抖，
 *      见 lib/filesCore.ts 的 `planDraftWrite`）——主进程绝不在卡死时去读整篇文档。
 *
 * ⚠️ 硬约束：
 *   * **不自动强制重载**：无响应时 reload 必须由用户点（本文件只把按钮结果接上）；
 *   * **不做重活**：这里只读心跳摘要、发消息、调 `reload()`；不解析文档、不读大文件；
 *   * 主进程 console 一律 ASCII（`tests/mainConsoleAscii.test.mjs`）。
 */
import { BrowserWindow, dialog, type WebContents } from 'electron'
import { mainT } from '../i18n'
import * as openDocs from './openDocs'
import * as docRisk from './docRisk'
import {
  HEARTBEAT_CHECK_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  heartbeatLiveness,
  planCrashReload
} from '../../shared/freeze'
import type { FreezeRecord } from '../../shared/freeze'

/** 渲染层心跳里带的重活摘要（形状与 `workBudgetStats()` 对齐，但不含任何正文） */
export interface FreezeWorkSummary {
  runs: number
  overruns: number
  lastMs: number
  lastName: string
  longTasks: number
  lastLongMs: number
  freezes: number
  lastFreezeMs: number
}

export interface FreezeHeartbeatPayload {
  at?: number
  /** 最近 500ms 的 rAF 帧数（验收用来确认窗口确实在出帧） */
  rafFramesIn500ms?: number
  visible?: boolean
  work?: Partial<FreezeWorkSummary>
}

export interface FreezeReloadEntry {
  at: number
  trigger: 'unresponsive' | 'crash'
}

/** 通过 `freeze:state` 暴露给渲染层/验收脚本的只读快照 */
export interface FreezeWindowState {
  windowId: number
  docPath: string | null
  attachedAt: number
  heartbeats: number
  lastHeartbeatAt: number
  lastHeartbeatAgeMs: number
  lastRafFramesIn500ms: number
  lastVisible: boolean
  lastWork: FreezeWorkSummary | null
  unresponsiveCount: number
  lastUnresponsiveAt: number
  lastDetectLatencyMs: number
  lastDetectSource: 'heartbeat' | 'unresponsive-event' | ''
  prompts: number
  lastPromptAt: number
  promptOpen: boolean
  userWaited: number
  userReloads: number
  reloads: FreezeReloadEntry[]
  crashes: number
  lastCrashAt: number
  lastCrashReason: string
  autoReloadThrottled: number
  lastAutoReloadAt: number
  episodeOpen: boolean
  lastRecoveredAt: number
  lastRecoveryMs: number
}

interface Internals {
  windowId: number
  win: BrowserWindow
  attachedAt: number
  heartbeats: number
  lastHeartbeatAt: number
  lastRafFramesIn500ms: number
  lastVisible: boolean
  lastWork: FreezeWorkSummary | null
  unresponsiveCount: number
  lastUnresponsiveAt: number
  lastDetectLatencyMs: number
  lastDetectSource: 'heartbeat' | 'unresponsive-event' | ''
  prompts: number
  lastPromptAt: number
  promptOpen: boolean
  userWaited: number
  userReloads: number
  reloads: FreezeReloadEntry[]
  crashes: number
  lastCrashAt: number
  lastCrashReason: string
  autoReloadThrottled: number
  lastAutoReloadAt: number
  episodeOpen: boolean
  episodeStartedAt: number
  lastRecoveredAt: number
  lastRecoveryMs: number
  /** 最近一次**自动**重载的时刻（崩溃节流只看它） */
  autoCrashReloads: number[]
  /** 我们自己发起的 reload：期间的 render-process-gone 不算崩溃 */
  reloading: boolean
  heartbeatTimer: ReturnType<typeof setInterval> | null
  draftFlushResolve: ((ok: boolean) => void) | null
}

const states = new Map<number, Internals>()

function log(line: string): void {
  // ASCII-only
  console.log(`[freeze] ${line}`)
}

function stateFor(win: BrowserWindow): Internals | null {
  return states.get(win.id) ?? null
}

function stateForSender(sender: WebContents): Internals | null {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? stateFor(win) : null
}

/** 首屏/启动期的宽限：一次心跳都没见过时，`unresponsive` 事件不立刻弹窗 */
const FIRST_HEARTBEAT_GRACE_MS = 10_000

/**
 * 挂到一个窗口上：心跳巡检 + Electron 的 webContents 事件。
 * `createWindow()` 里调用一次；窗口关闭时自动清理。
 */
export function attachFreezeGuard(win: BrowserWindow): void {
  const wc = win.webContents
  const state: Internals = {
    windowId: win.id,
    win,
    attachedAt: Date.now(),
    heartbeats: 0,
    lastHeartbeatAt: 0,
    lastRafFramesIn500ms: 0,
    lastVisible: true,
    lastWork: null,
    unresponsiveCount: 0,
    lastUnresponsiveAt: 0,
    lastDetectLatencyMs: 0,
    lastDetectSource: '',
    prompts: 0,
    lastPromptAt: 0,
    promptOpen: false,
    userWaited: 0,
    userReloads: 0,
    reloads: [],
    crashes: 0,
    lastCrashAt: 0,
    lastCrashReason: '',
    autoReloadThrottled: 0,
    lastAutoReloadAt: 0,
    episodeOpen: false,
    episodeStartedAt: 0,
    lastRecoveredAt: 0,
    lastRecoveryMs: 0,
    autoCrashReloads: [],
    reloading: false,
    heartbeatTimer: null,
    draftFlushResolve: null
  }
  states.set(win.id, state)

  /**
   * 心跳巡检：每 250ms 看一次。`HEARTBEAT_TIMEOUT_MS` 是 4800ms，所以检测落在
   * 4.8~5.05s（验收口径 ≤5s）。
   */
  state.heartbeatTimer = setInterval(() => {
    if (win.isDestroyed()) return
    // 最小化/隐藏时 Chromium 会节流定时器，心跳变慢不是"卡死"：不判、不弹。
    if (win.isMinimized() || !win.isVisible()) return
    // 正在 reload（或崩溃后等用户点）：渲染进程本来就不在，心跳停了不是"无响应"。
    if (state.reloading) return
    const live = heartbeatLiveness(Date.now(), state.lastHeartbeatAt)
    if (!live.primed || !live.stale) return
    if (state.episodeOpen) return
    noteUnresponsive(win, state, 'heartbeat', live.ageMs)
  }, HEARTBEAT_CHECK_MS)

  wc.on('unresponsive', () => {
    if (win.isDestroyed() || state.episodeOpen || state.reloading) return
    if (win.isMinimized() || !win.isVisible()) {
      log(`unresponsive while hidden window=${win.id} (ignored)`)
      return
    }
    const live = heartbeatLiveness(Date.now(), state.lastHeartbeatAt)
    // 一次心跳都没收到时给启动留宽限（慢机器加载编辑器 chunk 不是"卡死"）
    if (!live.primed && Date.now() - state.attachedAt < FIRST_HEARTBEAT_GRACE_MS) {
      log(`unresponsive before first heartbeat window=${win.id} (startup grace)`)
      return
    }
    noteUnresponsive(win, state, 'unresponsive-event', live.ageMs)
  })

  wc.on('responsive', () => {
    if (win.isDestroyed()) return
    markRecovered(state, 'responsive-event')
  })

  wc.on('did-finish-load', () => {
    if (!state.reloading) return
    /**
     * 重载完成：旧渲染进程已经没了，`lastHeartbeatAt` 还是重载前的旧值。
     * 先回到"等第一次心跳"的状态，否则 4.8s 后会把**正常的重载启动**判成无响应
     * （实测：崩溃自动重载后又弹一次「页面无响应」，纯属噪声）。
     */
    state.reloading = false
    state.lastHeartbeatAt = 0
    state.episodeOpen = false
    log(`reload finished window=${state.windowId}`)
  })

  wc.on('render-process-gone', (_event, details) => {
    if (win.isDestroyed()) return
    const reason = details?.reason ?? 'unknown'
    /**
     * 我们自己调的 `reload()` 也会让旧渲染进程退出，但那是主动行为，不是崩溃：
     * 不计入风险、不触发自动重载，只落一条日志便于排查。
     */
    if (state.reloading || reason === 'clean-exit') {
      // 保持 `reloading=true` 直到 `did-finish-load`：旧渲染进程退出与新页面首帧之间
      // 有一段"心跳本来就不该有"的空窗，提前复位会让巡检把这段空窗判成无响应。
      log(`renderer gone window=${win.id} reason=${reason} (intentional)`)
      return
    }
    handleCrash(win, state, reason, Number(details?.exitCode) || 0)
  })

  win.on('closed', () => {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
    state.draftFlushResolve?.(false)
    state.draftFlushResolve = null
    states.delete(win.id)
  })
}

/** 渲染层心跳（`freeze:heartbeat` 通道） */
export function noteHeartbeat(sender: WebContents, payload?: FreezeHeartbeatPayload): void {
  const state = stateForSender(sender)
  if (!state) return
  const now = Date.now()
  const first = state.lastHeartbeatAt === 0
  state.heartbeats += 1
  state.lastHeartbeatAt = now
  if (typeof payload?.rafFramesIn500ms === 'number') {
    state.lastRafFramesIn500ms = Math.max(0, Math.round(payload.rafFramesIn500ms))
  }
  if (typeof payload?.visible === 'boolean') state.lastVisible = payload.visible
  if (payload?.work && typeof payload.work === 'object') {
    const w = payload.work
    state.lastWork = {
      runs: Number(w.runs) || 0,
      overruns: Number(w.overruns) || 0,
      lastMs: Number(w.lastMs) || 0,
      lastName: typeof w.lastName === 'string' ? w.lastName.slice(0, 80) : '',
      longTasks: Number(w.longTasks) || 0,
      lastLongMs: Number(w.lastLongMs) || 0,
      freezes: Number(w.freezes) || 0,
      lastFreezeMs: Number(w.lastFreezeMs) || 0
    }
  }
  if (first) log(`heartbeat online window=${state.windowId}`)
  // 心跳重新来了 ⇒ 这一轮无响应结束（哪怕用户还没点对话框）
  if (state.episodeOpen) markRecovered(state, 'heartbeat')
}

/** `freeze:draftAck`：渲染层在重载前完成了最后一次草稿落盘 */
export function noteDraftFlushed(sender: WebContents): void {
  const state = stateForSender(sender)
  state?.draftFlushResolve?.(true)
}

/** `freeze:state`：给渲染层/验收脚本的只读快照（不含任何正文） */
export function freezeStateSnapshot(win: BrowserWindow): FreezeWindowState | null {
  const state = stateFor(win)
  if (!state) return null
  const live = heartbeatLiveness(Date.now(), state.lastHeartbeatAt)
  return {
    windowId: state.windowId,
    docPath: openDocs.docForWindow(state.windowId),
    attachedAt: state.attachedAt,
    heartbeats: state.heartbeats,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastHeartbeatAgeMs: live.ageMs,
    lastRafFramesIn500ms: state.lastRafFramesIn500ms,
    lastVisible: state.lastVisible,
    lastWork: state.lastWork,
    unresponsiveCount: state.unresponsiveCount,
    lastUnresponsiveAt: state.lastUnresponsiveAt,
    lastDetectLatencyMs: state.lastDetectLatencyMs,
    lastDetectSource: state.lastDetectSource,
    prompts: state.prompts,
    lastPromptAt: state.lastPromptAt,
    promptOpen: state.promptOpen,
    userWaited: state.userWaited,
    userReloads: state.userReloads,
    reloads: [...state.reloads],
    crashes: state.crashes,
    lastCrashAt: state.lastCrashAt,
    lastCrashReason: state.lastCrashReason,
    autoReloadThrottled: state.autoReloadThrottled,
    lastAutoReloadAt: state.lastAutoReloadAt,
    episodeOpen: state.episodeOpen,
    lastRecoveredAt: state.lastRecoveredAt,
    lastRecoveryMs: state.lastRecoveryMs
  }
}

// ─── 内部：无响应 / 恢复 ─────────────────────────────────────────────────────

function noteUnresponsive(
  win: BrowserWindow,
  state: Internals,
  source: 'heartbeat' | 'unresponsive-event',
  ageMs: number
): void {
  if (state.promptOpen || state.episodeOpen) return
  const now = Date.now()
  state.episodeOpen = true
  state.episodeStartedAt = now
  state.unresponsiveCount += 1
  state.lastUnresponsiveAt = now
  state.lastDetectSource = source
  state.lastDetectLatencyMs = Math.max(0, Math.round(ageMs))
  log(`unresponsive window=${state.windowId} source=${source} age=${state.lastDetectLatencyMs}ms`)

  // 按文档记录事故：连续两次 ⇒ 下次打开默认源码模式（判据在 shared/freeze.ts）
  const docPath = openDocs.docForWindow(state.windowId)
  if (docPath) docRisk.noteDocIncidentFor(docPath, 'unresponsive')

  // 提示也发给渲染层（恢复后能看到"刚刚无响应"的记录）；冻结期间它会排队。
  sendToRenderer(state, {
    kind: 'unresponsive',
    at: now,
    ageMs: state.lastDetectLatencyMs,
    source
  })
  void promptUnresponsive(win, state)
}

/**
 * 无响应提示：`dialog.showMessageBox` 是**异步**的（不是 `...Sync`），主进程事件循环
 * 不会被它挡住；同时窗口也只是被系统模态禁用，不会强制关页。两个按钮：
 *   0 = 等待（默认，安全出口）
 *   1 = 重新加载并恢复
 */
async function promptUnresponsive(win: BrowserWindow, state: Internals): Promise<void> {
  if (state.promptOpen || win.isDestroyed()) return
  state.promptOpen = true
  state.prompts += 1
  state.lastPromptAt = Date.now()
  log(`prompt unresponsive window=${state.windowId} count=${state.prompts}`)
  try {
    // 用户可能正看着别的窗口：先把出问题的窗口唤到前面，否则原生提示会藏在后面
    // （它只是"提示"，不是后台任务；看不到等于没提示）。
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: mainT('freeze.unresponsiveTitle'),
      message: mainT('freeze.unresponsiveMessage', {
        seconds: (state.lastDetectLatencyMs / 1000).toFixed(1)
      }),
      detail: mainT('freeze.unresponsiveDetail'),
      buttons: [mainT('freeze.wait'), mainT('freeze.reload')],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (win.isDestroyed()) return
    if (response === 1) {
      state.userReloads += 1
      log(`user chose reload window=${state.windowId}`)
      await reloadWithDraftFlush(win, state, 'unresponsive')
    } else {
      state.userWaited += 1
      log(`user chose wait window=${state.windowId}`)
    }
  } catch (err) {
    log(`prompt failed window=${state.windowId} err=${String((err as Error)?.message ?? err)}`)
  } finally {
    state.promptOpen = false
  }
}

function markRecovered(state: Internals, source: string): void {
  if (!state.episodeOpen) return
  const now = Date.now()
  state.episodeOpen = false
  state.lastRecoveredAt = now
  state.lastRecoveryMs = state.episodeStartedAt ? now - state.episodeStartedAt : 0
  log(`recovered window=${state.windowId} source=${source} after=${state.lastRecoveryMs}ms`)
  sendToRenderer(state, {
    kind: 'recovered',
    at: now,
    recoveryMs: state.lastRecoveryMs
  })
}

// ─── 内部：重载 / 草稿 ──────────────────────────────────────────────────────

/**
 * 重载前**尽力**落一次草稿：给渲染层发 `app:freeze`（kind=flush-draft），等它 ack。
 * 最多等 1200ms —— 渲染层卡死时事件根本执行不了，此时立刻放弃、依赖既有自动草稿：
 * **主进程绝不在卡死时去读整篇文档**（那会把主线程也拖下水）。
 */
function flushDraftBeforeReload(win: BrowserWindow, state: Internals): Promise<boolean> {
  const wc = win.webContents
  if (win.isDestroyed() || wc.isDestroyed()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (state.draftFlushResolve === finish) state.draftFlushResolve = null
      clearTimeout(timer)
      resolve(ok)
    }
    state.draftFlushResolve = finish
    const timer = setTimeout(() => {
      log(`draft flush timeout window=${state.windowId} (rely on autosave)`)
      finish(false)
    }, 1200)
    try {
      win.webContents.send('app:freeze', { kind: 'flush-draft' })
    } catch {
      finish(false)
    }
  })
}

async function reloadWithDraftFlush(
  win: BrowserWindow,
  state: Internals,
  trigger: 'unresponsive' | 'crash'
): Promise<void> {
  if (win.isDestroyed()) return
  const flushed = await flushDraftBeforeReload(win, state)
  if (win.isDestroyed()) return
  log(`reload window=${state.windowId} trigger=${trigger} draftFlushed=${flushed ? 1 : 0}`)
  state.reloading = true
  state.reloads.push({ at: Date.now(), trigger })
  try {
    win.webContents.reload()
  } catch (err) {
    state.reloading = false
    log(`reload failed window=${state.windowId} err=${String((err as Error)?.message ?? err)}`)
  }
}

// ─── 内部：崩溃 ────────────────────────────────────────────────────────────

function handleCrash(win: BrowserWindow, state: Internals, reason: string, exitCode: number): void {
  const now = Date.now()
  state.crashes += 1
  state.lastCrashAt = now
  state.lastCrashReason = reason
  // 渲染进程已经不在了：从这一刻起心跳停止是**预期**，不能让心跳巡检再弹"无响应"。
  // 一直保持到 `did-finish-load`（自动/手动重载完成）才复位。
  state.reloading = true
  log(`render process gone window=${state.windowId} reason=${reason} exitCode=${exitCode}`)

  const docPath = openDocs.docForWindow(state.windowId)
  if (docPath) docRisk.noteDocIncidentFor(docPath, 'crash')

  const decision = planCrashReload(now, state.autoCrashReloads)
  if (decision.reload) {
    state.autoCrashReloads.push(now)
    state.lastAutoReloadAt = now
    log(`crash auto-reload window=${state.windowId} (first within throttle)`)
    setTimeout(() => {
      if (win.isDestroyed()) return
      void reloadWithDraftFlush(win, state, 'crash')
    }, 300)
    return
  }

  state.autoReloadThrottled += 1
  log(
    `crash auto-reload throttled window=${state.windowId} reason=${decision.reason} retryIn=${Math.round(
      decision.retryInMs
    )}ms`
  )
  void promptCrash(win, state, decision.reason, decision.retryInMs)
}

/**
 * 崩溃循环被节流时的提示：**不再自动重载**，改由用户点。
 * 选「重新加载」是人工决定，不受节流限制（节流只约束"自动"）。
 */
async function promptCrash(
  win: BrowserWindow,
  state: Internals,
  reason: string,
  retryInMs: number
): Promise<void> {
  if (win.isDestroyed() || state.promptOpen) return
  state.promptOpen = true
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: mainT('freeze.crashTitle'),
      message: mainT('freeze.crashMessage'),
      detail:
        reason === 'throttled-window'
          ? mainT('freeze.crashThrottledWindow')
          : mainT('freeze.crashThrottledRecent', {
              seconds: Math.max(1, Math.round(retryInMs / 1000))
            }),
      buttons: [mainT('freeze.crashReload'), mainT('freeze.crashWait')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (win.isDestroyed()) return
    if (response === 0) {
      state.userReloads += 1
      log(`user chose crash reload window=${state.windowId}`)
      await reloadWithDraftFlush(win, state, 'crash')
    } else {
      log(`user chose crash wait window=${state.windowId}`)
    }
  } catch (err) {
    log(
      `crash prompt failed window=${state.windowId} err=${String((err as Error)?.message ?? err)}`
    )
  } finally {
    state.promptOpen = false
  }
}

function sendToRenderer(state: Internals, payload: Record<string, unknown>): void {
  if (state.win.isDestroyed() || state.win.webContents.isDestroyed()) return
  try {
    state.win.webContents.send('app:freeze', payload)
  } catch {
    /* 渲染进程已消失：提示发不到就算了（主进程的原生对话框才是兜底） */
  }
}

/** 诊断：暴露给其它模块/验收的常量（只读） */
export const FREEZE_CONSTANTS = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  heartbeatCheckMs: HEARTBEAT_CHECK_MS
} as const

/** 兼容旧引用：其它模块只关心"有没有记录过 freeze"时用 */
export type { FreezeRecord }
