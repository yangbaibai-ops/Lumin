// ─── 「段落（上方）/（下方）」：顶层块定位 + 插入点计算（纯函数单测）───────────
//
// 被测文件：`src/renderer/src/lib/editor/paragraphAround.ts`
// 这一组判据决定右键菜单那两项到底把空段落插到**哪里**：
//   * 必须取**顶层块**（光标在表格单元格 / 嵌套列表项里也一样）；
//   * 上方 = 块起点、下方 = 块起点 + nodeSize，都是**顶层兄弟位置**；
//   * 插入后光标在新段落内容区（`insertPos + 1`），一次事务、可一路 Ctrl+Z 还原。
//
// 六类块各测一遍（表格 / 代码块 / mermaid / 图片 / 块级公式 / 列表），
// 外加三个边界（文档开头、文档末尾、光标在表格单元格内）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { history, undo } from '@tiptap/pm/history'
import {
  createParagraphAroundTransaction,
  paragraphInsertion,
  topLevelBlockAt
} from '../src/renderer/src/lib/editor/paragraphAround.ts'

// 只包含本测试用到的节点；属性名与真实 schema 对齐（language / source / src）
const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    image: { inline: true, group: 'inline', attrs: { src: {} } },
    codeBlock: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      attrs: { language: { default: null } }
    },
    mathBlock: { group: 'block', atom: true, attrs: { source: { default: '' } } },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: 'tableCell+' },
    tableCell: { content: 'block+' },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' }
  },
  marks: {}
})

const { paragraph, image, codeBlock, mathBlock, table, tableRow, tableCell, bulletList, listItem } =
  schema.nodes

const p = (text) => paragraph.create(null, text ? schema.text(text) : undefined)
const cell = (text) => tableCell.create(null, p(text))
const row = (...cells) => tableRow.create(null, cells)
const makeTable = () =>
  table.create(null, [row(cell('A1'), cell('B1')), row(cell('A2'), cell('B2'))])
const makeList = () =>
  bulletList.create(null, [
    listItem.create(null, [
      p('项目一'),
      bulletList.create(null, [listItem.create(null, [p('嵌套')])])
    ])
  ])

/** 顶层块在 doc 里的起点（按前序 child 的 nodeSize 累加） */
function blockStart(doc, index) {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
  return pos
}

/** 六类块的夹具：每种都放在 [前后段落] 之间，`from` 是“光标/节点选中”的位置 */
const CASES = [
  {
    name: '表格',
    doc: () => schema.node('doc', null, [p('前'), makeTable(), p('后')]),
    blockIndex: 1,
    // table → row → cell → paragraph 的内容起点：T + 4
    from: (doc) => blockStart(doc, 1) + 4
  },
  {
    name: '代码块',
    doc: () =>
      schema.node('doc', null, [
        p('前'),
        codeBlock.create({ language: 'js' }, schema.text('x')),
        p('后')
      ]),
    blockIndex: 1,
    // 代码块内容起点：C + 1
    from: (doc) => blockStart(doc, 1) + 1
  },
  {
    name: 'mermaid 块',
    doc: () =>
      schema.node('doc', null, [
        p('前'),
        codeBlock.create({ language: 'mermaid' }, schema.text('graph TD')),
        p('后')
      ]),
    blockIndex: 1,
    from: (doc) => blockStart(doc, 1) + 1
  },
  {
    name: '图片',
    doc: () =>
      schema.node('doc', null, [
        p('前'),
        paragraph.create(null, image.create({ src: 'a.png' })),
        p('后')
      ]),
    blockIndex: 1,
    // NodeSelection 选中行内图片：from = 图片节点起点 = 段落起点 + 1
    from: (doc) => blockStart(doc, 1) + 1
  },
  {
    name: '块级公式',
    doc: () => schema.node('doc', null, [p('前'), mathBlock.create({ source: '$$x$$' }), p('后')]),
    blockIndex: 1,
    // 原子节点的 NodeSelection：from = 节点起点
    from: (doc) => blockStart(doc, 1)
  },
  {
    name: '列表',
    doc: () => schema.node('doc', null, [p('前'), makeList(), p('后')]),
    blockIndex: 1,
    // bulletList → listItem → paragraph 的内容起点：L + 3
    from: (doc) => blockStart(doc, 1) + 3
  }
]

