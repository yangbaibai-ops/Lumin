// ─── 「拖动选中的文字去改位置」要不要拦：**纯谓词**（无依赖，单测直接跑）───────────
//
// 语义与理由写在 lib/editor/noTextDrag.ts（ProseMirror 钩子那一侧）；这里只留判据本身，
// 因为它只有两个输入，正好是"运行时要靠 CDP 才验得到、而判据本身必须一目了然"的那类规则。
//
// 输入来自 prosemirror-view 的 `handleDrop(view, event, slice, moved)`：
//   * `moved` —— PM 在 `editHandlers.drop` 里算好的 `!!(view.dragging && dragMoves(view, event))`：
//       - 拖动源在**本文档内**（PM 自己的 dragstart 设过 `view.dragging`）→ true；
//       - 从系统拖入文件、从别的程序拖入文字（没有 `view.dragging`）→ false；
//       - Ctrl/Cmd + 内部拖动（复制语义，`dragMoves` 返回 false）→ false。
//   * `nodeDrag` —— `view.dragging.node` 非空 = 这次拖的是**节点**（图片/表格等 NodeView），
//     不是一段文字。用户报的是"搬文字"，节点的拖动语义不在本轮范围内，必须放行。
export function blocksInternalTextDrag(moved: boolean, nodeDrag: boolean): boolean {
  return moved && !nodeDrag
}
