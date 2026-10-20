/**
 * ─── 主进程侧的「防卡死」兜底：心跳 / 无响应 / 崩溃 / 重载恢复 ───────────────────
 *
 * 这一层存在的理由：渲染进程一旦被同步代码卡住，**它自己什么都做不了**（弹不出提示、
 * 写不了草稿、甚至连"我卡了"都喊不出来）。所以判活必须在主进程：
 *
 *   1. 渲染层每 500ms 发一条 `freeze:heartbeat`（同时带 `window.__LWORK` 的摘要）；
 *   2. 主进程既看心跳（>4.6s 没来 ⇒ 判定无响应），也听 Electron 的
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
import { BrowserWindow, dialog, powerMonitor, type WebContents } from 'electron'
import { mainT } from '../i18n'
import * as openDocs from './openDocs'
import * as docRisk from './docRisk'
import * as appSettings from './appSettings'
import {
  HEARTBEAT_CHECK_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  freezeWindowPauseReason,
  heartbeatLiveness,
  planCrashRecovery,
  planFreezeCheck,
  planWatchResume
} from '../../shared/freeze'
import type { FreezePauseReason, FreezeRecord } from '../../shared/freeze'

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
  /** 设置里的「页面无响应提示」是否开启（关闭 = 不巡检、不弹；崩溃恢复仍开） */
  watchEnabled: boolean
  /** 门控状态：窗口不可见 / 系统挂起 / 渲染层报告 hidden / 开关关闭 */
  paused: boolean
  pauseReason: FreezePauseReason | ''
  pauseCount: number
  resumeCount: number
  lastPausedAt: number
  lastResumeAt: number
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
  watchEnabled: boolean
  paused: boolean
  pauseReason: FreezePauseReason | ''
  pauseCount: number
  resumeCount: number
  lastPausedAt: number
  lastResumeAt: number
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
  /** 还没收到这一页的第一次心跳（启动 / reload 后）。期间恢复事件不得把 lastBeat 复位成 now */
  awaitingFirstBeat: boolean
  /** 渲染层报告页面 hidden（被完全遮挡）；与窗口 hide/minimize 分开记，重开开关时不能清掉 */
  rendererHidden: boolean
  heartbeatTimer: ReturnType<typeof setInterval> | null
  draftFlushResolve: ((ok: boolean) => void) | null
}

const states = new Map<number, Internals>()

/**
 * 设置项「页面无响应提示」的运行时镜像。默认 true；启动时由 attach 从设置读一次，
 * 之后由 `settings:update` / `settings:applyImport` 的唯一出口调 `setPromptEnabled()` 即时联动。
 * 关闭的是**无响应提示（含心跳巡检）**，崩溃恢复不经过这个变量。
 */
let watchEnabled = true
/** powerMonitor 是应用级单例：只在第一个窗口 attach 时接一次 */
let powerHooked = false

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

/** 窗口当前是否已经不该判活；返回的 reason 同时用于 pause 状态与日志 */
function windowPauseReason(win: BrowserWindow): 'window-minimized' | 'window-hidden' | null {
  if (win.isDestroyed()) return null
  return freezeWindowPauseReason({ minimized: win.isMinimized(), visible: win.isVisible() })
}

/** 进入暂停：只在状态真的变化时记一条日志，避免 250ms 巡检把日志刷满 */
function pauseWatch(_win: BrowserWindow, state: Internals, reason: FreezePauseReason): void {
  if (!state.paused || state.pauseReason !== reason) {
    state.paused = true
    state.pauseReason = reason
    state.pauseCount += 1
    state.lastPausedAt = Date.now()
    log(`paused=true window=${state.windowId} reason=${reason}`)
  }
}

/**
 * 恢复巡检：**先复位 `lastHeartbeatAt = now`**，再清暂停位。
 *
 * 这是"最小化 / 隐藏 20 秒后恢复，恢复瞬间绝不弹框"的唯一保证：如果不复位，
 * 恢复后的第一拍巡检（250ms 内）会拿最小化前的旧心跳算出 20s 的 age。
 * 复位后第一拍必然"活着"；真卡死仍会在 4.6s 后被抓到（那段时间心跳不会来）。
 */
