// ─── 在飞的原子写 + 退出闸（用户报障：关窗保存后残留 `<doc>.<8hex>.lumin-tmp`）──────
//
// 报障现场（真机复现，2026-10-20）：
//   输入 → Ctrl+W → 原生弹窗点「保存」→ 目标文件内容正确，但同目录留下
//   `数学公式示例.md.<8hex>.lumin-tmp`，直到下次启动才被扫掉。
//
// 根因有两层（证据见提交说明）：
//   1. `useAppActions()` 被 App.vue 与 CommandPalette.vue **各调用一次** ⇒
//      `app:before-close` 被处理两次 ⇒ 两个 `requestClose` 同时走「保存」分支，
//      第二份保存的 `file:write` 在窗口销毁/进程退出时才落地；
//   2. 主进程退出**不等待**在飞的写：`before-quit` 立刻放行，第二次写的
//      `writeFile` 已经写出临时文件，但 `fsync/rename/finally 清理` 全都没来得及跑。
//
// 本模块负责第 2 层的结构性兜底（不 import electron，`node --test` 可直接跑）：
//   * `beginAtomicWrite/endAtomicWrite`：`services/atomicWrite.ts` 每次进入/离开（含清理）
//     时记账 —— 计数归零代表"磁盘上不会再有半成品临时文件"；
//   * `drainAtomicWrites`：等到计数**连续 `idleMs` 保持 0** 才放行（不是"某一眼为 0"）——
//     窗口销毁瞬间仍可能有 IPC 正在路上，只看一眼会漏；
//   * `quitDrainComplete/markQuitDrained/resetQuitDrain`：`before-quit` 会被触发多次，
//     用这个闸保证"每一轮退出只排空一次"；用户在关窗确认里点「取消」时由
//     `app:cancelClose` 复位，否则下一次退出会跳过排空。
//
// ⚠️ 超时是必要的恶：挂死的 IO 不该让用户"关不掉应用"。超时后如实打一行日志再退出，
// 残留由启动清扫（只清本应用创建、年龄 > 10 分钟、同目录有目标的）兜底。

/** 计数归零后还要观察多久才算"真的没有新的写进来了"（毫秒） */
export const QUIT_DRAIN_IDLE_MS = 150

/** 退出路径上最多等这么久（毫秒）；超过就放行，残留交给启动清扫 */
export const QUIT_DRAIN_TIMEOUT_MS = 5000

let active = 0
let idleWaiters: Array<() => void> = []
let quitDrained = false

/** 一次原子写开始（含它后面的 fsync / rename / 临时文件清理） */
export function beginAtomicWrite(): void {
  active += 1
}

/** 一次原子写结束（`atomicWrite` 的 finally 里调用；失败也要调用） */
export function endAtomicWrite(): void {
  if (active > 0) active -= 1
  if (active !== 0) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve()
}

/** 当前在飞的原子写数量（诊断/测试/日志用） */
export function pendingAtomicWrites(): number {
  return active
}

/** 等到计数为 0（不含"安静观察期"；`drainAtomicWrites` 才含） */
export function waitForAtomicWritesIdle(timeoutMs = QUIT_DRAIN_TIMEOUT_MS): Promise<boolean> {
  if (active === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let waiter: (() => void) | null = null
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (waiter) idleWaiters = idleWaiters.filter((w) => w !== waiter)
      resolve(ok)
    }
    waiter = () => finish(true)
    timer = setTimeout(() => finish(false), timeoutMs)
    idleWaiters.push(waiter)
  })
}

/**
 * 退出前排空：先等在飞的写结束，再要求计数**连续 `idleMs` 保持 0**（给"正在路上的 IPC"
 * 一个落地窗口），总计不超过 `timeoutMs`。
 *
 * 返回 `{ ok, pending }`：`ok:false` 表示等到超时仍没安静下来 —— 调用方记日志后照常退出。
 */
export async function drainAtomicWrites(
  timeoutMs = QUIT_DRAIN_TIMEOUT_MS,
  idleMs = QUIT_DRAIN_IDLE_MS
): Promise<{ ok: boolean; pending: number }> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let quietSince = pendingAtomicWrites() === 0 ? Date.now() : 0
  for (;;) {
    const pending = pendingAtomicWrites()
    if (pending === 0) {
      if (quietSince === 0) quietSince = Date.now()
      if (Date.now() - quietSince >= idleMs) return { ok: true, pending: 0 }
    } else {
      quietSince = 0
    }
    if (Date.now() >= deadline) return { ok: pending === 0, pending }
    // 有写在进行时就等它结束（事件驱动），没有写时只睡一小步来累计安静期
    const left = Math.max(1, deadline - Date.now())
    await (pending > 0
      ? waitForAtomicWritesIdle(left)
      : new Promise((resolve) => setTimeout(resolve, Math.min(25, left))))
  }
}

/** 这一轮退出是否已经排空过（`before-quit` 会因 `app.quit()` 重入） */
export function quitDrainComplete(): boolean {
  return quitDrained
}

/** 排空完成、即将真正退出 */
export function markQuitDrained(): void {
  quitDrained = true
}

/** 用户取消了这一轮退出（关窗确认里点「取消」）：下一轮必须重新排空 */
export function resetQuitDrain(): void {
  quitDrained = false
}

/** 只在单测里用：把计数与闸复位（真实运行里退出是不可逆的） */
export function resetWriteDrainForTest(): void {
  active = 0
  idleWaiters = []
  quitDrained = false
}
