// ─── 表格写回（`lib/editor/tableMarkdown.ts`）的单测 ───────────────────────────────
//
// 审计 §10 P1「48 个 ≥80 行的 src 文件零引用」里点名的一个：这张表的**写回**规则
// （分隔行按各列 align 生成、单元格里的竖线转义、多段合成一行用 `<br>`）此前只在 CDP 套件里
// 被间接覆盖（`_verify-table-fidelity` / `_verify-md-fidelity`，都是"整篇文档往返"的口径），
// 出错时只能看到一个"某夹具变 lossy"。
//
// 这里直接把 `serializeTable` 当纯函数调：给它一个**最小的真 schema**（只要节点类型名与
// attrs 与真表格一致 —— 代码就是按这些名字写的）与一个记录输出的假 state，
// 逐条钉住"写出来到底是什么字节"。
//
// ⚠️ `state.renderInline` 是 tiptap-markdown 的实现，这里换成"按 `inTable` 把 hardBreak 写成
// `<br>`、其余取 textContent"的桩 —— 它必须与真实序列化器在这一层的行为一致，
// 否则断言的是桩而不是被测代码（被测代码只负责**拼出**那个行内序列与表格骨架）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { serializeTable } from '../src/renderer/src/lib/editor/tableMarkdown.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: '(tableHeader|tableCell)+' },
    tableHeader: {
      content: 'block+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, align: { default: null } }
    },
    tableCell: {
      content: 'block+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, align: { default: null } }
    }
  },
  // 标记符在真实文档里是**带 mark 的文本节点**（`mdMarker` / 样式 mark）——
  // 没有 mark 时 PM 会把相邻文本合并成一个节点，那个「标记符尾巴」的结构就造不出来
  marks: { marker: {}, strong: {} }
})

const { paragraph, tableRow, tableHeader, tableCell } = schema.nodes
const markerMark = schema.marks.marker.create()
const strongMark = schema.marks.strong.create()
/** 段落：空串就是空段落（PM 不允许空文本节点） */
const p = (...texts) =>
  paragraph.create(
    null,
    texts.filter((t) => t !== '').map((t) => schema.text(t))
  )
const header = (text, align = null) => tableHeader.create({ align }, p(text))
const cell = (text, attrs = {}) => tableCell.create(attrs, p(text))
const table = (...rows) => schema.nodes.table.create(null, rows)

/** 记录输出的假 state（只实现 serializeTable 用到的那几个方法/字段） */
function fakeState() {
  return {
    out: '',
    inTable: false,
    closed: 0,
    write(s) {
      this.out += s
    },
    ensureNewLine() {
      if (!this.out.endsWith('\n')) this.out += '\n'
    },
    closeBlock() {
      this.closed += 1
      this.ensureNewLine()
      this.out += '\n'
    },
    /** 与 tiptap-markdown 同口径：表格里 hardBreak 写成 `<br>` */
    renderInline(node) {
      node.forEach((child) => {
        if (child.type.name === 'hardBreak') this.out += this.inTable ? '<br>' : '\\\n'
        else this.out += child.textContent
      })
    }
  }
}

function run(node) {
  const state = fakeState()
  serializeTable(state, node)
  return state
}

test('简单表：按各列表头的 align 写分隔行', () => {
  const s = run(
    table(
      tableRow.create(null, [header('甲', 'left'), header('乙', 'center'), header('丙', 'right')]),
      tableRow.create(null, [cell('1'), cell('2'), cell('3')])
    )
  )
  assert.equal(s.inTable, false, '写完要把 inTable 放回去')
  assert.match(s.out, /\| 甲 \| 乙 \| 丙 \|/)
  assert.match(s.out, /\| :--- \| :---: \| ---: \|/)
  assert.match(s.out, /\| 1 \| 2 \| 3 \|/)
})

test('单元格里的竖线被转义（否则整行结构被拆坏）', () => {
  const s = run(
    table(
      tableRow.create(null, [header('a'), header('b')]),
      tableRow.create(null, [cell('x|y'), cell('z')])
    )
  )
  assert.match(s.out, /\| x\\\|y \| z \|/)
})

test('空格子（空段落）写成空单元格，不写多余字符', () => {
  const s = run(
    table(
      tableRow.create(null, [header('a'), header('b')]),
      tableRow.create(null, [cell(''), cell('')])
    )
  )
  assert.match(s.out, /\| {2}\| {2}\|/)
})

test('单元格里回车留下的多段：合成一行、非空段之间写 <br>，空段落丢掉', () => {
  const s = run(
    table(
      tableRow.create(null, [header('a')]),
      tableRow.create(null, [tableCell.create(null, [p('第一行'), p(''), p('第二行')])])
    )
  )
  assert.match(s.out, /\| 第一行<br>第二行 \|/)
  assert.equal(s.out.includes('<br><br>'), false, '空段落不该留出一个空行')
})

test('换行处的标记符归位：闭合的 `**` 提到 <br> 之前（否则再存一次会漂）', () => {
  const s = run(
    table(
      tableRow.create(null, [header('a')]),
      // 实测结构：段 0 = [`**`, 实测痛点]、段 1 = [`**`]（光标停在样式末尾按回车）。
      // ⚠️ 两个 `**` 必须带 mark：不带的话 PM 会把相邻文本合并，造不出这个结构
      tableRow.create(null, [
        tableCell.create(null, [
          paragraph.create(null, [
            schema.text('**', [markerMark]),
            schema.text('实测痛点', [strongMark])
          ]),
          paragraph.create(null, [schema.text('**', [markerMark])])
        ])
      ])
    )
  )
  assert.match(s.out, /\| \*\*实测痛点\*\*<br> \|/)
})

test('整格只有标记符 ⇒ 当空格子（没有内容可保真）', () => {
  const s = run(
    table(
      tableRow.create(null, [header('a')]),
      tableRow.create(null, [tableCell.create(null, [p('**')])])
    )
  )
  assert.match(s.out, /\| {2}\|/)
})

test('复杂表（合并单元格）退回 HTML：**不写管道表**，也不留半截结构', () => {
  // 这条分支要 `document` 才能序列化 DOM；给个最小桩，断言的是"走了这条分支"这个事实
  const saved = globalThis.document
  globalThis.document = {
    createElement: () => ({
      appendChild() {
        /* 桩：不需要真 DOM */
      },
      innerHTML: ''
    })
  }
  try {
    const s = run(
      table(
        tableRow.create(null, [tableHeader.create({ colspan: 2 }, p('合并表头'))]),
        tableRow.create(null, [cell('a'), cell('b')])
      )
    )
    assert.equal(s.out.includes('|'), false, '复杂表不该写管道语法（会被解析成结构不同的表）')
    assert.equal(s.closed, 1, '仍然要收尾（closeBlock）')
  } finally {
    if (saved) globalThis.document = saved
    else delete globalThis.document
  }
})

test('表头/单元格类型不匹配也算复杂表（列数对不上就退回 HTML）', () => {
  const saved = globalThis.document
  globalThis.document = {
    createElement: () => ({
      appendChild() {
        /* 桩：不需要真 DOM */
      },
      innerHTML: ''
    })
  }
  try {
    const s = run(
      table(
        tableRow.create(null, [tableCell.create(null, p('第一行不是表头'))]),
        tableRow.create(null, [cell('a')])
      )
    )
    assert.equal(s.out.includes('|'), false)
  } finally {
    if (saved) globalThis.document = saved
    else delete globalThis.document
  }
})
