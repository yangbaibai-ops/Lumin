// ─── 公式源码高亮的分词（第三十一轮新增逻辑，只测这一层）────────────────────────
//
// 为什么这里只钉"分词"两件事：
//   ① **文本不许变**：高亮是纯视图，用户文件里仍是 `\frac{a}{b}` —— 分词只是把原文切段，
//      拼回去必须逐字（含所有空白）等于原文。这条一破就是内容损坏，必须逐字钉；
//   ② **该认出来的类要认出来**：命令 / 花括号 / 数字 / 注释 / 普通文本各有自己的类名，
//      免得"看起来上了色"其实只染了一类（用户口径：至少三类可见区分）。
// 颜色值本身不在这里比（那是主题令牌的事，已由 tests/themeTokens.test.mjs 守）；
// 真实 DOM 里的"≥3 类不同颜色"由 tools/_verify-math-edit.js 的 H 段按计算样式复核。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATH_TOKEN_CLASS, tokenizeTex } from '../src/renderer/src/lib/editor/mathHighlight.ts'

const join = (tex) =>
  tokenizeTex(tex)
    .map((t) => t.text)
    .join('')

test('分词：拼回去**逐字**等于原文（含空白、反斜杠、花括号、美元、中文）', () => {
  const samples = [
    '',
    'E = mc^2',
    '\\frac{a}{b}',
    '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
    '\\begin{align} a &= b \\\\ c &= d \\end{align}',
    '\\sqrt[3]{x} + \\alpha_1^{2}',
    '% 这是注释\n\\frac{1}{2}',
    '\\text{中文 与 空格}',
    'a\\',
    '\\',
    '价格 \\$5',
    '1.25 + 3',
    '  \\frac { 1 } { 2 }  ',
    '\\left(\\frac{a}{b}\\right)'
  ]
  for (const s of samples) assert.equal(join(s), s, `分词改动了原文：${JSON.stringify(s)}`)
})

test('分词：把 LaTeX 命令、花括号、普通文本分成不同的类（≥3 类，含数字与注释）', () => {
  const classes = new Set(tokenizeTex('\\frac{1}{a} + 2 % 注').map((t) => t.cls))
  for (const want of ['cmd', 'brace', 'num', 'com', 'plain']) {
    assert.ok(classes.has(want), `没分到 ${want} 类：${JSON.stringify([...classes])}`)
  }
  // 每一类都要有对应的 CSS 类名（颜色由 CSS 给，这里只保证"类名出得来"）
  for (const c of classes) assert.match(MATH_TOKEN_CLASS[c], /^md-math-tok--/)
})

test('分词：相邻同类合并（少造 DOM 节点），且命令吃掉整段反斜杠表达式', () => {
  const toks = tokenizeTex('\\frac{a}{b}')
  assert.deepEqual(
    toks.map((t) => [t.cls, t.text]),
    [
      ['cmd', '\\frac'],
      ['brace', '{'],
      ['plain', 'a'],
      // 相邻同类合并：`}{` 是一段（少一个 DOM 节点，颜色一样）
      ['brace', '}{'],
      ['plain', 'b'],
      ['brace', '}']
    ]
  )
  // `\\`（换行命令）与 `\,`（窄空格）都是命令，不能把后面的字母吞进来
  assert.deepEqual(
    tokenizeTex('a\\\\b\\,c').map((t) => [t.cls, t.text]),
    [
      ['plain', 'a'],
      ['cmd', '\\\\'],
      ['plain', 'b'],
      ['cmd', '\\,'],
      ['plain', 'c']
    ]
  )
  // 数字：`1` 与 `0.5` 各成一段，小数点跟着数字
  assert.deepEqual(
    tokenizeTex('x_1 + 0.5')
      .filter((t) => t.cls === 'num')
      .map((t) => t.text),
    ['1', '0.5']
  )
})