function resumeWatch(win: BrowserWindow, state: Internals, source: string): void {
  if (win.isDestroyed()) return
  const now = Date.now()
  // 还没收到这一页的第一次心跳（启动 / reload 后）：不能把 lastBeat 置成 now，
  // 否则会把"渲染层还没起来"伪装成"刚刚活过"，绕过启动宽限。
  if (!state.awaitingFirstBeat) {
    const reset = planWatchResume(now)
    state.lastHeartbeatAt = reset.lastHeartbeatAt
  }
  // 仍然最小化 / 不可见 ⇒ 只复位计时，保持暂停（例如系统 resume 但窗口还在后台）
  const stillPaused = windowPauseReason(win)
  if (stillPaused) {
    pauseWatch(win, state, stillPaused)
    log(
      `resume window=${state.windowId} source=${source} still-paused=${stillPaused} lastBeat reset`
    )
    return
  }
  // 窗口可见 ≠ 页面可见：被完全遮挡时 Electron 仍报 visible，而渲染层已经把心跳停了。
  // 以渲染层的 visibility 报告为准，等它自己发 resume/心跳再恢复，避免恢复瞬间误报。
  if (state.rendererHidden) {
    pauseWatch(win, state, 'renderer-hidden')
    log(`resume window=${state.windowId} source=${source} still-renderer-hidden lastBeat reset`)
    return
  }
  if (state.paused) {
    state.paused = false
    state.pauseReason = ''
    state.resumeCount += 1
    state.lastResumeAt = now
  }
  log(`resume window=${state.windowId} source=${source} paused=false lastBeat reset`)
}

/** 应用级：系统休眠 / 锁屏时暂停所有窗口；恢复时逐个复位（窗口仍隐藏的保持暂停） */
function hookPowerMonitor(): void {
  if (powerHooked) return
  powerHooked = true
  const pauseAll = (reason: FreezePauseReason, source: string): void => {
    for (const state of states.values()) {
      if (state.win.isDestroyed()) continue
      pauseWatch(state.win, state, reason)
      log(`power ${source} window=${state.windowId}`)
    }
  }
  powerMonitor.on('suspend', () => pauseAll('system-suspend', 'suspend'))
  powerMonitor.on('lock-screen', () => pauseAll('screen-locked', 'lock-screen'))
  powerMonitor.on('resume', () => {
    for (const state of states.values()) resumeWatch(state.win, state, 'power-resume')
  })
  powerMonitor.on('unlock-screen', () => {
    for (const state of states.values()) resumeWatch(state.win, state, 'unlock-screen')
  })
}

/** 首屏/启动期的宽限：一次心跳都没见过时，`unresponsive` 事件不立刻弹窗 */
const FIRST_HEARTBEAT_GRACE_MS = 10_000

/**
 * 挂到一个窗口上：心跳巡检 + Electron 的 webContents 事件。
 * `createWindow()` 里调用一次；窗口关闭时自动清理。
 */
