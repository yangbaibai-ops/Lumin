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

/**
 * 「这次落下是不是把**数学节点**搬走」——要拦。
 *
 * 为什么需要单独一条（第九轮用户口径「公式也不可以通过拖拽拖动位置」）：
 *   * ProseMirror **故意**让"被选中的叶子节点"变成可拖（`NodeViewDesc.selectNode()`：
 *     `if (this.contentDOM || !this.node.type.spec.draggable) this.nodeDOM.draggable = true`）——
 *     所以 `mathBlock` 就算写了 `draggable: false`，**点一下选中它之后** `.md-math-block`
 *     的 `draggable` 属性也会变成 true（实测）；
 *   * 选中态下再按下鼠标，PM 会给这次 mousedown 记 `mightDrag`，`dragstart` 于是把这次拖动
 *     当**节点拖动**（`view.dragging.node` = 一个 NodeSelection），而不是"搬一段文字"；
 *   * 而 `blocksInternalTextDrag` 的既定口径是**节点拖动一律放行**（图片/表格要靠它搬位置），
 *     于是数学节点被顺带放行了 —— 实测拖一下，`$$\n\frac{a}{b}\n$$` 整块跑到了别的段落之间。
 *
 * 判据只有两个布尔量，所以放在这里穷举（与上一条同一套路）：`mathDrag` 由调用方
 * 从 `view.dragging` 里认（节点类型是 `mathBlock` ⇒ 数学节点）。**只认数学节点**，
 * 图片/表格的 `nodeDrag` 依旧走上面那条"放行"的口径。
 */
export function blocksMathDrag(moved: boolean, mathDrag: boolean): boolean {
  return moved && mathDrag
}
