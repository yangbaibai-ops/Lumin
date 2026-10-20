// ─── `selectionHasMdStyle`（`lyporaInlineMarks.ts` 自己的逻辑）的单测 ─────────────
//
// 这是全仓**最大的文件**（1746 行，审计 §10 P1 点名「含全仓最大文件」）。它的"核心规则"早就抽进
// `inlineMarkerCore.ts` 并有单测，但文件**自己**还有一层逻辑：工具栏按钮要判断"当前选区有没有某种样式"。
// 样式在本项目里是**集合**（`**粗体里的 `代码`**` 上那段代码同时有 bold 与 code），
// 所以不能用 `isActive('mdStyle', { style })` 那套"属性相等"判断 —— `selectionHasMdStyle` 就是替身。
// 它出错的表现是"工具栏高亮错了"或"点一下把另一种样式顶掉"，而且只在组合样式下才暴露。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { selectionHasMdStyle } from '../src/renderer/src/lib/editor/inlineMarks.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' }
  },
  marks: {
    mdStyle: {
      attrs: { styles: { default: [] } },
      toDOM: () => ['span', 0],
      parseDOM: [{ tag: 'span' }]
    }
  }
})
const { paragraph } = schema.nodes
const md = schema.marks.mdStyle
const styled = (text, styles) => schema.text(text, [md.create({ styles })])
const plain = (text) => schema.text(text)

/** 造一个真实 EditorState（`selectionHasMdStyle` 只用到 `state.selection` 与 `doc.nodesBetween`） */
function stateOf(children, selection) {
  const doc = schema.nodes.doc.create(null, [paragraph.create(null, children)])
  return EditorState.create({ schema, doc, selection })
}
const range = (doc, from, to) => TextSelection.create(doc, from, to)

/** 「编辑器」桩：空选区时读 `getAttributes('mdStyle').styles`（与真实调用点一致） */
const fakeEd = (state, attrs = { styles: [] }) => ({
  state,
  getAttributes: (name) => (name === 'mdStyle' ? attrs : {})
})

test('空选区：样式来自光标的 mark 属性（集合里有就算有）', () => {
  const state = stateOf([plain('abc')], undefined)
  const ed = fakeEd(state, { styles: ['bold', 'code'] })
  assert.equal(selectionHasMdStyle(ed, 'bold'), true)
  assert.equal(selectionHasMdStyle(ed, 'code'), true)
  assert.equal(selectionHasMdStyle(ed, 'italic'), false)
})

test('空选区：属性缺失 / 脏值 / 抛异常都算"没有"（不能让工具栏崩）', () => {
  const state = stateOf([plain('abc')], undefined)
  assert.equal(selectionHasMdStyle(fakeEd(state, {}), 'bold'), false)
  assert.equal(selectionHasMdStyle(fakeEd(state, { styles: undefined }), 'bold'), false)
  assert.equal(selectionHasMdStyle(fakeEd(state, { styles: ['不存在的样式'] }), 'bold'), false)
  const thrower = {
    state,
    getAttributes: () => {
      throw new Error('boom')
    }
  }
  assert.equal(selectionHasMdStyle(thrower, 'bold'), false)
})

test('非空选区：选中的文本带该样式就算命中', () => {
  const probe = stateOf([styled('粗', ['bold']), plain('普通')], undefined)
  const doc = probe.doc
  // 位置 1 是「粗」的起点（doc → paragraph → text）
  const boldRange = fakeEd(stateOf([styled('粗', ['bold']), plain('普通')], range(doc, 1, 2)))
  assert.equal(selectionHasMdStyle(boldRange, 'bold'), true)
  assert.equal(selectionHasMdStyle(boldRange, 'code'), false)

  const plainRange = fakeEd(stateOf([styled('粗', ['bold']), plain('普通')], range(doc, 2, 4)))
  assert.equal(selectionHasMdStyle(plainRange, 'bold'), false, '选区落在普通文本上就不该报命中')
})

test('非空选区：只碰到一部分也算命中（工具栏按钮的语义是"包含"）', () => {
  const probe = stateOf([styled('粗', ['bold']), plain('普通')], undefined)
  const doc = probe.doc
  const partial = fakeEd(stateOf([styled('粗', ['bold']), plain('普通')], range(doc, 1, 4)))
  assert.equal(selectionHasMdStyle(partial, 'bold'), true)
})

test('组合样式（粗体里的行内代码）：两个都命中，且互不干扰', () => {
  const probe = stateOf([styled('X', ['bold', 'code'])], undefined)
  const doc = probe.doc
  const both = fakeEd(stateOf([styled('X', ['bold', 'code'])], range(doc, 1, 2)))
  assert.equal(selectionHasMdStyle(both, 'bold'), true)
  assert.equal(selectionHasMdStyle(both, 'code'), true)
  assert.equal(selectionHasMdStyle(both, 'strike'), false)
})