export function attachFreezeGuard(win: BrowserWindow): void {
  const wc = win.webContents
  // 启动时以持久化设置为准（关闭状态从第一个窗口起就不巡检；崩溃恢复仍然挂上）。
  try {
    watchEnabled = appSettings.readSettings().unresponsivePromptEnabled !== false
  } catch {
    watchEnabled = true
  }
  const state: Internals = {
    windowId: win.id,
    win,
    attachedAt: Date.now(),
    heartbeats: 0,
    lastHeartbeatAt: 0,
    lastRafFramesIn500ms: 0,
    lastVisible: true,
    watchEnabled,
    paused: !watchEnabled,
    pauseReason: watchEnabled ? '' : 'setting-disabled',
    pauseCount: 0,
    resumeCount: 0,
    lastPausedAt: 0,
    lastResumeAt: 0,
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
    awaitingFirstBeat: true,
    rendererHidden: false,
    heartbeatTimer: null,
    draftFlushResolve: null
  }
  states.set(win.id, state)
  hookPowerMonitor()
  // 窗口是 show:false 创建的：首帧前的"不可见"不能直接记成 pauseCount（那是正常的启动），
  // 但巡检本来也要等第一次心跳（primed）才判，所以这里只同步窗口真实状态。
  const initialPause = windowPauseReason(win)
  if (initialPause) pauseWatch(win, state, initialPause)

  /**
   * 心跳巡检：每 250ms 看一次。`HEARTBEAT_TIMEOUT_MS` 是 4600ms，所以检测落在
   * 4.6~4.85s（验收口径 ≤5s）。
   *
   * 门控顺序很重要：设置开关 → 窗口/系统/渲染层暂停 → reload → 心跳。
   * 命中门控时**连算都不算**，于是后台放多久都不会在恢复瞬间用陈旧心跳弹框。
   */
  state.heartbeatTimer = setInterval(() => {
    if (win.isDestroyed()) return
    if (!watchEnabled) return
    const windowPause = windowPauseReason(win)
    if (windowPause) {
      pauseWatch(win, state, windowPause)
      return
    }
    const decision = planFreezeCheck({
      nowMs: Date.now(),
      lastHeartbeatAt: state.lastHeartbeatAt,
      enabled: watchEnabled,
      paused: state.paused,
      reloading: state.reloading,
      episodeOpen: state.episodeOpen
    })
    if (decision.action === 'prompt') {
      noteUnresponsive(win, state, 'heartbeat', decision.ageMs)
    }
  }, HEARTBEAT_CHECK_MS)

  // ── 窗口状态门控：最小化 / 隐藏时暂停，恢复/显示/聚焦时先复位计时再恢复 ──
  win.on('minimize', () => pauseWatch(win, state, 'window-minimized'))
  win.on('hide', () => pauseWatch(win, state, 'window-hidden'))
  win.on('restore', () => resumeWatch(win, state, 'window-restore'))
  win.on('show', () => resumeWatch(win, state, 'window-show'))
  win.on('focus', () => resumeWatch(win, state, 'window-focus'))

  wc.on('unresponsive', () => {
    if (win.isDestroyed() || state.episodeOpen || state.reloading) return
    if (!watchEnabled) {
      log(`unresponsive ignored window=${win.id} reason=setting-disabled`)
      return
    }
    const windowPause = windowPauseReason(win)
    if (windowPause) {
      pauseWatch(win, state, windowPause)
      log(`unresponsive while hidden window=${win.id} (ignored)`)
      return
    }
    if (state.paused) {
      log(`unresponsive ignored window=${win.id} reason=paused:${state.pauseReason}`)
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
     * 先回到"等第一次心跳"的状态，否则 4.6s 后会把**正常的重载启动**判成无响应
     * （实测：崩溃自动重载后又弹一次「页面无响应」，纯属噪声）。
     */
    state.reloading = false
    state.lastHeartbeatAt = 0
    state.awaitingFirstBeat = true
    state.rendererHidden = false
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

/**
 * 设置项「页面无响应提示」的即时联动（由 `settings:update` 的唯一出口调用）。
 *
 * 关闭：巡检直接短路、弹框路径也会被 gate 住；**崩溃恢复完全不走这里**，仍然照旧
 * （`render-process-gone` → 首次自动重载一次）。重新打开：复位每个窗口的 lastBeat，
 * 避免拿关闭期间的旧心跳立刻弹一次 —— 与"恢复瞬间不弹框"同一条口径。
 */
export function setPromptEnabled(enabled: boolean): void {
  const next = enabled !== false
  if (next === watchEnabled) return
  watchEnabled = next
  log(`watch setting window=all enabled=${next ? 1 : 0}`)
  for (const state of states.values()) {
    state.watchEnabled = next
    if (state.win.isDestroyed()) continue
    if (!next) {
      pauseWatch(state.win, state, 'setting-disabled')
      continue
    }
    if (state.rendererHidden) {
      pauseWatch(state.win, state, 'renderer-hidden')
      continue
    }
    const windowPause = windowPauseReason(state.win)
    if (windowPause) {
      pauseWatch(state.win, state, windowPause)
      continue
    }
    if (state.paused) resumeWatch(state.win, state, 'setting-enabled')
    else log(`watch enabled window=${state.windowId} (no pause; lastBeat kept)`)
  }
}

/** 渲染层心跳（`freeze:heartbeat` 通道） */
export function noteHeartbeat(sender: WebContents, payload?: FreezeHeartbeatPayload): void {
  const state = stateForSender(sender)
  if (!state) return
  const now = Date.now()
  const first = state.awaitingFirstBeat
  state.awaitingFirstBeat = false
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
  // 心跳自己带着可见性：页面已 hidden（定时器还没被节流的那一拍）也立刻暂停，
  // 不依赖 visibilitychange 的 IPC 与主进程事件谁先到。
  if (payload?.visible === false) {
    state.rendererHidden = true
    pauseWatch(state.win, state, 'renderer-hidden')
  } else if (state.paused && state.pauseReason === 'renderer-hidden') {
    // 可见后的第一拍：复位计时（resumeWatch 内部做）再恢复。
    state.rendererHidden = false
    resumeWatch(state.win, state, 'renderer-visible')
  }
  if (first) log(`heartbeat online window=${state.windowId}`)
  // 心跳重新来了 ⇒ 这一轮无响应结束（哪怕用户还没点对话框）
  if (state.episodeOpen) markRecovered(state, 'heartbeat')
}

/**
 * 渲染层 `freeze:pause`：页面 hidden ⇒ 主进程暂停巡检与弹框。
 * 这条补的是"窗口 `isVisible()` 仍为 true、但页面被 Chromium 判为 hidden（完全遮挡）"。
 */
export function noteVisibilityPause(sender: WebContents): void {
  const state = stateForSender(sender)
  if (!state) return
  state.rendererHidden = true
  pauseWatch(state.win, state, 'renderer-hidden')
}

/** 渲染层 `freeze:resume`：页面可见 ⇒ 复位 lastBeat 后恢复巡检（恢复瞬间绝不弹框） */
export function noteVisibilityResume(sender: WebContents): void {
  const state = stateForSender(sender)
  if (!state) return
  state.rendererHidden = false
  resumeWatch(state.win, state, 'renderer-visible')
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
    watchEnabled: state.watchEnabled && watchEnabled,
    paused: state.paused,
    pauseReason: state.pauseReason,
    pauseCount: state.pauseCount,
    resumeCount: state.resumeCount,
    lastPausedAt: state.lastPausedAt,
    lastResumeAt: state.lastResumeAt,
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
  if (!watchEnabled || state.paused || state.promptOpen || state.episodeOpen) return
  if (win.isDestroyed()) return
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
  // 双保险：从"判定无响应"到真正弹框之间可能隔了几拍（对话框排队/事件循环忙），
  // 此刻若窗口已被最小化/隐藏、或用户刚关掉开关，就静默放弃这一轮 —— 恢复瞬间绝不弹框。
  const windowPause = windowPauseReason(win)
  if (!watchEnabled || state.paused || windowPause) {
    if (windowPause) pauseWatch(win, state, windowPause)
    state.episodeOpen = false
    log(
      `prompt suppressed window=${state.windowId} enabled=${watchEnabled ? 1 : 0} paused=${
        state.paused ? 1 : 0
      } reason=${windowPause ?? (state.pauseReason || 'none')}`
    )
    return
  }
  state.promptOpen = true
  state.prompts += 1
  state.lastPromptAt = Date.now()
  log(`showUnresponsive window=${state.windowId} count=${state.prompts}`)
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

  const decision = planCrashRecovery(now, state.autoCrashReloads, {
    enabled: watchEnabled,
    paused: state.paused
  })
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
