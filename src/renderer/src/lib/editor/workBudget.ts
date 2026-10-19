// ─── 文档变更后"重活"的统一预算 + 看门狗 + 长任务哨兵 ────────────────────────────
//
// 用户口径（第二次复报）：「还是会卡死，粘贴的内容很普通（两张表 + 任务清单 + 嵌套列表）」。
//
// 实测真因不在粘贴处理本身（那份 8–10 KB 的正文体积远低于任何规模护栏），而在
// **粘贴之后的连锁**：一次粘贴 = 一次 docChanged，之后 250 ms 内会依次跑
// `onUpdate → flushSync → getMarkdown`（整篇 Markdown 序列化）、状态栏字数统计、
// 以及 500 ms 防抖的中文拼写重算。这些都在主线程上**同步**执行，
// 而它们全都不在 `pasteGuard` 的覆盖范围里（护栏只包住 `handlePaste`，
// 且只在"粘贴那一刻"判规模）。
//
// 本模块给这一类工作一个**统一账本**，三件事：
//   ① 预算（`runBudgeted`）：每次重活记耗时；超预算 ⇒ 记一笔 + 进入**冷却**，
//      宿主可以据此**可见告知**用户（"后台统计/拼写检查已放慢"），
//      但**结果照常返回** —— 绝不为了不卡而丢内容；
//   ② 断路器（`shouldDeferHeavyWork`）：冷却期内，**可选**重活（拼写检查、
//      大纲/统计重算）延后执行，而不是继续叠加；
//   ③ 哨兵（`installLongTaskSentinel`）：>200 ms 的同步任务记一条日志（环形缓冲
//      20 条 + 计数），下次再卡死时 `window.__LWORK` 里直接能看到规模与时刻。
//
// 为什么不做"超预算就中断"：ProseMirror 的粘贴/序列化都是**同步**调用，主线程上
// 没有可中断点；能中断的只有异步任务。所以这里的语义是"**事后判定 + 降级后续**"，
// 真正的防线是让重活**别叠加**（冷却 + 延后），以及让下一次定位有数据。
//
// ⚠️ 本模块**不 import i18n / 任何 UI 层**：它要能被 `node --test` 直接加载
// （文案由宿主按语言包拼，见 components/editor/TyporaEditor.vue）。

/** 单次重活的预算（ms）。超过就认为"这一次已经很重了"，后续可选重活延后 */
export const HEAVY_WORK_BUDGET_MS = 120
/** 长任务判定阈值（与 e2e 验收口径一致：>200 ms 的同步任务） */
export const LONG_TASK_MS = 200
/** 超预算后的冷却时长：这段时间里可选重活让路 */
export const HEAVY_WORK_COOLDOWN_MS = 2000
/** 环形缓冲长度（只留最近的长任务，不记内容） */
const RING = 20

export interface WorkBudgetStats {
  /** 记账次数 */
  runs: number
  /** 超预算次数 */
  overruns: number
  /** 最近一次重活的耗时（ms） */
  lastMs: number
  /** 最近一次重活的名字 */
  lastName: string
  /** 冷却截止时刻（performance.now 口径；0 = 没在冷却） */
  deferUntil: number
  /** 因冷却被延后的可选重活次数 */
  deferred: number
  /** 观察到的主线程长任务数（>200 ms） */
  longTasks: number
  /** 最近一次长任务时长（ms） */
  lastLongMs: number
  /** 最近一次长任务的开始时刻（performance.now 口径） */
  lastLongStart: number
  /** 最近的长任务（最多 20 条，{start,dur}） */
  recent: Array<{ start: number; dur: number }>
}

const stats: WorkBudgetStats = {
  runs: 0,
  overruns: 0,
  lastMs: 0,
  lastName: '',
  deferUntil: 0,
  deferred: 0,
  longTasks: 0,
  lastLongMs: 0,
  lastLongStart: 0,
  recent: []
}

