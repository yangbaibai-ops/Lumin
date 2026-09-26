// 表格纯文本规则（src/renderer/src/lib/editor/tableAlign.ts）的单测。
//
// 这两条规则决定「表格往返会不会丢格式、会不会把行结构写坏」：
//   分隔行不还原对齐 → 整列的对齐信息丢失（表格全变左对齐）；
//   单元格里的竖线不转义 → 重新解析时被当成列分隔符，**一行被拆成更多格**（结构损坏）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import {
  ALIGN_CHOICES,
  applyColumnAlign,
  delimiterCell,
  delimiterRow,
  escapeCellPipes,
  markdownDelimiter,
  normalizeAlign
} from '../src/renderer/src/lib/editor/tableAlign.ts'
import { serializeTable } from '../src/renderer/src/lib/editor/tableMarkdown.ts'

test('对齐 → 分隔行写法（含默认）', () => {
  assert.equal(delimiterCell('left'), ':---')
  assert.equal(delimiterCell('center'), ':---:')
  assert.equal(delimiterCell('right'), '---:')
  assert.equal(delimiterCell(null), '---')
  assert.equal(delimiterCell(undefined), '---')
  // 认不出来的值按默认处理（不抛错：脏数据不该让序列化整篇失败）
  assert.equal(delimiterCell('justify'), '---')
})

test('整行分隔行按列拼接', () => {
  assert.equal(delimiterRow([null, 'left', 'right']), '| --- | :--- | ---: |')
  assert.equal(delimiterRow(['center', 'right']), '| :---: | ---: |')
  assert.equal(delimiterRow([null]), '| --- |')
})

test('单元格里的竖线转义', () => {
  assert.equal(escapeCellPipes('转义 | 竖线'), '转义 \\| 竖线')
  assert.equal(escapeCellPipes('a | b | c'), 'a \\| b \\| c')
})

test('已经是 \\| 的不重复加反斜杠（幂等）', () => {
  assert.equal(escapeCellPipes('a \\| b'), 'a \\| b')
  assert.equal(escapeCellPipes(escapeCellPipes('a | b')), 'a \\| b')
})

test('行首的竖线也要转义（行首没有前一个字符可借用）', () => {
  assert.equal(escapeCellPipes('|开头'), '\\|开头')
})

test('没有竖线的内容原样返回；行内代码里的竖线同样转义', () => {
  assert.equal(escapeCellPipes('普通文本 **加粗**'), '普通文本 **加粗**')
  assert.equal(escapeCellPipes('`a | b`'), '`a \\| b`')
})

// ─── 「可设置」那一半：列号 → 新对齐 → 分隔行字节 ─────────────────────────────
//
// 审计缺口是「只保真、不可改」：界面里没有入口改某一列的对齐。可设置的实现把「换哪一列」
// 收敛成纯函数（`applyColumnAlign`），这里把它的**三种映射 + 无效输入 + 越界**钉住；
// 最后再用真的 `serializeTable` 把「设完之后写出来的分隔行」逐字节钉住 ——
// 这是本次改动唯一的用户可见效果，必须由测试说明它到底写成什么。

test('三种对齐 + 默认 → 分隔行写法（界面上可点的四种值）', () => {
  assert.equal(markdownDelimiter('left'), ':---')
  assert.equal(markdownDelimiter('center'), ':---:')
  assert.equal(markdownDelimiter('right'), '---:')
  assert.equal(markdownDelimiter(null), '---')
  // 菜单项的顺序（左/中/右/默认）就是 ALIGN_CHOICES 的顺序，图标与 i18n 都按它取
  assert.deepEqual(ALIGN_CHOICES, ['left', 'center', 'right', null])
})

test('无效输入一律收敛成默认（脏数据不该让界面显示一种、写盘另一种）', () => {
  assert.equal(normalizeAlign('justify'), null)
  assert.equal(normalizeAlign('LEFT'), null)
  assert.equal(normalizeAlign(''), null)
  assert.equal(normalizeAlign(undefined), null)
  assert.equal(normalizeAlign(null), null)
  assert.equal(normalizeAlign(3), null)
  assert.equal(normalizeAlign('center'), 'center')
})