for (const c of CASES) {
  test(`顶层块定位：${c.name}（取顶层祖先，不是单元格/列表项内部）`, () => {
    const doc = c.doc()
    const expectedPos = blockStart(doc, c.blockIndex)
    const block = topLevelBlockAt(doc, c.from(doc))
    assert.ok(block, '必须找到顶层块')
    assert.equal(block.index, c.blockIndex)
    assert.equal(block.pos, expectedPos)
    assert.equal(block.node.type.name, doc.child(c.blockIndex).type.name)
    assert.equal(block.node, doc.child(c.blockIndex))
  })

  test(`插入点：${c.name} 上方 = 块前；下方 = 块后（顶层兄弟）`, () => {
    const doc = c.doc()
    const block = doc.child(c.blockIndex)
    const start = blockStart(doc, c.blockIndex)
    const above = paragraphInsertion(doc, c.from(doc), 'above')
    const below = paragraphInsertion(doc, c.from(doc), 'below')
    assert.deepEqual(
      { insertPos: above.insertPos, caretPos: above.caretPos },
      { insertPos: start, caretPos: start + 1 }
    )
    assert.deepEqual(
      { insertPos: below.insertPos, caretPos: below.caretPos },
      { insertPos: start + block.nodeSize, caretPos: start + block.nodeSize + 1 }
    )
  })
}

// ── 三个边界 ────────────────────────────────────────────────────────────────
test('边界 1：块在文档最开头 ⇒ 上方插入点 = 0，新段落成为第一个节点', () => {
  const doc = schema.node('doc', null, [
    codeBlock.create({ language: 'js' }, schema.text('first')),
    p('后')
  ])
  const target = paragraphInsertion(doc, 1, 'above')
  assert.equal(target.insertPos, 0)
  assert.equal(target.caretPos, 1)

  const state = EditorState.create({ doc, schema })
  const tr = createParagraphAroundTransaction(state, 'above')
  assert.equal(tr.doc.child(0).type.name, 'paragraph')
  assert.equal(tr.doc.child(0).content.size, 0)
  assert.equal(tr.doc.child(1).type.name, 'codeBlock')
  assert.equal(tr.selection.from, 1)
})

test('边界 2：块在文档最末尾 ⇒ 下方插入点在 content.size，插入成功且光标进新段', () => {
  const doc = schema.node('doc', null, [p('前'), makeTable()])
  const target = paragraphInsertion(doc, blockStart(doc, 1) + 4, 'below')
  assert.equal(target.insertPos, doc.content.size)
  assert.equal(target.caretPos, doc.content.size + 1)

  const state = EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, blockStart(doc, 1) + 4)
  })
  const tr = createParagraphAroundTransaction(state, 'below')
  const last = tr.doc.child(tr.doc.childCount - 1)
  assert.equal(last.type.name, 'paragraph')
  assert.equal(last.content.size, 0)
  assert.equal(tr.doc.child(tr.doc.childCount - 2).type.name, 'table')
  assert.equal(tr.selection.from, tr.doc.content.size - 1)
})

test('边界 3：光标在表格单元格内 ⇒ 新段落插在整张表格外，不是单元格里', () => {
  const doc = schema.node('doc', null, [p('前'), makeTable(), p('后')])
  const tablePos = blockStart(doc, 1)
  const tableSize = doc.child(1).nodeSize
  const cellCaret = tablePos + 4

  const above = createParagraphAroundTransaction(
    EditorState.create({ doc, schema, selection: TextSelection.create(doc, cellCaret) }),
    'above'
  )
  assert.equal(above.doc.child(1).type.name, 'paragraph', '上方：表格降为第 3 个顶层节点')
  assert.equal(above.doc.child(2).type.name, 'table')
  assert.equal(above.selection.from, tablePos + 1, '光标在新段落内（表格上方）')

  const below = createParagraphAroundTransaction(
    EditorState.create({ doc, schema, selection: TextSelection.create(doc, cellCaret) }),
    'below'
  )
  assert.equal(below.doc.child(1).type.name, 'table')
  assert.equal(below.doc.child(2).type.name, 'paragraph', '下方：新段落在整张表格之后')
  assert.equal(below.selection.from, tablePos + tableSize + 1)
  // 表格内部结构不变（仍是 2 行 × 2 格，单元格里没有多出段落）
  const tableAfter = below.doc.child(1)
  assert.equal(tableAfter.childCount, 2)
  assert.equal(tableAfter.child(0).childCount, 2)
  assert.equal(tableAfter.child(0).child(0).childCount, 1)
})