/** 只读统计（验收/诊断用；与 perfProbe 的 `window.__LPERF` 同一手法） */
export function workBudgetStats(): Readonly<WorkBudgetStats> {
  return stats
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 本次生效的单次预算。
 *
 * 允许测量实例通过 `window.__LUMIN_WORK_BUDGET_MS` 覆盖（与 `pasteGuard` 的
 * `__LUMIN_PASTE_WATCHDOG_MS` 同一手法：**只在测量实例里设**，生产路径没有这个键）。
 * 非法值一律回落默认 —— 绝不能让这个键把护栏关掉（比如设成 Infinity）。
 */
function budgetMs(): number {
  try {
    const raw = (window as unknown as { __LUMIN_WORK_BUDGET_MS?: unknown }).__LUMIN_WORK_BUDGET_MS
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    /* 非浏览器环境（单测 import）：用默认值 */
  }
  return HEAVY_WORK_BUDGET_MS
}

/** 冷却中？⇒ 可选重活应延后（返回 true 的一方负责安排稍后重试，不许静默丢） */
export function shouldDeferHeavyWork(): boolean {
  if (!stats.deferUntil) return false
  if (now() < stats.deferUntil) return true
  stats.deferUntil = 0
  return false
}

/** 记一次"被延后"（只用于统计；调用方必须真的排一次重试） */
export function noteHeavyWorkDeferred(): void {
  stats.deferred += 1
}

export interface RunBudgetedOptions {
  /** 本次预算（默认 `HEAVY_WORK_BUDGET_MS`） */
  budgetMs?: number
  /**
   * 超预算时回调（宿主用来**可见告知**）。**不改变返回值**：
   * 内容正确性优先，这条路径永远把 `fn` 的结果交回去。
   */
  onOver?: (name: string, ms: number) => void
  /** 超预算是否进入冷却（默认 true）。`false` 用于"必须跑、但不想影响别人"的收尾 */
  cooldown?: boolean
}

/**
 * 跑一次"重活"并记账。**返回 `fn` 的结果**（异常原样抛出，不吞）。
 *
 * 语义刻意做成"旁路记账"：无论超不超预算，业务结果都一样 —— 超预算只影响
 * ① 统计 ② 冷却（后续可选重活让路）③ 宿主提示。这样既不会因为"降级"丢内容，
 * 也不会让一次重活变成连锁重活的起点。
 */
export function runBudgeted<T>(name: string, fn: () => T, opts: RunBudgetedOptions = {}): T {
  const budget = opts.budgetMs ?? budgetMs()
  const t0 = now()
  try {
    return fn()
  } finally {
    const ms = Math.round((now() - t0) * 10) / 10
    stats.runs += 1
    stats.lastMs = ms
    stats.lastName = name
    if (ms > budget) {
      stats.overruns += 1
      if (opts.cooldown !== false) stats.deferUntil = now() + HEAVY_WORK_COOLDOWN_MS
      if (opts.onOver) {
        try {
          opts.onOver(name, ms)
        } catch {
          /* 提示失败不影响业务 */
        }
      }
    }
  }
}

/**
 * 长任务哨兵：>200 ms 的同步任务记一条（控制台 + `window.__LWORK`）。
 * 返回卸载函数（热更新 / 单测隔离用）。环境不支持 `PerformanceObserver` 时静默返回空函数。
 */
export function installLongTaskSentinel(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = Math.round(entry.duration)
        if (dur < LONG_TASK_MS) continue
        stats.longTasks += 1
        stats.lastLongMs = dur
        stats.lastLongStart = Math.round(entry.startTime)
        stats.recent.push({ start: Math.round(entry.startTime), dur })
        if (stats.recent.length > RING) stats.recent.shift()
        // 只记"多长 / 什么时候"，绝不记文档内容（大 base64 绝不进日志）。
        // 诊断文案走 ASCII：`tests/i18nHardcoded.test.mjs` 要求界面文案进语言包，
        // 而控制台诊断不是界面文案 —— 让它一眼能看出"不是本地化文本"。
        try {
          console.warn(`[lumin] long task ${dur}ms @${Math.round(entry.startTime)}ms`)
        } catch {
          /* 控制台不可用：忽略 */
        }
      }
    })
    obs.observe({ type: 'longtask', buffered: true })
    return () => obs.disconnect()
  } catch {
    return () => {}
  }
}

/** 把统计挂到 window（诊断/验收；e2e 直接读 `window.__LWORK`） */
export function exposeWorkBudget(): void {
  try {
    ;(window as unknown as { __LWORK?: WorkBudgetStats }).__LWORK = stats
  } catch {
    /* 非浏览器环境（单测 import）：忽略 */
  }
}
