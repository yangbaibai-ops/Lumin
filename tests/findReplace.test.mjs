// 查找/替换纯逻辑（src/renderer/src/lib/findReplace.ts）的单测。
//
// 这层决定「搜到什么、下一个是哪个、替换成什么」。判错的后果不是"少高亮一个"，
// 而是**替换掉不该替换的内容**（正则元字符被当语法、位置算错改到别处），
// 所以边界要逐条钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileQuery,
  escapeRegExp,
  expandGroups,
  findInRuns,
  findMatches,
  isValidQuery,
  replaceMatches,
  replaceMatchesEach,
  replacementForMatch,
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
  // Match 现在还带着命中原文与捕获组（正则替换要用），所以只比位置，不比整个对象
  assert.deepEqual(
    findMatches('aaaa', 'aa').map(({ from, to }) => ({ from, to })),
    [
      { from: 0, to: 2 },
      { from: 2, to: 4 }
    ]
  )
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
  const pos = (ms) => ms.map(({ from, to }) => ({ from, to }))
  assert.deepEqual(pos(findInRuns(runs, '体字')), [{ from: 9, to: 11 }])
  // 跨节点的连续内容也能匹配（拼起来是 "粗体字"）
  assert.deepEqual(pos(findInRuns(runs, '粗体')), [{ from: 3, to: 10 }])
})

test('findInRuns：正则捕获组要跟着位置映射一起带出来（渲染面替换靠它展开 $1）', () => {
  // 实测踩到的回归：只映射 from/to 会让 `$2$1` 静默变成空串 —— 替换「成功」了但内容是错的
  const [m] = findInRuns([{ from: 7, text: 'beta' }], '(be)(ta)', { regex: true })
  assert.deepEqual({ from: m.from, to: m.to }, { from: 7, to: 11 })
  assert.equal(m.whole, 'beta')
  assert.deepEqual(m.groups, ['beta', 'be', 'ta'])
  assert.equal(replacementForMatch('$2$1', m, { regex: true }), 'tabe')
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

test('替换串里的 $& 之类不会被当正则替换语法（字面量模式是纯字符串拼接）', () => {
  assert.equal(replaceMatches('x', findMatches('x', 'x'), '$&$1'), '$&$1')
})

// ─── 正则模式 ────────────────────────────────────────────────────────────────
// 判据是「正则表达式查找」这个功能本身：语法错不能炸、元字符要生效、捕获组要能引用。

test('正则模式：元字符当语法用（默认是字面量）', () => {
  const text = 'a1 b22 c333'
  assert.deepEqual(
    findMatches(text, '\\d+').map((m) => m.whole),
    [],
    '默认按字面量 → 找不到 \\d+'
  )
  assert.deepEqual(
    findMatches(text, '\\d+', { regex: true }).map((m) => m.whole),
    ['1', '22', '333']
  )
})

test('正则模式：`.` 与 `.*` 生效，且 `u` 标志让中文按码点匹配', () => {
  assert.equal(findMatches('axb', 'a.b', { regex: true }).length, 1)
  assert.equal(findMatches('axb', 'a.b', { regex: false }).length, 0)
  // 中文：`.` 不该把字符拆成半个代理对
  assert.deepEqual(
    findMatches('中文', '.', { regex: true }).map((m) => m.whole),
    ['中', '文']
  )
})

test('正则模式：大小写开关照常生效', () => {
  assert.equal(findMatches('AB ab', 'a.', { regex: true }).length, 2)
  assert.equal(findMatches('AB ab', 'a.', { regex: true, caseSensitive: true }).length, 1)
})

test('正则语法错误 = 零匹配 + 可查询的「非法」状态（不抛异常）', () => {
  assert.equal(compileQuery('(', { regex: true }), null)
  assert.equal(isValidQuery('(', { regex: true }), false)
  assert.deepEqual(findMatches('abc', '(', { regex: true }), [])
  // 字面量模式下 `(` 就是普通字符，永远合法
  assert.equal(isValidQuery('(', { regex: false }), true)
  assert.equal(findMatches('a(b', '(', { regex: false }).length, 1)
  // 空查询不算非法（只是没有可搜的东西）
  assert.equal(isValidQuery('', { regex: true }), true)
})

test('正则模式：零长匹配不会死循环', () => {
  // `a*` 在 "bab" 上会先零长命中 b 前的位置 —— 必须推进 lastIndex
  const m = findMatches('bab', 'a*', { regex: true })
  assert.ok(m.length >= 2 && m.length <= 8, `零长匹配数量异常：${JSON.stringify(m)}`)
})

test('捕获组随匹配一起带出来（$1 / $& / $$）', () => {
  const [m] = findMatches('foo=42', '(\\w+)=(\\d+)', { regex: true })
  assert.equal(m.whole, 'foo=42')
  assert.deepEqual(m.groups, ['foo=42', 'foo', '42'])
  assert.equal(expandGroups('$1 -> $2', m), 'foo -> 42')
  assert.equal(expandGroups('[$&]', m), '[foo=42]')
  assert.equal(expandGroups('$$1', m), '$1')
})

test('规范外的 $ 写法原样保留（不悄悄吃掉用户写的替换串）', () => {
  const [m] = findMatches('ab', '(a)', { regex: true })
  assert.equal(expandGroups('$9', m), '$9', '只有 1 个组时 $9 原样')
  assert.equal(expandGroups('$1x', m), 'ax', '$1 后面跟字母是「组 + 字面量」')
  assert.equal(expandGroups('$x$', m), '$x$')
})

test('两位组号优先整体，不存在时退回一位（与规范一致）', () => {
  // $12 先试第 12 组：不存在 → 退回「$1 + 字面 2」
  const two = { from: 0, to: 1, whole: 'W', groups: ['W', 'a', 'b'] }
  assert.equal(expandGroups('$12', two), 'a2')
  // 真有第 12 组时按第 12 组取
  const twelve = {
    from: 0,
    to: 1,
    whole: 'W',
    groups: Array.from({ length: 13 }, (_, i) => `g${i}`)
  }
  assert.equal(expandGroups('$12', twelve), 'g12')
})

test('replacementForMatch：字面量模式不解释 $1（用户就是想插 $1）', () => {
  const [m] = findMatches('abc', 'b')
  assert.equal(replacementForMatch('$1', m, { regex: false }), '$1')
  const [r] = findMatches('abc', '(b)', { regex: true })
  assert.equal(replacementForMatch('[$1]', r, { regex: true }), '[b]')
})

test('正则替换：每处用各自的捕获组（replaceMatchesEach）', () => {
  const text = 'a=1 b=22'
  const matches = findMatches(text, '(\\w)=(\\d+)', { regex: true })
  const out = replaceMatchesEach(text, matches, (m) =>
    replacementForMatch('$2:$1', m, { regex: true })
  )
  assert.equal(out, '1:a 22:b')
})

test("命中前后记号（$` 与 $'）不支持：原样保留", () => {
  // 位置语义在渲染面不同源（文档坐标 ≠ 纯文本偏移），给个「大部分时候对」的实现更坏
  const [m] = findMatches('abc', 'b', { regex: true })
  assert.equal(expandGroups('$`', m), '$`')
  assert.equal(expandGroups("$'", m), "$'")
})
