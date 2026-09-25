// 标签解析与过滤（renderer/lib/tags.ts）：纯函数，毫秒级。
//
// 审计 §7 第 19 条：标签的 DB 与 IPC 早就有、界面一处都没有。真做起来最容易出错的
// 不是 UI，而是"用户输入 → 标签数组"这一步：
//   * 用户会打 `#工作`（带井号）、`小说，第一章`（中文逗号）、`a; b`（分号）、换行粘贴；
//   * `Work` 与 `work` 应当算**同一个**标签（否则列表里会出现两个几乎一样的标签）；
//   * 标签会很长（粘贴一整句），不裁掉就会把状态栏与列表挤坏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TAG_MAX_COUNT,
  TAG_MAX_LEN,
  docMatchesFilter,
  formatTagsInput,
  normalizeTag,
  parseTagsInput
} from '../src/renderer/src/lib/tags.ts'

test('normalizeTag：去空白、去开头井号、折内部空白、裁长度', () => {
  assert.equal(normalizeTag('  小说  '), '小说')
  assert.equal(normalizeTag('#工作'), '工作')
  assert.equal(normalizeTag('##双井号'), '双井号')
  assert.equal(normalizeTag('a   b'), 'a b')
  assert.equal(normalizeTag('x'.repeat(100)).length, TAG_MAX_LEN)
  assert.equal(normalizeTag('   '), '')
  assert.equal(normalizeTag('#'), '')
})

test('parseTagsInput：四种分隔符都能切，且各语言逗号都认', () => {
  assert.deepEqual(parseTagsInput('小说, 第一章, 草稿'), ['小说', '第一章', '草稿'])
  assert.deepEqual(parseTagsInput('小说，第一章、草稿'), ['小说', '第一章', '草稿'])
  assert.deepEqual(parseTagsInput('a; b\nc\rd'), ['a', 'b', 'c', 'd'])
})

test('parseTagsInput：大小写不敏感去重（保留先出现的写法）', () => {
  assert.deepEqual(parseTagsInput('Work, work, WORK, 其它'), ['Work', '其它'])
})

test('parseTagsInput：空串/纯分隔符/纯井号都不产出标签', () => {
  assert.deepEqual(parseTagsInput(''), [])
  assert.deepEqual(parseTagsInput(' , ， 、 ; '), [])
  assert.deepEqual(parseTagsInput('#, #'), [])
})

test('parseTagsInput：数量上限', () => {
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(',')
  assert.equal(parseTagsInput(many).length, TAG_MAX_COUNT)
})

test('formatTagsInput 与 parseTagsInput 往返一致', () => {
  const tags = ['小说', 'work', '第一章']
  assert.deepEqual(parseTagsInput(formatTagsInput(tags)), tags)
})

test('docMatchesFilter：文件名 / 相对路径 / 预览 / 标签 任一处命中', () => {
  const doc = { name: 'a.md', relPath: 'notes', preview: '正文片段', tags: ['小说', 'Work'] }
  assert.equal(docMatchesFilter(doc, ''), true, '空过滤词 = 全命中')
  assert.equal(docMatchesFilter(doc, 'a.md'), true)
  assert.equal(docMatchesFilter(doc, 'notes'), true)
  assert.equal(docMatchesFilter(doc, '片段'), true)
  assert.equal(docMatchesFilter(doc, '小说'), true, '标签必须参与过滤')
  assert.equal(docMatchesFilter(doc, 'work'), true, '标签过滤大小写不敏感')
  assert.equal(docMatchesFilter(doc, '不存在'), false)
  // 没有 tags 字段的旧数据不能炸
  assert.equal(docMatchesFilter({ name: 'b.md', relPath: '', preview: '' }, 'b'), true)
})
