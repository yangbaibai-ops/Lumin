// 查找/替换纯逻辑（src/renderer/src/lib/findReplace.ts）的单测。
//
// 这层决定「搜到什么、下一个是哪个、替换成什么」。判错的后果不是"少高亮一个"，
// 而是**替换掉不该替换的内容**（正则元字符被当语法、位置算错改到别处），
// 所以边界要逐条钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeRegExp,
  findInRuns,
  findMatches,
  replaceMatches,
  runsToText,
  stepIndex
} from '../src/renderer/src/lib/findReplace.ts'

test('查询串按字面量处理：正则元字符不是语法', () => {
  assert.equal(escapeRegExp('a*b'), 'a\\*b')
  assert.equal(escapeRegExp('a.b(c)'), 'a\\.b\\(c\\)')
  assert.equal(escapeRegExp('a+b?'), 'a\\+b\\?')
  // `a*b` 只应该匹配字面量 "a*b"，不该匹配 "axb"
  assert.equal(findMatches('a*b axb a*b', 'a*b').length, 2)
})

test('大小写：默认不敏感，开关后敏感', () => {
  assert.equal(findMatches('Bold bold BOLD', 'bold').length, 3)
  assert.equal(findMatches('Bold bold BOLD', 'bold', { caseSensitive: true }).length, 1)
})

test('空查询 / 空文本 → 没有匹配（不会把整篇当成一个匹配）', () => {
  assert.deepEqual(findMatches('abc', ''), [])
  assert.deepEqual(findMatches('', 'a'), [])
})

test('匹配按出现顺序、互不重叠', () => {
  assert.deepEqual(findMatches('aaaa', 'aa'), [
    { from: 0, to: 2 },
    { from: 2, to: 4 }
  ])
})

test('runsToText：多个片段拼起来，位置映射指回文档坐标', () => {
  // 片段一在文档 5..8（"abc"），片段二在文档 20..22（"de"）
  const { text, posOf } = runsToText([
    { from: 5, text: 'abc' },
    { from: 20, text: 'de' }
  ])
  assert.equal(text, 'abcde')
  assert.deepEqual(posOf.slice(0, 5), [5, 6, 7, 20, 21])
  assert.equal(posOf[5], 22, '末尾哨兵 = 最后一个字符之后')
})

test('findInRuns：跨文本节点的匹配也要能落在文档位置上', () => {
  // "粗" 在 3，"体" 在 9（中间隔着一个非文本节点/另一段 mark）
  const runs = [
    { from: 3, text: '粗' },
    { from: 9, text: '体字' }
  ]
  assert.deepEqual(findInRuns(runs, '体字'), [{ from: 9, to: 11 }])
  // 跨节点的连续内容也能匹配（拼起来是 "粗体字"）
  assert.deepEqual(findInRuns(runs, '粗体'), [{ from: 3, to: 10 }])
})

test('stepIndex：循环前进/后退，越界回绕，无匹配返回 -1', () => {
  assert.equal(stepIndex(3, 0, 1), 1)
  assert.equal(stepIndex(3, 2, 1), 0, '末尾的下一个绕回开头')
  assert.equal(stepIndex(3, 0, -1), 2, '开头的上一个绕到末尾')
  assert.equal(stepIndex(3, -1, 1), 0, '还没有当前位置时前进 → 第一个')
  assert.equal(stepIndex(0, 0, 1), -1)
})

test('replaceMatches：从后往前替换，位置不会互相顶掉', () => {
  const text = 'foo bar foo'
  const matches = findMatches(text, 'foo')
  assert.equal(replaceMatches(text, matches, 'X'), 'X bar X')
  // 替换串更长也不会串位
  assert.equal(replaceMatches(text, matches, 'FOO!'), 'FOO! bar FOO!')
})

test('replaceMatches：越界/倒序的匹配原样返回（脏数据不毁整篇）', () => {
  assert.equal(replaceMatches('abc', [{ from: 2, to: 9 }], 'X'), 'abc')
  assert.equal(replaceMatches('abc', [{ from: 3, to: 1 }], 'X'), 'abc')
})

test('替换成空串 = 删除命中内容', () => {
  assert.equal(replaceMatches('a-b-c', findMatches('a-b-c', '-'), ''), 'abc')
})

test('替换串里的 $& 之类不会被当正则替换语法（我们是纯字符串拼接）', () => {
  assert.equal(replaceMatches('x', findMatches('x', 'x'), '$&$1'), '$&$1')
})
