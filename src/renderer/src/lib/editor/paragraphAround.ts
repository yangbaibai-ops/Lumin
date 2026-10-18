/**
 * 「在当前块的上方 / 下方插入一个空段落」——右键菜单「插入」里的两项。
 *
 * 目的：代码块在文档最开头、表格在文档最末尾、图片/公式后面没有可点的位置时，
 * 用户没有地方落光标（写不进去）。这里给一个显式出口：取**选区所在的顶层块**，
 * 在它**前面或后面**插一个段落，并把光标放进新段落。
 *
 * 三条硬约束（实现时不能走偏）：
 *   1) 插入点必须是**顶层兄弟位置**（`0..doc.content.size`），绝不能进表格单元格、
 *      代码块内部、列表项里 —— 否则「挤出一个可写位置」就变成了「把段落塞进块里」；
 *   2) 上文/下文都按**顶层节点**算：光标在表格单元格里 ⇒ 整张表；在嵌套列表项里 ⇒
 *      整个列表；NodeSelection 选中图片 ⇒ 图片所在的顶层段落（图片是行内节点）；
 *   3) 只产出一个事务（insert + setSelection 同一个 tr），由调用方一次 dispatch
 *      ⇒ 默认进 PM 历史，Ctrl+Z 一次即可撤销。
 */
import type { Node as PmNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'

export type ParagraphSide = 'above' | 'below'

/** 选区命中的顶层块：`index` 是它在 doc 里的序号，`pos` 是它的起始位置 */
export interface TopLevelBlock {
  index: number
  pos: number
  node: PmNode
}

/** 上方/下方插入的计算结果（`caretPos` 是**插入之后**新段落内的光标位置） */
export interface ParagraphInsertion {
  block: TopLevelBlock
  /** 插入空段落的顶层位置（上方 = 块起点；下方 = 块起点 + nodeSize） */
  insertPos: number
  /** 插入后新段落内容区的起点（`insertPos + 1`） */
  caretPos: number
}

/**
 * 取 `from` 落在哪个**顶层块**上。
 *
 * 位置可能来自三种选区：
 *   * TextSelection：`from` 在某个文本块内部 —— 沿祖先链取 `index(0)` 即可；
 *   * NodeSelection：`from` 就是被选节点的**起点**（顶层节点时解析深度为 0）——
 *     此时 `index(0)` 正好指向被选中的那个节点，符合「以选中节点为准」；
 *   * 文档末尾（`from === doc.content.size`）：解析结果没有「后一个节点」，
 *     收敛到最后一个块（下方插入仍然能落在文档末尾之外）。
 */
export function topLevelBlockAt(doc: PmNode, from: number): TopLevelBlock | null {
  const total = doc.childCount
  if (total === 0) return null
  const clamped = Math.max(0, Math.min(from, doc.content.size))
  const $from = doc.resolve(clamped)
  let index = clamped >= doc.content.size ? total - 1 : $from.index(0)
  if (index < 0 || index >= total) index = total - 1
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
  return { index, pos, node: doc.child(index) }
}

/** 计算「在顶层块上方/下方插入空段落」的插入点与插入后的光标位置；空文档返回 null */
export function paragraphInsertion(
  doc: PmNode,
  from: number,
  side: ParagraphSide
): ParagraphInsertion | null {
  const block = topLevelBlockAt(doc, from)
  if (!block) return null
  const insertPos = side === 'above' ? block.pos : block.pos + block.node.nodeSize
  // 空段落插入后占 [insertPos, insertPos + 2)，内容区起点是 insertPos + 1
  return { block, insertPos, caretPos: insertPos + 1 }
}

/**
 * 生成「插入空段落 + 光标进入新段落」的事务（**不 dispatch**，便于单测与复用）。
 * 返回 null：文档为空 / schema 没有 paragraph 节点。
 */
export function createParagraphAroundTransaction(
  state: EditorState,
  side: ParagraphSide
): Transaction | null {
  const target = paragraphInsertion(state.doc, state.selection.from, side)
  const paragraph = state.schema.nodes.paragraph
  if (!target || !paragraph) return null
  const tr = state.tr.insert(target.insertPos, paragraph.create())
  // 光标落进新段落的内容区；用 create 而不是 near —— 目标位置一定合法且稳定
  tr.setSelection(TextSelection.create(tr.doc, target.caretPos))
  return tr
}

/** 动作入口：一次事务完成插入 + 选区，默认进历史（Ctrl+Z 一次可撤销） */
export function insertParagraphAround(
  host: { state: EditorState; view: { dispatch(tr: Transaction): void } },
  side: ParagraphSide
): boolean {
  const tr = createParagraphAroundTransaction(host.state, side)
  if (!tr) return false
  host.view.dispatch(tr)
  return true
}
