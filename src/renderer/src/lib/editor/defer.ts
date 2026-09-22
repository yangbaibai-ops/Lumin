// ─── 「躲开 ProseMirror 事件顺序」的延后一拍 ──────────────────────────────────
//
// 为什么需要这个模块（清单 §1.D / 自查报告 S3 第一期）：编辑器里有一批 `setTimeout(fn, 0)`
// **不是防抖、也不是节流**，而是「必须等 ProseMirror 自己那一轮处理跑完再动手」。典型两类：
//
//   ① **同步 dispatch 会被 PM 覆盖**：`handleDOMEvents` 之后 PM 还有自己的 MouseUp 处理，
//      它会按自己的算法再把选区写一遍。实测：点一行行尾空白时 `posAtCoords` 明明给出**块尾**，
//      最终光标却停在收尾 `**` 之前 —— 就是被 PM 那一步覆盖的（见 typoraInlineMarks.ts 的
//      `handleDOMEvents.mouseup`）。
//   ② **判据与落点必须分家**：松手瞬间 `.press-hidden` 解除、显隐装饰重算，整行会左右移动，
//      所以几何判据要在**点击当时的布局**上同步量；而落点要延后写。
//
// 为什么不能就地写 `setTimeout(…, 0)`：这类调用散在十几处，每处都得重读一遍注释才敢改，
// 注释还在各处漂移。收口到这里之后，「为什么必须延后」只有一处解释。
//
// 语义与边界：
//   * `setTimeout(fn, 0)` = 排在**当前宏任务之后**的第一个宏任务里跑；
//     不能用微任务（`queueMicrotask`/`Promise.then`）—— 微任务仍在本轮 PM 事件处理内，躲不开。
//   * 返回 `cancel()`：组件卸载 / 视图销毁时撤销，避免对已销毁的视图动手。
//   * 本模块**不**替你判 `view.isDestroyed`：那属于调用点的上下文，helper 保持无依赖（可单测）。
export function deferAfterPmEvent(fn: () => void): () => void {
  const id = setTimeout(fn, 0)
  return () => clearTimeout(id)
}
