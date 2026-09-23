// ─── 静态态语法高亮（F 项 / O2 虚拟化的 P2）──────────────────────────────────
//
// 虚拟化之后，没轮到挂 CodeMirror 的代码块渲染 `.cb-static`（等宽纯文本）。
// P2 用 Lezer 的 `highlightTree` 给它上色 —— 本文件只测**纯函数**那一半：
//   ① 转义：静态态是 `v-html` 渲染的，文本必须逐字转义（`<img onerror>` 不能变成元素）；
//   ② token 包壳：命中的区间要包成 `<span class="lm-tok-*">`，且**去掉标签后与原文逐字相同**
//      （高亮不许改内容 —— 与「标记即真实文本」的既有口径一致）；
//   ③ 语言没加载过时退化成纯转义文本（见 staticHighlight.ts 文件头第 2 点：不为屏幕外的块拉语言包）；
//   ④ class 映射表与 CSS 一一对应（改一边忘另一边 = 挂载/静态两态配色不一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import {
  TOKEN_CLASS,
  staticHighlighter,
  highlightToHtml,
  staticHighlightHtml,
  registerStaticParser,
  hasStaticParser,
  staticParserCount
} from '../src/renderer/src/lib/editor/staticHighlight.ts'

const stripTags = (html) => html.replace(/<[^>]*>/g, '')
const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

test('静态态：文本逐字转义（v-html 的前提）', () => {
  const evil = 'const a = "</code><img src=x onerror=alert(1)>"'
  const html = highlightToHtml(evil, null)
  assert.ok(!html.includes('<img'), '不能出现真实标签')
  assert.ok(html.includes('&lt;img'), '尖括号要转义')
  assert.equal(unescape(stripTags(html)), evil, '去标签 + 反转义必须与原文逐字相同')
})

test('静态态：token 包壳不改内容（去标签后逐字相同）', () => {
  const code = 'function f(x) {\n  // 注释\n  return x + 1\n}\n'
  const tree = javascriptLanguage.parser.parse(code)
  const html = highlightToHtml(code, tree)
  assert.ok(/<span class="lm-tok-/.test(html), '至少要有一个 token span')
  assert.equal(unescape(stripTags(html)), code, '高亮只加壳，不改一个字符')
})

test('静态态：文本里的 HTML 特殊字符在 token 内也被转义', () => {
  const code = 'const s = "a<b>c&d"\n'
  const tree = javascriptLanguage.parser.parse(code)
  const html = highlightToHtml(code, tree)
  assert.ok(!/<b>/.test(html), '不能留下真实标签')
  assert.equal(unescape(stripTags(html)), code)
})

test('静态态：语言没登记过 ⇒ 纯转义文本（不 import 语言包）', () => {
  assert.equal(hasStaticParser('__never_registered__'), false)
  const html = staticHighlightHtml('const a = 1 // c', '__never_registered__')
  assert.equal(html.includes('lm-tok-'), false, '没登记的语言不该有 token 壳')
  assert.equal(unescape(stripTags(html)), 'const a = 1 // c')
})

test('静态态：登记解析器之后才上色（登记表是唯一开关）', () => {
  const before = staticParserCount()
  registerStaticParser('javascript', javascriptLanguage.parser)
  assert.equal(hasStaticParser('javascript'), true)
  assert.equal(staticParserCount(), before + 1)
  const html = staticHighlightHtml('const a = 1', 'javascript')
  assert.ok(html.includes('lm-tok-'), '登记之后静态态要带 token 壳')
})

test('静态态：class 名与 CSS 一一对应（改一边忘另一边会被这条抓住）', () => {
  const css = readFileSync(
    new URL('../src/renderer/src/assets/overlays.css', import.meta.url),
    'utf-8'
  )
  for (const cls of Object.values(TOKEN_CLASS)) {
    assert.ok(css.includes('.' + cls), `overlays.css 缺少 .${cls} 的样式`)
  }
})

test('静态态：高亮器的 tag 映射覆盖各主要 token 类型', () => {
  // 用一个真实语法树跑出来的 class 集合应当不止一种（否则等于没上色）
  const code = '// 注释\nfunction f(x) { return "s" + x }\nconst n = 42\n'
  const tree = javascriptLanguage.parser.parse(code)
  const classes = new Set(
    [...highlightToHtml(code, tree).matchAll(/class="(lm-tok-[a-z]+)"/g)].map((m) => m[1])
  )
  assert.ok(classes.size >= 3, '注释/函数/字符串/数字应当产生多种 token：' + [...classes].join(','))
  assert.ok(classes.has(TOKEN_CLASS.comment), '注释要命中 comment：' + [...classes].join(','))
  assert.ok(staticHighlighter.style([]) === null, '空 tag 列表返回 null（不包壳）')
})
