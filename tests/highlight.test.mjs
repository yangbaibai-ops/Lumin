// 搜索高亮分段（renderer/lib/highlight.ts）
//
// 重点是**安全属性**：片段是文档正文（用户可控），必须全部作为**文本**交给 Vue 渲染，
// 不能有任何一条路径能把内容变成 HTML —— 这正是当初从 `v-html` 换成分段渲染的原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightSegments } from '../src/renderer/src/lib/highlight.ts'

const HIT = '\u0001'
const END = '\u0002'

test('命中标记被切成「命中/非命中」两段', () => {
  const segs = highlightSegments(`前面 ${HIT}命中${END} 后面`)
  assert.deepEqual(segs, [
    { text: '前面 ', hit: false },
    { text: '命中', hit: true },
    { text: ' 后面', hit: false }
  ])
})

test('多个命中段与相邻命中段都能正确还原', () => {
  const segs = highlightSegments(`${HIT}a${END}中间${HIT}b${END}${HIT}c${END}`)
  assert.deepEqual(segs, [
    { text: 'a', hit: true },
    { text: '中间', hit: false },
    { text: 'b', hit: true },
    { text: 'c', hit: true }
  ])
})

test('没有标记时是单个非命中段', () => {
  assert.deepEqual(highlightSegments('纯文本'), [{ text: '纯文本', hit: false }])
  assert.deepEqual(highlightSegments(''), [])
})

test('正文里的 HTML 一律保持为文本（不产生标签）', () => {
  const segs = highlightSegments(`<img src=x onerror=alert(1)> ${HIT}<script>${END}`)
  const html = segs.map((s) => s.text).join('')
  assert.ok(html.includes('<img src=x onerror=alert(1)>'))
  assert.ok(html.includes('<script>'))
  // 关键：段里只有文本，没有任何「被解析成标签」的可能（渲染时由 Vue 转义）
  assert.deepEqual(
    segs.map((s) => s.hit),
    [false, true]
  )
})

test('控制字符不会被带到任何一段的文本里', () => {
  const segs = highlightSegments(`${HIT}命中${END}`)
  for (const seg of segs) {
    assert.ok(!seg.text.includes(HIT) && !seg.text.includes(END))
  }
})
