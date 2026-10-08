'use strict'
// ─── 验收：数学公式（`$…$` 行内 / `$$…$$` 块级，KaTeX 渲染）───────────────────
//
// 三件事一起验：
//   1. **原文留在文档里**（模型是「标记文本即源码」：公式就是一个带 mdMath mark 的文本节点，
//      序列化逐字写回）—— 保真套件管这一层；
//   2. **渲染成公式**（行内靠 widget + 折叠装饰、块级靠 NodeView）—— 这一条只有真跑起来才看得见；
//   3. **点击公式 → 公式上方浮出可编辑源码框**（第二十九轮按用户口径重做）。
//
// ⚠️ 第二十九轮改了交互口径（见 `_verify-math-edit.js` 的详细版本）：
//   旧口径 =「光标落进公式就露出 `$…$` 原文」（原地替换）；用户报障两个毛病：
//     ① 在公式旁打字会把它变成源码（看着像闪烁）；② 源码只是原地露出来，不是 Typora 那样
//     "上方一个可编辑的框"。新口径 = 公式**恒为渲染态**，**点击**才在上方浮出源码框。
//   所以本套件里「光标落进去 → 折叠数减少」那条断言已按新语义改写（M6）。
//
// 跑法：node tools/_verify-math.js（先起隔离实例）

const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  centerOf,
  clickAt,
  openDocWith,
  fatal
} = require('./lib/harness')

const MD = [
  '行内公式：$E = mc^2$ 与 $a^2 + b^2 = c^2$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\int_0^1 x^2 dx = \\frac{1}{3}',
  '$$',
  '',
  '下划线不当斜体：$x_1 + y_2$；星号不当加粗：$a * b$。'
].join('\n')

const SNAPSHOT = `(() => {
  const ed = window.__L.ed()
  if (!ed) return 'null'
  const mathTexts = []
  ed.state.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'mdMath')) mathTexts.push(n.text)
  })
  const blockSources = []
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'mathBlock') blockSources.push(n.attrs.source)
  })
  return JSON.stringify({
    mathTexts,
    blockSources,
    rendered: document.querySelectorAll('.md-math-rendered .katex').length,
    folded: document.querySelectorAll('.md-math-source').length,
    blockRendered: document.querySelectorAll('.md-math-block .katex-display').length,
    editorBox: document.querySelectorAll('[data-md-math-editor]').length,
    katexFontFaces: [...document.styleSheets].reduce((n, s) => {
      try { return n + [...s.cssRules].filter((r) => r.constructor.name === 'CSSFontFaceRule' && /KaTeX/.test(r.style.fontFamily)).length } catch { return n }
    }, 0),
    content: window.__L.files().current?.content ?? ''
  })
})()`

async function main() {
  const report = new Reporter('验收：数学公式渲染（行内 + 块级）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await openDocWith(app, MD, 'math-verify.md')
  await waitEditor(app.ev)
  await sleep(700)

  const s = JSON.parse(await app.ev(SNAPSHOT))
  report.check(
    'M1 行内公式原文进文档（含 `$` 定界符，带 mdMath mark）',
    s.mathTexts.includes('$E = mc^2$') &&
      s.mathTexts.includes('$a^2 + b^2 = c^2$') &&
      s.mathTexts.includes('$x_1 + y_2$'),
    JSON.stringify(s.mathTexts)
  )
  report.check(
    'M2 行内公式渲染成 KaTeX（且原文被折叠）',
    s.rendered === 4 && s.folded === 4,
    `rendered=${s.rendered} folded=${s.folded}`
  )
  report.check(
    'M3 块级公式成为 mathBlock 且渲染成 display 公式',
    s.blockSources.length === 1 &&
      s.blockSources[0].includes('\\frac{1}{3}') &&
      s.blockRendered === 1,
    `blocks=${JSON.stringify(s.blockSources)} rendered=${s.blockRendered}`
  )
  report.check(
    'M4 公式里的下划线/星号没被当成斜体加粗（原文逐字）',
    s.mathTexts.includes('$x_1 + y_2$') && s.mathTexts.includes('$a * b$'),
    JSON.stringify(s.mathTexts)
  )
  report.check(
    'M5 落进 store 的正文仍是公式原文（往返逐字）',
    s.content.includes('$E = mc^2$') &&
      s.content.includes('$$') &&
      s.content.includes('\\int_0^1 x^2 dx = \\frac{1}{3}') &&
      s.content.includes('$x_1 + y_2$'),
    JSON.stringify(s.content).slice(0, 200)
  )
  report.check(
    'M5b KaTeX 样式表本地随包（有 @font-face，不依赖网络）',
    s.katexFontFaces >= 10,
    `katexFontFaces=${s.katexFontFaces}`
  )

  // M6：**点击**公式 → 上方浮出源码框（新口径）。
  // 旧口径是"光标落进公式就露出原文"，本轮按用户口径改成"点击 → 上方源码框"。
  const first = await centerOf(app.ev, '.md-math-rendered')
  if (!first) {
    report.skip('M6 点击公式 → 上方源码框', '页面上没有行内公式的渲染结果')
  } else {
    await clickAt(app.send, first.x, first.y)
    await sleep(400)
    const near = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'M6 点击公式 → 浮出源码框（公式**仍然画着**，不再因为光标靠近就变源码）',
      near.editorBox === 1 && near.rendered === s.rendered && near.folded === s.folded,
      `box=${near.editorBox} rendered ${s.rendered}→${near.rendered} folded ${s.folded}→${near.folded}`
    )
  }

  // M7：写坏的公式不能让整篇崩（KaTeX 报错降级成红字，原文仍在）
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const size = ed.state.doc.content.size
    ed.chain().focus().insertContentAt(size - 1, ' 坏公式：$\\\\frac{1}{$ 结束。').run()
    return 'ok'
  })()`)
  await sleep(600)
  const broken = JSON.parse(await app.ev(SNAPSHOT))
  report.check(
    'M7 坏公式：文档不崩、原文仍在（渲染失败不影响文本）',
    broken.content.includes('$\\frac{1}{$') || broken.mathTexts.some((t) => t.includes('\\frac{1}{$')),
    JSON.stringify(broken.mathTexts)
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)

