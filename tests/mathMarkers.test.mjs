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
import { renderMath, mathRenderInfo } from '../src/renderer/src/lib/editor/mathMarkers.ts'

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

test('renderMath：坏公式不抛，渲染成一句可读的错误（公式写错不该崩掉整篇）', () => {
  const html = renderMath('\\badcommand{', false)
  assert.match(html, /class="md-math-error"/)
  // ⚠️ 第二十九轮改了口径：这里**不再**是 "KaTeX 自己画的 katex-error"。
  // 原因（实测）：`throwOnError:false` 对**未定义宏**是静默的 —— `\ce{H2O}` 会被当成
  // 普通文字画出来（既无 katex-error 也不抛），错误态因此无从判断。现在一律
  // `throwOnError:true` 自己接住，渲染成 KaTeX 给的**人话**（说明哪个宏、在哪个位置）。
  assert.equal(html.includes('katex-error'), false)
  assert.match(html, /Undefined control sequence/)
  assert.match(html, /\\badcommand/)
})

test('renderMath：未定义宏**必须**算错（strict:false 不许静默当普通文字画出来）', () => {
  // 这一条钉的是"静默降级"这个坑：mhchem 的 `\ce`、plain TeX 的 `\today` 都不在 KaTeX 核心里，
  // 用户写了它们就该看到错误，而不是一段看着像公式的普通文字。
  for (const tex of ['\\ce{H2O}', '\\today', '\\notarealmacro{x}']) {
    const info = mathRenderInfo(tex, false)
    assert.equal(info.error, true, `${tex} 应当被认成错误`)
    assert.match(info.html, /class="md-math-error"/, `${tex} 应当渲染成错误态`)
  }
  // 反向对照：这些是真的能画的，不许被误判成错误
  for (const tex of [
    'E = mc^2',
    '\\frac{1}{2}',
    '\\begin{align} a &= b \\\\ c &= d \\end{align}',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '\\text{中文说明}'
  ]) {
    const info = mathRenderInfo(tex, true)
    assert.equal(info.error, false, `${tex} 应当正常渲染`)
    assert.match(info.html, /class="katex"/, `${tex} 应当有 katex 产物`)
  }
})

test('renderMath：非字符串输入走兜底分支（**不抛**）', () => {
  const html = renderMath({ toString: () => '<img src=x onerror=alert(1)>' }, false)
  // 属性顺序不写死（`title` 是第二十九轮加的），只要求外层是那个兜底 `<code>`
  assert.match(html, /^<code class="md-math-error"/)
  // KaTeX 自己就拒了非字符串输入，这句话比"把对象字符串化再画一遍"更准确
  assert.match(html, /only parse string/)
  assert.equal(html.includes('<img'), false)
  // undefined / null 也不该抛
  assert.equal(renderMath(undefined, false).includes('md-math-error'), true)
  assert.equal(renderMath(null, false).includes('md-math-error'), true)
})

test('renderMath：兜底分支**必须转义** —— 错误信息里带 HTML 也不许进 DOM', () => {
  // 构造一个"原始字符串合法、但 LaTeX 未知宏把 HTML 带进 KaTeX 错误信息"的输入
  const html = renderMath('\\notarealmacro{"<img src=x onerror=alert(1)>"}', false)
  assert.match(html, /^<code class="md-math-error"/)
  assert.equal(html.includes('<img'), false, '未转义的 <img 绝不能进产物')
  assert.match(html, /&lt;img/)
  assert.equal(/onerror=alert/.test(html.replace(/&lt;/g, '')), false)
})

test('renderMath：产物里不留 javascript: 协议（`\\href` 在 trust 默认 false 下被拒）', () => {
  const html = renderMath('\\href{javascript:alert(1)}{x}', false)
  assert.equal(html.includes('javascript:'), false)
})

test('renderMath：公式源里的尖括号不会变成真标签', () => {
  const html = renderMath('<script>alert(1)</script>', false)
  assert.equal(/<script/i.test(html), false)
})
