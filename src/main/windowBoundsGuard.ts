// ─── 窗口 bounds 的主进程接线（事件、节流、防回环）──────────────────────────────
//
// 纯几何在 `windowBounds.ts`（有单测）；这里只做三件必须碰 electron 的事：
//   1. 拖动结束（moved）/尺寸改变（resized）后**节流 120ms** 检查一次：
//      如果窗口所在显示器的 scaleFactor 变了，用拖动前记录的 DIP 尺寸重新 setBounds；
//      没变就什么都不做（用户正常移动/缩放时零干扰）。
//   2. `display-metrics-changed`：分辨率/缩放/任务栏变化时同样检查；窗口被甩出所有
//      工作区时夹回主屏。
//   3. `display-added` / `display-removed`：拔掉副屏后落在屏幕外的窗口夹回主屏工作区。
//
// 防回环（自激）：
//   * 纠正前先把 `lastScale` 更新成新值 —— 纠正后的 `moved/resized` 再进来时 scale 相同，
//     不会再纠一次；
//   * `correcting` 标志 + `pendingCorrection` 记录刚写入的 bounds，事件里先比对，
//     相同就只清标记、不重复 setBounds（setBounds 是异步派发事件的，必须两道闸）。
//
// ⚠️ 模块求值时不碰 screen：`attachWindowBoundsGuard` 只在 whenReady 之后、窗口建好时调用。

import { BrowserWindow, screen } from 'electron'
import { intersectsAnyWorkArea, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from './windowPlacement'
import {
  clampBoundsToWorkArea,
  preserveDipSize,
  rectsClose,
  type Rect,
  type Size
} from './windowBounds'

const MIN_SIZE: Size = { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT }
/** 拖动/缩放后的检查节流：太少会跟手抖，太多会让跨屏那一下的跳变被看见 */
const BOUNDS_CHECK_DELAY_MS = 120
/** 纠正后这段时间内忽略自己 setBounds 派发的事件（事件可能跨多个 tick 到达） */
const CORRECTION_QUIET_MS = 400

interface GuardState {
  /** 上一次已知的显示器缩放；纠正时以它为“拖动前” */
  lastScale: number
  /** 上一次稳定时的 DIP 尺寸（跨屏时用它覆盖被系统改过的尺寸） */
  stableSize: Size
  /** 刚由我们写入的 bounds（用于识别自己触发的事件） */
  pendingCorrection: Rect | null
  /** 正在纠正（事件处理直接返回） */
  correcting: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const guards = new WeakMap<BrowserWindow, GuardState>()
let displayHooksInstalled = false

function writeBounds(win: BrowserWindow, state: GuardState, next: Rect): void {
  state.pendingCorrection = next
  state.correcting = true
  state.stableSize = { width: next.width, height: next.height }
  win.setBounds(next, false)
  setTimeout(() => {
    state.correcting = false
    // 静默期结束后补一次检查：若用户在纠正后 400ms 内又拖了一下，这次能接住；
    // 没动的话 pendingCorrection 与当前 bounds 相同，checkWindow 只会清标记。
    scheduleCheck(win)
  }, CORRECTION_QUIET_MS)
}

/**
 * 检查一个窗口：只有 **scaleFactor 变化** 才纠正（保持 DIP 尺寸）；
 * 同时兜底“窗口已经不在任何显示器上”（拔屏/改分辨率）。
 */
function checkWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
  const state = guards.get(win)
  if (!state || state.correcting) return

  const bounds = win.getBounds()
  // 自己 setBounds 的余波：认出来就丢掉，不做事
  if (state.pendingCorrection && rectsClose(bounds, state.pendingCorrection, 2)) {
    state.pendingCorrection = null
    return
  }

  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor
  if (Math.abs(scale - state.lastScale) < 1e-6) {
    // 没跨 DPI：只更新稳定尺寸。窗口正常移动/缩放时这里就是全部开销。
    state.stableSize = { width: bounds.width, height: bounds.height }
    // 极端情况：显示器被拔掉后窗口落在所有工作区之外（scale 恰好没变）
    if (
      !intersectsAnyWorkArea(
        bounds,
        screen.getAllDisplays().map((d) => d.workArea)
      )
    ) {
      const primary = screen.getPrimaryDisplay().workArea
      const next = clampBoundsToWorkArea(bounds, primary, MIN_SIZE)
      if (!rectsClose(bounds, next)) writeBounds(win, state, next)
    }
    return
  }

  // 跨 DPI：用**拖动前的 DIP 尺寸**，当前坐标，换算到新工作区
  const base: Rect = {
    x: bounds.x,
    y: bounds.y,
    width: state.stableSize.width,
    height: state.stableSize.height
  }
  const next = preserveDipSize(base, state.lastScale, scale, display.workArea, MIN_SIZE)
  state.lastScale = scale
  if (rectsClose(bounds, next, 0)) {
    state.stableSize = { width: bounds.width, height: bounds.height }
    return
  }
  writeBounds(win, state, next)
}

function scheduleCheck(win: BrowserWindow): void {
  const state = guards.get(win)
  if (!state || state.correcting) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = null
    checkWindow(win)
  }, BOUNDS_CHECK_DELAY_MS)
}

/**
 * 拔屏/加屏/分辨率变化后，把“已经不在任何工作区里”的窗口夹回主屏（纯函数复用）。
 * `removedArea` 有值时（`display-removed`），**原来压在那块屏上的窗口**也一并夹回主屏，
 * 即使它还残留一小条在主屏边缘 —— 否则标题栏可能停在已拔掉的屏幕上。
 */
