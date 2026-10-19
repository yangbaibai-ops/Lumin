// ─── 渲染进程内的「全局同步任务哨兵」（比 workBudget 更广）───────────────────────
//
// workBudget 的长任务哨兵只认 `PerformanceObserver` 的 longtask（>200ms），而真实
// 卡死常常发生在**一段同步代码里**（PM 解析、序列化、DOMParser…）：这段时间主线程
// 不跑任何回调，longtask 可能要等它结束才上报，甚至因为浏览器实现差异漏报。
//
// 这里用最笨也最可靠的办法：一个 1s 的 `setInterval`，记相邻两次 tick 的间隔。
// 间隔 >2s ⇒ 说明中间有一段时间主线程被同步代码占着。**代码还能跑到这一行，说明
// 已经恢复了** —— 所以这个哨兵不负责中断（JS 做不到），只负责：
//   ① 卡完能自愈（后续任务照常跑）；
//   ② 留下可定位证据：`window.__LWORK.freezes` 追加 `{at,durationMs,stackHint}`，
//      并弹一条可见提示（"刚刚有一次长时间阻塞，已记录"）。
//
// 判据/环形上限都是纯函数（shared/freeze.ts 的 detectFreezeGap），单测直接钉。
//
// ⚠️ 窗口不可见时浏览器会把定时器降到 ~1/min，那不是"卡死"：所以只在
// `document.visibilityState === 'visible'` 时判定（隐藏期间只更新 lastTickAt）。
import { detectFreezeGap, FREEZE_TICK_MS, type FreezeRecord } from '../../../../shared/freeze'
import { noteFreeze, workBudgetStats } from './workBudget'

export interface FreezeSentinelOptions {
  /** tick 间隔（默认 1000ms；测量实例可覆盖） */
  intervalMs?: number
  /** 判定阈值（默认 2000ms；测量实例可覆盖） */
  gapMs?: number
  /** 发现一次阻塞（宿主用来弹可见提示；不改变记录行为） */
  onFreeze?: (record: FreezeRecord) => void
  /** 额外线索（例如当前编辑器模式）；不得包含文档内容 */
  hint?: () => string
}

/** 只装一次（HMR / 多次调用不会叠出多个定时器） */
let installed = false
let uninstall: (() => void) | null = null

/** 生成定位线索：最后一笔重活 + 最近长任务 + 当前调用栈的头部帧（都不含正文） */
function buildStackHint(extra?: () => string): string {
  const stats = workBudgetStats()
  const stack = (() => {
    try {
      return (new Error().stack ?? '')
        .split('\n')
        .slice(2, 5)
        .map((s) => s.trim().replace(/^at\s+/, ''))
        .join(' <- ')
        .slice(0, 240)
    } catch {
      return ''
    }
  })()
  const parts = [
    stats.lastName ? `lastHeavy=${stats.lastName}(${stats.lastMs}ms)` : 'lastHeavy=none',
    stats.lastLongMs
      ? `lastLongTask=${stats.lastLongMs}ms@${stats.lastLongStart}`
      : 'lastLongTask=none',
    extra ? extra() : '',
    stack ? `stack=${stack}` : ''
  ].filter(Boolean)
  return parts.join('; ').slice(0, 400)
}

/**
 * 装哨兵。返回卸载函数（单测/热更新用）。
 * 非浏览器环境（node --test 直接 import 本文件）静默返回空函数。
 */
export function installFreezeSentinel(opts: FreezeSentinelOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof setInterval === 'undefined') return () => {}
  if (installed) return uninstall ?? (() => {})
  installed = true

  const intervalMs = Math.max(250, Math.round(opts.intervalMs ?? FREEZE_TICK_MS))
  const gapMs = Math.max(500, Math.round(opts.gapMs ?? 2000))
  let lastTickAt = Date.now()
  let hiddenSince = 0

  const timer = setInterval(() => {
    const now = Date.now()
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    if (!visible) {
      // 隐藏期间定时器会被浏览器节流：只推进基线，绝不判"卡死"
      hiddenSince = hiddenSince || now
      lastTickAt = now
      return
    }
    if (hiddenSince) {
      // 刚回到可见：第一拍只重建基线（后台暂停不是同步阻塞）
      hiddenSince = 0
      lastTickAt = now
      return
    }
    const record = detectFreezeGap(lastTickAt, now, {
      gapMs,
      stackHint: buildStackHint(opts.hint)
    })
    lastTickAt = now
    if (!record) return
    noteFreeze(record)
    try {
      console.warn(
        `[lumin] main-thread freeze ${record.durationMs}ms @${record.at}; see window.__LWORK.freezes`
      )
    } catch {
      /* 控制台不可用：忽略 */
    }
    try {
      opts.onFreeze?.(record)
    } catch {
      /* 提示失败不影响记录 */
    }
  }, intervalMs)

  uninstall = () => {
    clearInterval(timer)
    installed = false
    uninstall = null
  }
  return uninstall
}