test('applyColumnAlign：只改指定列，且不修改入参数组', () => {
  const before = ['left', 'center', null]
  const next = applyColumnAlign(before, 1, 'right')
  assert.deepEqual(next, ['left', 'right', null])
  assert.deepEqual(before, ['left', 'center', null], '入参被就地改了')
  // 把整列设成默认 = 回到裸 `---`（"取消对齐"这条路）
  assert.deepEqual(applyColumnAlign(['left', 'center', 'right'], 2, null), ['left', 'center', null])
})

test('applyColumnAlign：越界的列号只做规范化，不越界写值、不抛错', () => {
  assert.deepEqual(applyColumnAlign(['left', 'center'], 9, 'right'), ['left', 'center'])
  assert.deepEqual(applyColumnAlign(['left'], -1, 'center'), ['left'])
  assert.deepEqual(applyColumnAlign(['left', 'center'], 1.5, 'right'), ['left', 'center'])
  // 脏值顺带被规范化成规范形式（分隔行的真源始终是规范值）
  assert.deepEqual(applyColumnAlign(['justify', 'left'], 1, null), [null, null])
})

/** 记录输出的假 state：只实现 serializeTable 用到的那几个方法/字段（见 tableMarkdown.test.mjs） */
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
    renderInline(node) {
      node.forEach((child) => {
        if (child.type.name === 'hardBreak') this.out += this.inTable ? '<br>' : '\\\n'
        else this.out += child.textContent
      })
    }
  }
}

test('设完之后序列化：分隔行逐字节正确，且只动那一列', () => {
  // 真 schema 的最小版（节点类型名与 attrs 与真表格一致 —— serializeTable 按名字取用）
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
    marks: {}
  })
  const { paragraph, table, tableRow, tableHeader, tableCell } = schema.nodes
  const p = (t) => paragraph.create(null, t ? schema.text(t) : null)
  const h = (text, align) => tableHeader.create({ align: align ?? null }, p(text))
  const c = (text) => tableCell.create(null, p(text))

  /** 用它造出一张表：表头单元格的 align 就是分隔行会写出的东西 */
  const build = (aligns) =>
    table.create(null, [
      tableRow.create(
        null,
        aligns.map((a, i) => h(`列${i + 1}`, a))
      ),
      tableRow.create(
        null,
        aligns.map((_, i) => c(`值${i + 1}`))
      )
    ])

  // ① 第 1 列：默认 → 右对齐。分隔行必须是 `| ---: | :--- | --- |`（逐字节）
  const before = [null, 'left', null]
  const after = applyColumnAlign(before, 0, 'right')
  assert.deepEqual(after, ['right', 'left', null])
  const state = fakeState()
  serializeTable(state, build(after))
  const [headerLine, delimiterLine] = state.out.split('\n')
  assert.equal(headerLine, '| 列1 | 列2 | 列3 |')
  assert.equal(
    delimiterLine,
    '| ---: | :--- | --- |',
    `实际写的是 ${JSON.stringify(delimiterLine)}`
  )
  assert.equal(state.inTable, false, '写完要把 inTable 放回去')
  assert.equal(delimiterRow(after), delimiterLine)

  // ② 第 2 列：左 → 居中；③ 第 3 列：默认 → 左（三种映射都由真序列化器写一遍）
  const centered = fakeState()
  serializeTable(centered, build(applyColumnAlign(after, 1, 'center')))
  assert.equal(centered.out.split('\n')[1], '| ---: | :---: | --- |')
  const lefted = fakeState()
  serializeTable(lefted, build(applyColumnAlign(after, 2, 'left')))
  assert.equal(lefted.out.split('\n')[1], '| ---: | :--- | :--- |')
  // ④ 再把整列设回默认：分隔行回到裸 `---`（"取消对齐"是可达状态，不是死路）
  const cleared = fakeState()
  serializeTable(cleared, build(applyColumnAlign(after, 0, null)))
  assert.equal(cleared.out.split('\n')[1], '| --- | :--- | --- |')
})
