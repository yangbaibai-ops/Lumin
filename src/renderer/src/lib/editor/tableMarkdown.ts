// ─── 表格的 Markdown 序列化（Wave 1 缺口：table.md）─────────────────────────
//
// 解析侧本来就是对的：markdown-it 会把列对齐写成单元格的 `style="text-align:…"`，
// `@tiptap/extension-table` 的 `align` 属性认领它，单元格里的 `\|` 也被正确解成字面竖线。
// 丢信息的是**写回**那一步（tiptap-markdown 内置的表格序列化器）：
//   * 分隔行永远写裸 `---` → 列对齐丢失；
//   * 单元格内容不转义 → 内容里的 `|` 被当成列分隔符，**整行结构被拆坏**。
// 所以这里接管 `table` 节点的 markdown 序列化：分隔行按各列表头的 align 生成，
// 单元格内容渲染后再把竖线转义。复杂表格（合并单元格 / 一格多块）仍退回 HTML 输出
// —— 那是 Markdown 表格语法表达不了的东西，硬拼成管道表才是真的丢结构。
import { Table } from '@tiptap/extension-table'
import { DOMSerializer } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownSerializerStateLike } from './markdownTypes'
import { delimiterRow, escapeCellPipes, type CellAlign } from './tableAlign'

/** 表格能否用 Markdown 管道语法表达：表头在第一行、没有合并单元格、每格只有一个块 */
function isSimpleTable(node: PMNode): boolean {
  let ok = true
  node.forEach((row, _offset, rowIndex) => {
    row.forEach((cell) => {
      const wantHeader = rowIndex === 0
      if ((cell.type.name === 'tableHeader') !== wantHeader) ok = false
      if (Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1) ok = false
      if (cell.childCount !== 1) ok = false
    })
  })
  return ok
}

/** 复杂表格退回 HTML（Markdown 表格语法没有合并单元格/多块单元格的概念） */
function writeTableHtml(state: MarkdownSerializerStateLike, node: PMNode): void {
  try {
    const dom = DOMSerializer.fromSchema(node.type.schema).serializeNode(node)
    const host = document.createElement('div')
    host.appendChild(dom)
    state.write(host.innerHTML)
  } catch {
    /* 序列化失败时什么都不写（宁可空，也不要写出一半的坏结构） */
  }
  state.closeBlock(node)
}

function serializeTable(state: MarkdownSerializerStateLike, node: PMNode): void {
  if (!isSimpleTable(node)) {
    writeTableHtml(state, node)
    return
  }
  // inTable：让单元格里的硬换行按 HTML `<br>` 写出（与 tiptap-markdown 的内置行为一致）
  state.inTable = true
  node.forEach((row, _offset, rowIndex) => {
    state.write('| ')
    row.forEach((cell, _cellOffset, colIndex) => {
      if (colIndex) state.write(' | ')
      const content = cell.firstChild
      if (content && content.textContent.trim()) {
        // 先把这一格渲染进输出缓冲，再把竖线转义 —— 逐字符写没法插转义
        const start = state.out.length
        state.renderInline(content)
        const rendered = state.out.slice(start)
        state.out = state.out.slice(0, start) + escapeCellPipes(rendered)
      }
    })
    state.write(' |')
    state.ensureNewLine()
    if (rowIndex === 0) {
      const aligns: CellAlign[] = []
      row.forEach((cell) => aligns.push((cell.attrs.align ?? null) as CellAlign))
      state.write(delimiterRow(aligns))
      state.ensureNewLine()
    }
  })
  state.closeBlock(node)
  state.inTable = false
}

/**
 * 表格节点（在 `Table.configure` 之前 extend）：只改 markdown 序列化，行为与上游一致。
 */
export const TableFidelity = Table.extend({
  addStorage() {
    return {
      ...(this.parent?.() ?? {}),
      markdown: { serialize: serializeTable }
    }
  }
})
