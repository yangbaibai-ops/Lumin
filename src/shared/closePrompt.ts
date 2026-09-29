// ─── 关窗时该不该问「是否保存更改？」（纯判定，可单测）──────────────────────────
//
// 用户口径（对齐 Typora 的**实测**行为）：自动保存默认关着；关窗时如果这篇文档有未保存的
// 改动，就弹一次「是否保存更改？／如果不保存，您的更改将会丢失。」（保存 / 不保存 / 取消）。
//
// 三条边界，缺一条就会出现"该问的不问、不该问的乱问"：
//   1. **自动保存开着 → 不问**：改动本来就在写盘路上（`flushAll` 会真的保存），
//      再问一次只是打断用户；这也正是 Typora 开着 Auto Save 时不弹提示的原因。
//   2. **没有未保存的改动 → 不问**：问了只会让用户以为丢了东西。
//   3. **系统关机/注销（`session-end`）→ 不问**：Windows 不会等用户点按钮，
//      弹出来只会把窗口卡在一条没人能回答的对话框上（那条路径的既有口径是"尽早落盘"，
//      见 `main/ipc.ts` 的 `attachCloseGuard`）。
//
// 为什么做成纯函数：这条规则同时被「默认保存方式」「退出路径」「系统关机」三处口径影响，
// 埋在 `requestClose` 里就只能靠真开关窗去试；提到这里毫秒级可测
// （`tests/closePrompt.test.mjs`）。
export type CloseReason = 'window' | 'quit' | 'session-end'

/**
 * 关窗前的动作：
 *   * `prompt` —— 先问「保存 / 不保存 / 取消」，拿到答案再决定要不要落盘；
 *   * `flush`  —— 没什么要问的，直接落盘放行（`files.flushAll()`）。
 */
export type ClosePlan = 'prompt' | 'flush'

export function planClosePrompt(input: {
  /** 设置里的「自动保存」（本项目出厂为 false = 手动保存） */
  autoSave: boolean
  /** 当前文档有没有未保存的改动（调用方负责先刷编辑器，账才准） */
  dirty: boolean
  reason: CloseReason
}): ClosePlan {
  if (input.reason === 'session-end') return 'flush'
  if (input.autoSave) return 'flush'
  return input.dirty ? 'prompt' : 'flush'
}
