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

// ─── 可设置的列对齐（清单「表格列对齐（可设置）」，此前只有序列化、没有入口）──────
//
// 上面两条是**保真**规则（解析出来的 align 怎么写回去）；这一段是**可改**规则：
// 光标所在的那一列怎么换成另一种对齐。纯逻辑放在这里（不碰编辑器），
// 因此「列号 → 新的对齐数组 → 分隔行字节」这条链可以脱离编辑器直接单测。

/** 对齐的规范形式：null 表示默认（= Markdown 的裸 `---`，不显式对齐） */
export type AlignValue = 'left' | 'center' | 'right' | null

/** 界面上可点的四种对齐（三种 + 默认）；顺序即菜单顺序 */
export const ALIGN_CHOICES: AlignValue[] = ['left', 'center', 'right', null]

/**
 * 把任意来源的值收敛成规范对齐：
 * 认不出来的值（脏数据 / 未来新增的 'justify' 之类）一律当默认 ——
 * 判据与 `delimiterCell` 的 default 分支完全一致，不会出现「界面显示 center、写出来是 `---`」。
 */
export function normalizeAlign(value: unknown): AlignValue {
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

/** 规范对齐 → 分隔行里该列的写法（复用 delimiterCell，两种对齐观只有一个真源） */
export function markdownDelimiter(align: AlignValue | string | null | undefined): string {
  return delimiterCell(align)
}

/**
 * 新的对齐数组：只改第 `colIndex` 列，其余列原样（**不修改入参数组**）。
 * 越界或列号不是整数时返回浅拷贝本身 —— 调用方仍能安全地拿它写回分隔行。
 */
export function applyColumnAlign(
  aligns: readonly (CellAlign | string | null | undefined)[],
  colIndex: number,
  align: AlignValue
): CellAlign[] {
  const next = aligns.map((a) => normalizeAlign(a))
  if (Number.isInteger(colIndex) && colIndex >= 0 && colIndex < next.length) {
    next[colIndex] = align
  }
  return next
}
