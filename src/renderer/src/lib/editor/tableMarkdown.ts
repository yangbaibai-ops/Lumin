// ─── 表格的 Markdown 序列化（Wave 1 缺口：table.md）─────────────────────────
//
// 解析侧本来就是对的：markdown-it 会把列对齐写成单元格的 `style="text-align:…"`，
// `@tiptap/extension-table` 的 `align` 属性认领它，单元格里的 `\|` 也被正确解成字面竖线。
// 丢信息的是**写回**那一步（tiptap-markdown 内置的表格序列化器）：
//   * 分隔行永远写裸 `---` → 列对齐丢失；
//   * 单元格内容不转义 → 内容里的 `|` 被当成列分隔符，**整行结构被拆坏**。
// 所以这里接管 `table` 节点的 markdown 序列化：分隔行按各列表头的 align 生成，
// 单元格内容渲染后再把竖线转义。只有「Markdown 管道语法真的表达不了」的表格
// （合并单元格 / 单元格里出现段落以外的块）才退回 HTML 输出。
//
// ── 根因（用户报障：单元格里按一下回车，整张表在 .md 里变成一整段 HTML）────────
//
// 复现链只有两步，缺一不可：
//   1. 单元格里回车 → 编辑器在格子里多出**第二个段落**（Tiptap 默认 splitBlock，行为本身没问题）；
//   2. 这里的判据原来是 `cell.childCount !== 1 ⇒ 复杂表格 ⇒ 退回 HTML`，
//      于是一个**不含任何内容的空段落**就把整张表打成了 HTML：
//      `<table style="min-width: 50px;">…`。这段 HTML 一旦落盘，再打开时 markdown-it
//      只把它当 HTML 块解析 ⇒ **管道表结构丢失**（不是显示问题，是数据问题）。
//
// 判据过宽就是根因：空段落没有任何内容可保真，多段落也并非表达不了 ——
// GFM 的单元格可以用行内 `<br>` 表达多行。所以现在：
//   * 判据只看「有没有段落以外的块」与「合并单元格」；
//   * 渲染时把单元格里的段落**合成一段行内序列**（非空段落之间插 hardBreak，
//     配合 `state.inTable = true` 就会写成 `<br>`；前导/尾随/中间的空段落直接丢掉）；
//   * 合成之后再交给 `renderInline` **一次**渲染 —— 必须是一次调用：
//     标记符开合是状态机，分多次渲染再拼接会把闭合标记推到后面的内容里
//     （实测会写出 `**实测痛点**<br>**` 这种尾巴上多一个空 `**` 的坏结构）。
//
// ⚠️ 只改序列化侧，**不动编辑器行为**：单元格里回车仍然照旧切段落（用户没有要求改这个）。
import { Table } from '@tiptap/extension-table'
import { DOMSerializer, Fragment } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownSerializerStateLike } from './markdownTypes'
// 显式 .ts：本模块要被 tests/tableMarkdown.test.mjs 直接加载（Node 的 ESM 不做扩展名补全）
import { delimiterRow, escapeCellPipes, type CellAlign } from './tableAlign.ts'
// 序列化热区：把"直接改 out"之后的 atBlank 增量缓存对齐（见 renderCell 的长注释）
// 同上，显式 .ts（tests/*.test.mjs 直接加载本模块）
import { noteSerializerAppend } from './serializerFastPath.ts'

/**
 * 表格能否用 Markdown 管道语法表达：
 * 表头在第一行、没有合并单元格、每格只由**段落**组成（段数不限 —— 多段用行内 `<br>` 表达）。
 * 空段落不影响判定（它在管道表里没有写法，渲染时会被丢掉，且不含任何内容）。
 */
function isSimpleTable(node: PMNode): boolean {
  let ok = true
  node.forEach((row, _offset, rowIndex) => {
    row.forEach((cell) => {
      const wantHeader = rowIndex === 0
      if ((cell.type.name === 'tableHeader') !== wantHeader) ok = false
      if (Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1) ok = false
      cell.forEach((block) => {
        if (block.type.name !== 'paragraph') ok = false
      })
    })
  })
  return ok
}

/** 复杂表格退回 HTML（合并单元格 / 单元格里有代码块·列表这类块 —— 管道语法表达不了） */
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

