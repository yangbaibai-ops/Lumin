// ─── 「设置当前列对齐」的唯一实现入口（工具栏 / 右键菜单都走这里）──────────────
//
// 审计缺口：`tableAlign.ts` 原来只有**写回**规则（解析出来的 align 怎么写回 `:---`），
// 没有任何地方能**改**某一列的对齐 —— grep `setCellAttribute` 为 0，界面上也就无从下手。
// 这里补上那条链：ProseMirror 选区 → 列号 → 该列每个单元格的 attrs.align →（序列化）
// `:---` / `:---:` / `---:` 分隔行。
//
// ── 为什么必须改**整列**，而不是只改光标那一格 ────────────────────────────────
//
// 序列化只从**表头行**取 align 写分隔行（见 tableMarkdown.ts：`rowIndex === 0` 那一步）。
// 于是：
//   * 只改数据格 → 分隔行没变 → 落盘后再打开，markdown-it 按分隔行把整列判成旧对齐，
//     **用户这次修改等于没发生**（还会白写一次盘，git diff 里什么都没有）；
//   * 只改表头格 → 分隔行对了，但其它行单元格的 align 还是旧值，
//     屏幕上同一列一半左一半右，与「这一列怎么对齐」的语义不符。
// 所以这里把该列**每一个单元格**（含表头）都设成同一个值。
//
// 单一入口：工具栏表格按钮弹层里的四个对齐项都走 `setTableColumnAlign` 命令。
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { normalizeAlign, type AlignValue } from './tableAlign'

/**
 * 命令类型声明：Tiptap 的命令表靠声明合并扩展（与 `@tiptap/extension-table` 同一套做法）。
 * 不声明的话 `editor.chain().setTableColumnAlign(...)` 在 `vue-tsc` 下是类型错误。
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableColumnAlign: {
      /** 把当前光标所在的那一列设成 `align`（含表头行）；选区不在表格里时返回 false */
      setTableColumnAlign: (align: AlignValue) => ReturnType
    }
  }
}

/**
 * 反查：当前光标在第几列。
 *
 * 从选区起点沿祖先链找到 `tableRow`，取**该行自己的子节点下标**（= 光标所在单元格在行内的位置）。
 * ⚠️ 是 `index(depth)` 而不是 `index(depth + 1)`：`ResolvedPos.index(d)` 返回的是
 * 「位置在层 d 的那个节点的第几个子节点里」，而 `depth + 1` 是**单元格里面**那一层
 * （段落），那一层每个格子都只有一个段落 ⇒ 恒为 0。实测踩到过：写错这一层时
 * 点第 2/3 列的「右对齐」会去改第 1 列（`| ---: | --- | --- |`，看起来"没反应"）。
 * 注：右键菜单的 `readTableInfo`（menu/context.ts）用的是 `index(depth + 1)` ——
 * 它那两行的算法相同、`colIndex` 恰好也恒为 0（该字段目前只被 `rows` 的禁用判据用到），
 * 本次没动它，避免改动与本缺口无关的右键菜单行为。
 */
export function tableColumnIndex(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== 'tableRow') continue
    const index = $from.index(depth)
    return Number.isInteger(index) ? index : null
  }
  return null
}

/**
 * 读当前光标所在表格里、第 `colIndex` 列的**显式对齐**（表头行为真源，与分隔行同一处判据）。
 * 光标不在表格里时退化为读文档里的第一张表 —— 界面只在光标位于表格内时才读它。
 */
export function tableColumnAlign(editor: Editor, colIndex: number): AlignValue {
  const alignOf = (table: PMNode): AlignValue => {
    if (table.type.name !== 'table') return null
    const header = table.firstChild
    if (!header || colIndex < 0 || colIndex >= header.childCount) return null
    return normalizeAlign(header.child(colIndex).attrs.align)
  }
  const target = resolveTableTarget(editor.state)
  if (target) {
    const table = editor.state.doc.nodeAt(target.pos)
    if (table) return alignOf(table)
  }
  let found: AlignValue = null
  let seen = false
  editor.state.doc.descendants((node) => {
    if (seen || node.type.name !== 'table') return true
    seen = true
    found = alignOf(node)
    return false
  })
  return found
}

/**
 * 选中位置所在的表格：`{ pos, colIndex }`；不在表格里返回 null（口径见 tableColumnIndex）。
 *
 * `pos` 是 **table 节点自身的文档位置**（`$from.before(depth - 1)`），不是内容起点 ——
 * `nodeAt(pos)` 因此拿到的是 table 本身。`$from.start(depth - 1)` 给的是**内容**起点，
 * 实测那个坐标上 `doc.nodeAt()` 返回 undefined（不在任何节点的内容里），不能当基准用。
 */
function resolveTableTarget(state: EditorState): { pos: number; colIndex: number } | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== 'tableRow') continue
    const colIndex = $from.index(depth)
    if (!Number.isInteger(colIndex)) return null
    // depth 是 tableRow 的层号，depth - 1 就是它所属的 table
    return { pos: $from.before(depth - 1), colIndex }
  }
  return null
}

