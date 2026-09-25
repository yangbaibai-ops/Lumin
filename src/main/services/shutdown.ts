// ─── 退出/关机路径的状态（不 import electron，可直接单测）─────────────────────
//
// 为什么要有这个文件：审计 §2 P2「系统关机/注销路径未处理 —— 全仓无 `app.on('session-end')`」。
//
// 关机/注销时 Windows **不会**给我们"等渲染层把草稿写完"的时间，也不会走正常的
// `before-quit` → 逐窗 `close` 那条路。能做的只有一件事：**尽快**告诉所有窗口
// "现在开始落盘"，让草稿与保存尽早发出去（草稿本身是原子写的，半途被杀不会留下坏文件）。
//
// 状态放在 shared 之外但**不碰 electron**，是为了让"只广播一次"这条语义能被单测钉住：
// `session-end` 与 `before-quit` 有可能先后到达（注销时两者都会来），重复广播会让每个窗口
// 把 `flushAll()` 跑两遍。
export type ShutdownReason = 'session-end' | 'before-quit'

let reason: ShutdownReason | null = null
const listeners = new Set<(r: ShutdownReason) => void>()

/** 订阅"开始退出了"（返回取消订阅）。监听器抛错不影响其它监听器与退出流程。 */
export function onShutdown(fn: (r: ShutdownReason) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 标记"开始退出"。**只在第一次生效**（返回 true）——`before-quit` 可能被触发多次
 * （例如用户连点两次关闭），重复广播等于让每个窗口多做一遍 flushAll。
 */
export function beginShutdown(r: ShutdownReason): boolean {
  if (reason) return false
  reason = r
  for (const fn of listeners) {
    try {
      fn(r)
    } catch {
      /* 某个监听器失败不该拦住其它监听器（退出路径上必须尽力而为） */
    }
  }
  return true
}

/** 当前的退出原因（没在退出 = null） */
export function shutdownReason(): ShutdownReason | null {
  return reason
}

/** 只在测试里用：把状态复位（真实运行里退出是不可逆的） */
export function resetShutdownForTest(): void {
  reason = null
  listeners.clear()
}