// ── NodeSelection / 单块文档 / 一次撤销 ─────────────────────────────────────
test('NodeSelection 选中整张表格：下方插入以选中节点为准（不是选区外的别的块）', () => {
  const doc = schema.node('doc', null, [p('前'), makeTable(), p('后')])
  const tablePos = blockStart(doc, 1)
  const state = EditorState.create({
    doc,
    schema,
    selection: NodeSelection.create(doc, tablePos)
  })
  const tr = createParagraphAroundTransaction(state, 'below')
  assert.equal(tr.selection instanceof TextSelection, true)
  assert.equal(tr.doc.child(2).type.name, 'paragraph')
  assert.equal(tr.selection.from, tablePos + doc.child(1).nodeSize + 1)
})

test('文档只有这一个块：上方/下方都能插，且仍保持顶层兄弟关系', () => {
  const only = codeBlock.create({ language: 'js' }, schema.text('only'))
  const doc = schema.node('doc', null, [only])
  for (const side of ['above', 'below']) {
    const tr = createParagraphAroundTransaction(EditorState.create({ doc, schema }), side)
    assert.equal(tr.doc.childCount, 2)
    assert.equal(
      tr.doc.child(side === 'above' ? 0 : 1).type.name,
      'paragraph',
      `${side}: 新段落位置`
    )
    assert.equal(tr.doc.child(side === 'above' ? 1 : 0).type.name, 'codeBlock')
    assert.equal(tr.selection.from, side === 'above' ? 1 : only.nodeSize + 1)
  }
})

test('一次事务 = 一步历史：插入后 undo 一次，文档逐字节回到原文', () => {
  const doc = schema.node('doc', null, [
    p('前'),
    codeBlock.create({ language: 'js' }, schema.text('const a = 1')),
    p('后')
  ])
  const codeStart = blockStart(doc, 1)
  let state = EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, codeStart + 1),
    plugins: [history()]
  })
  state = state.apply(createParagraphAroundTransaction(state, 'above'))
  assert.equal(state.doc.childCount, 4, '插入后多一个顶层段落')
  assert.equal(state.doc.child(1).type.name, 'paragraph')
  assert.equal(state.selection.from, codeStart + 1, '光标在新段落内（原代码块已被推到第 3 位）')

  let undone = false
  undo(state, (tr) => {
    undone = true
    state = state.apply(tr)
  })
  assert.equal(undone, true, '事务必须进了历史（undo 有东西可撤）')
  assert.equal(state.doc.eq(doc), true, '一次 undo 必须逐节点还原原文')
  assert.equal(state.doc.childCount, 3)
})

test('空文档：没有顶层块 ⇒ 返回 null（调用方不 dispatch、不写历史）', () => {
  const doc = schema.node('doc', null, [])
  assert.equal(topLevelBlockAt(doc, 0), null)
  assert.equal(paragraphInsertion(doc, 0, 'above'), null)
})

// ── i18n：两个新 key 三语齐全 ────────────────────────────────────────────────
test('i18n：段落（上方/下方）在 zh-CN / en-US / ru-RU 都有非空文案', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const expected = {
    'zh-CN': { paragraphAbove: '段落（上方）', paragraphBelow: '段落（下方）' },
    'en-US': { paragraphAbove: 'Paragraph above', paragraphBelow: 'Paragraph below' },
    'ru-RU': { paragraphAbove: 'Абзац выше', paragraphBelow: 'Абзац ниже' }
  }
  for (const [lang, keys] of Object.entries(expected)) {
    const pack = JSON.parse(
      readFileSync(join(root, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8')
    )
    assert.equal(pack.editorMenu.paragraphAbove, keys.paragraphAbove, `${lang}.paragraphAbove`)
    assert.equal(pack.editorMenu.paragraphBelow, keys.paragraphBelow, `${lang}.paragraphBelow`)
  }
})