function bringLostWindowsBack(removedArea?: Rect): void {
  const displays = screen.getAllDisplays()
  const areas = displays.map((d) => d.workArea)
  const primary = screen.getPrimaryDisplay().workArea
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.isMinimized()) continue
    const state = guards.get(win)
    if (!state) continue
    const bounds = win.getBounds()
    const onRemovedDisplay = !!removedArea && intersectsAnyWorkArea(bounds, [removedArea])
    if (!onRemovedDisplay && intersectsAnyWorkArea(bounds, areas)) continue
    if (win.isMaximized()) {
      // 最大化窗口的 bounds 是整块屏；原屏被拔掉后先还原再夹，避免“最大化在屏幕外”
      win.unmaximize()
    }
    const restored = win.getBounds()
    const next = clampBoundsToWorkArea(restored, primary, MIN_SIZE)
    if (!rectsClose(restored, next)) writeBounds(win, state, next)
  }
}

function installDisplayHooks(): void {
  if (displayHooksInstalled) return
  displayHooksInstalled = true
  screen.on('display-metrics-changed', () => {
    for (const win of BrowserWindow.getAllWindows()) checkWindow(win)
    bringLostWindowsBack()
  })
  screen.on('display-added', () => bringLostWindowsBack())
  screen.on('display-removed', (_event, display) => bringLostWindowsBack(display.workArea))
}

/**
 * 给窗口挂上跨屏 bounds 守卫。窗口关闭时自动清理定时器（WeakMap 项随之回收）。
 * 返回后即可调用 `resyncWindowBounds` 在程序化 setBounds（启动恢复）之后重置基线。
 */
export function attachWindowBoundsGuard(win: BrowserWindow): void {
  if (win.isDestroyed() || guards.has(win)) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  guards.set(win, {
    lastScale: display.scaleFactor,
    stableSize: { width: bounds.width, height: bounds.height },
    pendingCorrection: null,
    correcting: false,
    timer: null
  })
  installDisplayHooks()

  win.on('moved', () => scheduleCheck(win))
  win.on('resized', () => scheduleCheck(win))
  win.on('closed', () => {
    const state = guards.get(win)
    if (state?.timer) clearTimeout(state.timer)
    guards.delete(win)
  })
}

/**
 * 程序化 setBounds 之后重置基线（启动时 applyWindowSeed 把窗口从主屏默认位置挪到
 * “上次所在显示器”的保存位置，那一下不该被当成跨屏拖动）。
 */
export function resyncWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const state = guards.get(win)
  if (!state) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  state.lastScale = display.scaleFactor
  state.stableSize = { width: bounds.width, height: bounds.height }
  state.pendingCorrection = null
  state.correcting = false
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
}

// ─── 验收用的调试钩子（仅未打包 + LUMIN_WINDOW_DEBUG=1 时安装）──────────────────
//
// 单屏机器没法真的改 DPI，但验收要求“脚本 setBounds 模拟跨屏变大，再触发一次纠正”。
// 这个钩子把**真实的 checkWindow 路径**暴露给主进程 inspector，只做读/写 bounds 与把
// lastScale 临时改成指定值；生产路径不会安装（index.ts 里由 !app.isPackaged + 环境变量把关）。

interface WindowDebugSnapshot {
  bounds: Rect
  stableSize: Size
  scaleFactor: number
  workArea: Rect
  displays: Array<{ id: number; scaleFactor: number; bounds: Rect; workArea: Rect }>
}

interface WindowDebugApi {
  snapshot(): WindowDebugSnapshot | null
  setBounds(bounds: Rect): Rect | null
  simulateScaleChange(previousScaleFactor: number): {
    before: Rect
    after: Rect
    stableBefore: Size
    actualScaleFactor: number
  } | null
}

function firstWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
}

export function installWindowDebugHook(): void {
  const host = globalThis as unknown as { __luminWindowDebug?: WindowDebugApi }
  if (host.__luminWindowDebug) return
  host.__luminWindowDebug = {
    snapshot() {
      const win = firstWindow()
      if (!win) return null
      const state = guards.get(win)
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      return {
        bounds,
        stableSize: state?.stableSize ?? { width: bounds.width, height: bounds.height },
        scaleFactor: display.scaleFactor,
        workArea: display.workArea,
        displays: screen.getAllDisplays().map((d) => ({
          id: d.id,
          scaleFactor: d.scaleFactor,
          bounds: d.bounds,
          workArea: d.workArea
        }))
      }
    },
    setBounds(bounds) {
      const win = firstWindow()
      if (!win) return null
      win.setBounds(bounds, false)
      return win.getBounds()
    },
    simulateScaleChange(previousScaleFactor) {
      const win = firstWindow()
      if (!win) return null
      const state = guards.get(win)
      if (!state) return null
      const before = win.getBounds()
      const actual = screen.getDisplayMatching(before).scaleFactor
      const stableBefore = { ...state.stableSize }
      // 把“拖动前缩放”改掉，再走与真实事件完全相同的 checkWindow
      state.lastScale = previousScaleFactor
      state.correcting = false
      state.pendingCorrection = null
      checkWindow(win)
      const after = win.getBounds()
      // 单屏没有真的换显示器：把基线还原，避免后续事件反复纠正
      state.lastScale = actual
      return { before, after, stableBefore, actualScaleFactor: actual }
    }
  }
}
