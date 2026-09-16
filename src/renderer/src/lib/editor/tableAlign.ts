// ─── 表格的纯文本规则（无任何依赖，可单测）──────────────────────────────────
//
// 表格往返有两处「纯文本」判定，放在这里而不是写在序列化器里：
//   1. 分隔行：markdown-it 解析出来的是单元格上的 `align`（left/center/right/null），
//      写回 Markdown 时要还原成 `:---` / `:---:` / `---:` —— 不还原就等于把
//      「这一列怎么对齐」这条格式信息丢了（表格会整体左对齐）；
//   2. 单元格里的竖线：Markdown 表格用 `|` 分列，内容里的竖线必须写成 `\|`。
//      不转义的话，`| 转义 \| 竖线 |  |  |` 这一行会被重新解析成 4 列 —— **行结构直接坏掉**。

/** 单元格对齐（来自 @tiptap/extension-table 的 tableCell/tableHeader attrs.align） */
export type CellAlign = 'left' | 'center' | 'right' | null

/** 分隔行里每一列怎么写（null = 默认对齐，即裸 `---`） */
export function delimiterCell(align: CellAlign | string | null | undefined): string {
  switch (align) {
    case 'left':
      return ':---'
    case 'center':
      return ':---:'
    case 'right':
      return '---:'
    default:
      return '---'
  }
}

/** 整行分隔行：`| --- | :--- | ---: |` */
export function delimiterRow(aligns: (CellAlign | string | null | undefined)[]): string {
  return `| ${aligns.map(delimiterCell).join(' | ')} |`
}

/**
 * 转义单元格内容里的竖线（已经是 `\|` 的不重复加反斜杠）。
 * 注意只处理竖线：单元格里的 `*`/`_` 等交给 markdown 序列化器按常规规则处理。
 */
export function escapeCellPipes(text: string): string {
  return text.replace(/(^|[^\\])\|/g, '$1\\|')
}
