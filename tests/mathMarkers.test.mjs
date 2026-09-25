// ─── 公式渲染 renderMath（审计 §10 P1「48 个 ≥80 行的 src 文件在 tests 里零引用」）──
//
// `mathMarkers.ts` 一直是零引用文件里最大的一类（Mark/Node 定义 + 渲染）。
// 它的**渲染出口**是纯函数：`renderMath(source, display)` → KaTeX HTML 字符串。
// 这里只钉四件"错了会让人丢内容或吃安全问题"的事：
//   ① 行内 / 块级的包裹不同（块级要靠 `katex-display` 居中，行内不能带它）；
//   ② **坏公式不抛**（`throwOnError:false`，KaTeX 自己画成 `katex-error`）——
//      公式写错不该让整篇文档崩掉；
//   ③ 真正进了 catch 的那条路（非字符串输入）返回转义后的兜底 `<code>`，**不让 HTML 进 DOM**；
//   ④ 产物里不留 `javascript:` 协议（KaTeX 的 `trust` 默认 false 把 `\href` 拒绝掉）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMath } from '../src/renderer/src/lib/editor/mathMarkers.ts'

test('renderMath：行内公式画成 katex，但**不带** katex-display（那是块级的居中包裹）', () => {
  const html = renderMath('a^2', false)
  assert.match(html, /class="katex"/)
  assert.equal(html.includes('katex-display'), false)
  assert.equal(html.includes('md-math-error'), false)
})

test('renderMath：块级公式用 katex-display 包裹（行内那份不带）', () => {
  const display = renderMath('\\frac{1}{2}', true)
  const inline = renderMath('\\frac{1}{2}', false)
  assert.match(display, /^<span class="katex-display"/)
  assert.equal(inline.includes('katex-display'), false)
  // ⚠️ 不要比长度：KaTeX 在 display 模式下排版更松，产物**可能比行内还短**
  //（实测 `\frac{1}{2}` 就是），拿长度当"多一层包裹"的证据会假红。
})

test('renderMath：坏公式不抛，交给 KaTeX 画成 katex-error（公式写错不该崩掉整篇）', () => {
  const html = renderMath('\\badcommand{', false)
  assert.match(html, /class="katex-error"/)
  assert.equal(html.includes('md-math-error'), false, '这不是"进了 catch"，而是 KaTeX 自己画的错误')
})

test('renderMath：非字符串输入走兜底分支，并**转义**（兜底分支也不许把 HTML 送进 DOM）', () => {
  const html = renderMath({ toString: () => '<img src=x onerror=alert(1)>' }, false)
  assert.match(html, /^<code class="md-math-error">/)
  assert.equal(html.includes('<img'), false)
  assert.match(html, /&lt;img/)
  // undefined / null 也不该抛
  assert.equal(renderMath(undefined, false).includes('md-math-error'), true)
  assert.equal(renderMath(null, false).includes('md-math-error'), true)
})

test('renderMath：产物里不留 javascript: 协议（`\\href` 在 trust 默认 false 下被拒）', () => {
  const html = renderMath('\\href{javascript:alert(1)}{x}', false)
  assert.equal(html.includes('javascript:'), false)
})

test('renderMath：公式源里的尖括号不会变成真标签', () => {
  const html = renderMath('<script>alert(1)</script>', false)
  assert.equal(/<script/i.test(html), false)
})