/** 设完对齐后单元格的新 attrs（复制原 attrs，只覆盖 align —— colspan/rowspan/colwidth 都保住） */
function withAlign(cell: PMNode, align: AlignValue): Record<string, unknown> {
  return { ...cell.attrs, align }
}

/**
 * 收集要改写的单元格（只有命中表格的那一列，含表头行）。
 *
 * 坐标推导（prosemirror-model 的位置语义，实测校准过）：
 * `tablePos` 是 table 节点自身的文档位置，`rowOffset` 是**行在 table 内容坐标里**的偏移，
 * 于是 `tablePos + 1 + rowOffset` = 该行节点自身的文档位置（= `setNodeMarkup` 期望的坐标），
 * 再 `+1` 跳过行的开标签、`+cellOffset` 跳过本列之前各单元格的 `nodeSize`，就是命中单元格的位置。
 * ⚠️ 这两处 `+1` 都不是装饰：少一个就会落在「两个单元格之间」那种**不是任何节点**的坐标上
 * （`nodeAt` 返回 undefined，整列静默不动，而且肉眼审查看不出来 —— 实测踩到过）。
 *
 * 运行期判据也是必需的（不能只靠类型）：`nodeAt(tablePos)` 必须是 **table**、每个命中位置必须真的是
 * **单元格**。不成立就整列不动 —— 宁可这次不生效，也不能把对齐写到不该写的节点上。
 */
function collectColumnCells(
  doc: PMNode,
  tablePos: number,
  colIndex: number,
  align: AlignValue
): { pos: number; attrs: Record<string, unknown> }[] {
  const table = doc.nodeAt(tablePos)
  const out: { pos: number; attrs: Record<string, unknown> }[] = []
  if (!table || table.type.name !== 'table') return out
  let ok = true
  table.forEach((row, rowOffset) => {
    if (!ok) return
    if (row.type.name !== 'tableRow') {
      ok = false
      return
    }
    if (colIndex >= row.childCount) return
    let cellOffset = 0
    for (let i = 0; i < colIndex; i++) cellOffset += row.child(i).nodeSize
    const pos = tablePos + 1 + rowOffset + 1 + cellOffset
    const cell = doc.nodeAt(pos)
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) {
      ok = false
      return
    }
    out.push({ pos, attrs: withAlign(cell, align) })
  })
  return ok ? out : []
}

/**
 * 同一套逻辑的纯函数体（命令与直接调用共用，避免两份「怎么找列」的实现）。
 *
 * ⚠️ **必须用调用方给的 `state` / `dispatch`，不能自己去 `editor.view.dispatch`**。
 * Tiptap 的命令层会把命令里产生的步骤**再打包成一条事务**由它统一派发；如果命令自己先
 * `view.dispatch` 了一次，那条事务的 `before` 就与已经变过的文档不匹配 ——
 * 实测报错是 `RangeError: Applying a mismatched transaction`（工具栏点一下直接抛异常）。
 * 这个坑是**端到端断言**（`tools/_verify-table-fidelity.js` 的列对齐段）抓到的：
 * 纯函数层面完全正确（探针里手工复刻同样的步骤，dispatch 正常、Markdown 也对），
 * 差别只在"谁来派发"。
 */
function runColumnAlign(
  state: EditorState,
  align: AlignValue,
  dispatch?: (tr: Transaction) => void
): boolean {
  const target = resolveTableTarget(state)
  if (!target) return false
  const cells = collectColumnCells(state.doc, target.pos, target.colIndex, align)
  if (!cells.length) return false
  if (!dispatch) return true
  const tr = state.tr
  // 一次事务改完整列：多次 dispatch 会产生多条撤销记录（用户要按好几次 Ctrl+Z）
  for (const { pos, attrs } of cells) {
    if (!tr.doc.nodeAt(pos)) return false
    tr.setNodeMarkup(pos, undefined, attrs)
  }
  if (!tr.docChanged) return false
  dispatch(tr)
  return true
}

/** 设当前光标所在列为 `align`：选区不在表格里时返回 false（静默无操作，不抛错） */
export function applyTableColumnAlign(editor: Editor, align: AlignValue): boolean {
  return runColumnAlign(editor.state, align, (tr) => editor.view.dispatch(tr))
}

/**
 * Tiptap 命令：`editor.chain().focus().setTableColumnAlign('center').run()`。
 *
 * 链式命令里**当场算列号、当场改文档**：`focus()` 在 Tiptap v3 里排到下一帧再聚焦，
 * 这里的列号取自「命令拿到的 state」，不受聚焦时机影响。
 */
export const TableColumnAlign = Extension.create({
  name: 'tableColumnAlign',

  addCommands() {
    return {
      setTableColumnAlign:
        (align: AlignValue) =>
        ({ state, dispatch }) =>
          runColumnAlign(state as EditorState, align, dispatch)
    }
  }
})