/** 只由标记符字符组成（`**` / `*` / `` ` `` / `~~` …）的行内文本 = 标记符本身 */
function isMarkerOnly(node: PMNode): boolean {
  return node.isText === true && /^[*_`~]+$/.test(node.text ?? '')
}

/**
 * 把单元格的段落合成**一段**行内序列：非空段落之间插一个 `hardBreak`
 * （`state.inTable` 会让它写成 `<br>`），空段落丢掉。
 * 单元格里没有任何有内容的段落时返回 null（= 空格子）。
 *
 * ⚠️ **换行位置上的标记符要归位**（这是「回车那一下」留下的坑）：
 * 本编辑器的标记符是**真实文本**，光标停在「**实测痛点**」这种被样式包住的文字末尾时，
 * 回车的切点正好落在**内容与闭合标记符之间**，于是闭合的 `**` 被留在**第二个段落**里
 * （实测结构：段 0 = [`**`, 实测痛点]、段 1 = [`**`]；打一行字后段 1 = [第二行, `**`]）。
 * 直接把两段拼成 `**实测痛点<br>第二行**` 虽然也能解析，但那个 `<br>` 落在了标记符对内，
 * 再存一次就会漂（实测第二次序列化出 `****<br**>` 这种坏结构）。
 * 所以这里把**紧跟换行的、只由标记符组成的尾巴**提到 `<br>` 之前 ——
 * 换行就落在样式之外，输出稳定（`**实测痛点**<br>第二行`），也才是作者写下回车时的本意。
 */
function cellInlineNode(cell: PMNode): PMNode | null {
  const schema = cell.type.schema
  const paragraphType = schema.nodes.paragraph
  const hardBreakType = schema.nodes.hardBreak
  if (!paragraphType) return null
  const parts: PMNode[] = []
  /** 已排进 parts 的「纯标记符」节点数：奇数 = 此刻有一个样式对**只开了没合** */
  let markerOpen = 0
  cell.forEach((block) => {
    if (block.type.name !== 'paragraph') return
    if (!block.textContent.trim()) return // 空段落：丢（无内容可保真，管道表也没有它的写法）
    const nodes: PMNode[] = []
    block.forEach((inline) => nodes.push(inline))
    let cut = nodes.length
    while (cut > 0 && isMarkerOnly(nodes[cut - 1])) cut--
    const tailNodes = nodes.slice(cut)
    const bodyNodes = nodes.slice(0, cut)
    const bodyHasMarker = bodyNodes.some(isMarkerOnly)
    const first = parts.length === 0
    if (!first) {
      // 上一段留了个「只开没合」的样式对，而这一段的身体里没有标记符
      // ⇒ 这一段尾巴上的标记符就是它的闭合符：提到 `<br>` 之前（见上方长注释）
      if (markerOpen % 2 === 1 && tailNodes.length > 0 && !bodyHasMarker) {
        parts.push(...tailNodes)
        markerOpen += tailNodes.length
        if (hardBreakType) parts.push(hardBreakType.create())
        parts.push(...bodyNodes)
        return
      }
      if (hardBreakType) parts.push(hardBreakType.create())
    }
    parts.push(...bodyNodes, ...tailNodes)
    markerOpen += tailNodes.length + bodyNodes.filter(isMarkerOnly).length
  })
  if (!parts.some((n) => !isMarkerOnly(n) && n.type.name !== 'hardBreak')) return null
  return paragraphType.create(null, Fragment.fromArray(parts))
}

/**
 * 渲染一格：合成 → 一次 `renderInline` → 就地转义竖线。
 *
 * ── 为什么不能"直接渲染进 state.out 再切片"（本轮改，真因）──────────────────────
 * 旧写法是 `const start = state.out.length; renderInline(); out = out.slice(0,start) + …`。
 * 对一个 cons string 做 `slice` 会强制 V8 **把整串拍平**，而这个动作**每个单元格做两次**：
 *   ① `out.slice(start)`（拍平 + 复制全文）
 *   ② `out.slice(0,start)`（再拍平一次）
 * 于是序列化成本 = 单元格数 × 已写出全文 = **二次增长**。两张长表格（本次复报就是
 * 2 张、14 格）在小文档上只是慢一点，但它会和大文档叠加；而且它还会把下面这条
 * 快路径打回原形：`atBlank()` 的增量缓存按 `{len,end}` 校验，`out` 被直接赋值后
 * 长度对不上 ⇒ 下一次 `atBlank()` 走 `computeEnd()` 再拍平一次全文。
 *
 * 新写法：把 `out` 临时换成**与真实尾部同形的短种子**（每个单元格前刚写过 `'| '`，
 * 所以种子就是 `'| '` —— `atBlank()` 的判据与真实状态一致，`renderInline` 的输出
 * 逐字节不变），渲染完只读回这一格的短串，再用**一次字符串拼接**写回：
 * 拼接 cons string 是 O(1)，不拍平。最后 `noteSerializerAppend()` 把 atBlank 的
 * 增量缓存对齐（否则下一次 `atBlank()` 仍会拍平全文）。
 */
function renderCell(state: MarkdownSerializerStateLike, cell: PMNode): void {
  const inline = cellInlineNode(cell)
  if (!inline) return
  const before = state.out
  // serializeTable 在每格前刚写过 `'| '`；极端情况下（外部直接调用 serializeTable）
  // 尾部不是它，那就用空种子 —— 语义与"从当前列位置开始渲染"一致。
  const seed = before.endsWith('| ') ? '| ' : ''
  state.out = seed
  let rendered = ''
  try {
    state.renderInline(inline)
    rendered = state.out.length >= seed.length ? state.out.slice(seed.length) : state.out
  } finally {
    // 异常也要把 out 还原（否则整篇序列化会从这里断掉半截）
    state.out = before
  }
  const escaped = escapeCellPipes(rendered)
  state.out = before + escaped
  noteSerializerAppend(state, escaped)
}

/**
 * 表格 → Markdown 的**纯序列化函数**（导出给 `tests/tableMarkdown.test.mjs` 直接调，
 * 不必起编辑器：它只依赖 `state` 的几个方法、`delimiterRow`/`escapeCellPipes` 与节点结构）。
 * 复杂表格退回 HTML 的那条分支需要 DOM，单测里给 `document` 一个最小桩即可。
 */
export function serializeTable(state: MarkdownSerializerStateLike, node: PMNode): void {
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
