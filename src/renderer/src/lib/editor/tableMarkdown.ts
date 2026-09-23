// ─── 表格的 Markdown 序列化（Wave 1 缺口：table.md）─────────────────────────
//
// 解析侧本来就是对的：markdown-it 会把列对齐写成单元格的 `style="text-align:…"`，
// `@tiptap/extension-table` 的 `align` 属性认领它，单元格里的 `\|` 也被正确解成字面竖线。
// 丢信息的是**写回**那一步（tiptap-markdown 内置的表格序列化器）：
//   * 分隔行永远写裸 `---` → 列对齐丢失；
//   * 单元格内容不转义 → 内容里的 `|` 被当成列分隔符，**整行结构被拆坏**。
// 所以这里接管 `table` 节点的 markdown 序列化：分隔行按各列表头的 align 生成，
// 单元格内容渲染后再把竖线转义。只有「Markdown 管道语法真的表达不了」的表格
// （合并单元格 / 单元格里塞了段落以外的块）才退回 HTML 输出。
//
// ⚠️ **一格多段**（同一个单元格里出现多个段落）曾经被误判成「表达不了」⇒ 整张表退回 HTML。
// 触发路径极其日常：**在单元格里按一下回车**就会多出一个（空的）段落。用户报障的现场就是
//   在「**实测痛点**」后面回车 → 源码里整张表变成 `<table style="min-width: 50px;">…`，
// 而这段 HTML 一旦落盘，再打开时 markdown-it 只会把它当 HTML 块 —— **表格结构就此损坏**。
// 本轮的修法是两处一起：
//   1. **编辑侧**（lib/editor/keymap.ts 的 Enter）：单元格里回车改成插入**硬换行 `<br>`** ——
//      GFM 表达得了（`| **实测痛点**<br>第二行 |`，markdown-it 也解回硬换行），
//      于是正常操作不会再产生第二个段落；
//   2. **序列化侧**（本文件）：空段落不再影响判定（直接跳过不渲染），
//      所以历史上已经写成那样的文档、以及外来的粘贴内容，也不会再被整张表打成 HTML。
// 只有「一格里有 2 个以上**有内容**的段落」才退回 HTML：管道表只能靠 `<br>` 硬拼多段，
// 而标记符开合是状态机，跨段落拼接很容易写出 `**a<br>**` 这种坏结构（实测踩过）。
import { Table } from '@tiptap/extension-table'
import { DOMSerializer } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownSerializerStateLike } from './markdownTypes'
import { delimiterRow, escapeCellPipes, type CellAlign } from './tableAlign'

/**
 * 表格能否用 Markdown 管道语法表达：
 * 表头在第一行、没有合并单元格、每格**至多一个「有内容」的段落**。
 *
 * ⚠️ **空段落不算数**（`textContent` 为空即忽略）。这正是用户报障的那条路径：
 * 在单元格里按一下回车会多出一个空段落，旧判据 `childCount !== 1` 立刻把整张表判成
 * 「复杂表格」⇒ 退回 HTML ⇒ 源码里变成 `<table style="min-width: 50px;">…`，落盘后
 * markdown-it 只会把它当 HTML 块，**表格结构就此损坏**。
 * （编辑侧本轮也改了：单元格里回车改成插入硬换行 `<br>`，正常操作不会再产生第二个段落 ——
 * 见 lib/editor/keymap.ts 的 Enter。这里的容忍是为了兼容已经写成那样的文档与外来的粘贴内容。）
 *
 * 一格里有**两个以上有内容的段落**时仍退回 HTML：管道表只能靠 `<br>` 硬拼多段，
 * 而标记符的开合是状态机，跨段落拼接很容易写出 `**a<br>**` 这种坏结构（实测踩过）。
 */
function isSimpleTable(node: PMNode): boolean {
  let ok = true
  node.forEach((row, _offset, rowIndex) => {
    row.forEach((cell) => {
      const wantHeader = rowIndex === 0
      if ((cell.type.name === 'tableHeader') !== wantHeader) ok = false
      if (Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1) ok = false
      let filled = 0
      cell.forEach((block) => {
        if (block.type.name !== 'paragraph') ok = false
        else if (block.textContent.trim()) filled += 1
      })
      if (filled > 1) ok = false
    })
  })
  return ok
}

/** 复杂表格退回 HTML（Markdown 表格语法没有合并单元格/多段有内容单元格的对应写法） */
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

/**
 * 渲染一个单元格：取它**第一个有内容的段落**（空段落直接跳过 —— 它在 GFM 表格里没有写法，
 * 而且不渲染它才不会写出孤立的标记符）。
 *
 * 写法必须「先渲染进缓冲、再就地转义」：**不能只截不留** —— 标记符开合是状态机，
 * 截掉不回写会让闭合标记跑到后面的内容里去（实测会写出 `**a<br>**` 这种坏结构）。
 */
function renderCell(state: MarkdownSerializerStateLike, cell: PMNode): void {
  let content: PMNode | null = null
  cell.forEach((block) => {
    if (!content && block.type.name === 'paragraph' && block.textContent.trim()) content = block
  })
  if (!content) return
  const start = state.out.length
  state.renderInline(content)
  const rendered = state.out.slice(start)
  state.out = state.out.slice(0, start) + escapeCellPipes(rendered)
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
      renderCell(state, cell)
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
