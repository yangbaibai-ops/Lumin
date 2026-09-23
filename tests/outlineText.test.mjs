// ─── 大纲标签：语法标记（mdMarker）不能进目录 ───────────────────────────────
//
// 用户报障：标题写成 `### 林一鸣（**男主，21岁，大四或刚毕业待业**）` 时，
// 目录里连 `**` 一起显示。
//
// 为什么会长这样：本编辑器的标记符是**真实文本**（带 `mdMarker` mark），
// 所以 `node.textContent` 天然包含 `**` / `*` / `~~` / `` ` ``。
// 这里用**最小 schema** 造出等价文档来钉住 headingPlainText 的语义
//（不需要 DOM、不需要 Electron，毫秒级）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { headingPlainText } from '../src/renderer/src/lib/editor/outlineText.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' }
  },
  marks: {
    mdMarker: { attrs: { style: { default: 'bold' }, side: { default: 'start' } } }
  }
})

const marker = (s) => schema.text(s, [schema.marks.mdMarker.create({ style: 'bold' })])
const heading = (children) => schema.nodes.heading.create({ level: 3 }, children)

test('headingPlainText：跳过 mdMarker 的标记文本（`**` 不进大纲）', () => {
  // `### 林一鸣（**男主，21岁**）`
  const h = heading([
    schema.text('林一鸣（'),
    marker('**'),
    schema.text('男主，21岁'),
    marker('**'),
    schema.text('）')
  ])
  assert.equal(headingPlainText(h), '林一鸣（男主，21岁）')
})

test('headingPlainText：行内代码 / 删除线 / 斜体的标记也一并去掉', () => {
  const h = heading([
    marker('`'),
    schema.text('npm run dev'),
    marker('`'),
    schema.text(' 与 '),
    marker('~~'),
    schema.text('旧'),
    marker('~~')
  ])
  assert.equal(headingPlainText(h), 'npm run dev 与 旧')
})

test('headingPlainText：正文里的字面星号要留着（只按 mark 过滤，不按字符剥）', () => {
  // 转义过的 `\*` 是正文（没有 mdMarker），大纲里应当看得见
  const h = heading([schema.text('5 * 3 = 15')])
  assert.equal(headingPlainText(h), '5 * 3 = 15')
})

test('headingPlainText：硬换行折成空格，全空时给兜底文案', () => {
  const h = heading([schema.text('第一行'), schema.nodes.hardBreak.create(), schema.text('第二行')])
  assert.equal(headingPlainText(h), '第一行 第二行')
  assert.equal(headingPlainText(heading([marker('**'), marker('**')])), '（无标题）')
  assert.equal(headingPlainText(heading([]), '空标题'), '空标题')
})
