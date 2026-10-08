'use strict'
// ─── 验收：公式的**点击编辑**（点击公式 → 上方源码框 → 逐键实时渲染）─────────────
//
// 与 `_verify-math.js` 的分工：那条守「渲染出来了 + 原文逐字往返 + 坏公式不崩」，
// 这条守**用户口径的交互**（第二十九轮）：
//   「点击公式时，会在公式**上方**展示公式的源码（可编辑），像 Typora 一样，
//     可以编辑公式实时渲染，大小适中、布局合理。」
//
// 六条断言（照任务口径逐条落）：
//   E1 渲染出公式 DOM（KaTeX 标志类名）+ 序列化文本仍是原文（保真）
//   E2 点击公式 → 源码框出现、且**位于公式上方**（矩形比较 + 容差），框里是公式源码
//   E3 在框里改一处 → 公式 DOM 文本随之变（**不重开编辑器、不重载文档**），且序列化同步
//   E4 坏公式 → 有错误态、渲染器不抛未捕获异常、文档其余部分仍可编辑、源码不丢
//   E5 尺寸/布局 → 行内与正文字号比例在区间内；块级在正文列内居中；超宽公式不横向溢出
//   E6 不许破坏 → 代码块里的 `$` 不算公式；`\$` 转义仍是字面美元；`**加粗**` 显隐仍正常
//
// ⚠️ 本套房件**故意把公式放在文档靠下**：源码框"上方优先、上方放不下才翻到下方"
//   是设计（见 mathPreview.ts 的 placeBox），窗口顶部那种位置翻到下方是**正确行为**，
//   拿它判红会把"设计"当成"缺陷"。所以定位断言用一个上方确实有空间的位置。
//
// 跑法：node tools/_verify-math-edit.js（先起隔离实例；或交给 tools/run-suites.js）
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

/** 正文（公式在第 6 段，离窗口顶部足够远 ⇒ 源码框有地方放在"上方"） */
const MD = [
  '第一段正文，用来把下面的公式推到视口中部。',
  '',
  '第二段正文。',
  '',
  '行内公式在这里：$E = mc^2$ 以及 $\\frac{a}{b}$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
  '$$',
  '',
  '宽度压力：',
  '',
  '$$',
  '\\sum_{k=1}^{n}\\frac{x_k^{2}+y_k^{2}+z_k^{2}}{\\sqrt{a_k^{2}+b_k^{2}+c_k^{2}}}\\cdot\\prod_{j=1}^{m}\\left(1-\\frac{\\alpha_j}{\\beta_j+\\gamma_j}\\right)',
  '$$',
  '',
  '代码里的美元不算公式：',
  '',
  '```sh',
  'echo "$HOME and $PATH"',
  '```',
  '',
  '转义美元仍是字面量：价格 \\$5 和 \\$6。',
  '',
  '加粗显隐对照：**粗体词** 收尾。'
].join('\n')

/** 页面侧快照：状态 + 渲染 + 序列化，一次取回（少往返、少竞态） */
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
  const box = document.querySelector('[data-md-math-editor]')
  const ta = box ? box.querySelector('[data-md-math-editor-src]') : null
  const inlineRendered = document.querySelector('.md-preview .md-math-rendered')
  const blockRendered = document.querySelector('.md-preview .md-math-block .katex-display')
  const para = document.querySelector('.md-preview p')
  const katexInline = inlineRendered ? inlineRendered.querySelector('.katex') : null
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const ics = katexInline ? getComputedStyle(katexInline) : null
  const pcs = para ? getComputedStyle(para) : null
  const tacs = ta ? getComputedStyle(ta) : null
  const out = {
    mathTexts,
    blockSources,
    content: window.__L.files().current?.content ?? '',
    inlineRendered: document.querySelectorAll('.md-preview .md-math-rendered .katex').length,
    folded: document.querySelectorAll('.md-preview .md-math-source').length,
    blockRendered: document.querySelectorAll('.md-preview .md-math-block .katex-display').length,
    inlineKatexText: katexInline ? katexInline.textContent : null,
    inlineFontSize: ics ? ics.fontSize : null,
    paraFontSize: pcs ? pcs.fontSize : null,
    katexFontFaces: [...document.styleSheets].reduce((n, s) => {
      try { return n + [...s.cssRules].filter((r) => r.constructor.name === 'CSSFontFaceRule' && /KaTeX/.test(r.style.fontFamily)).length } catch { return n }
    }, 0),
    // ⚠️ 代码块在**实时渲染**面里是 CodeMirror（div.cm-content[data-language]），
    // 不是 <pre><code>（那是 Markdown 标准形态/导出形态）。所以这里按 CodeMirror 认。
    codeBlocks: Array.from(ed.state.doc.content.content).filter((n) => n.type.name === 'codeBlock')
      .map((n) => ({ lang: n.attrs.language ?? null, text: n.textContent })),
    codeCmNodes: document.querySelectorAll('.md-preview .cm-content[data-language]').length,
    strikeBold: document.querySelectorAll('.md-preview strong, .md-preview b').length,
    box: box
      ? {
          value: ta ? ta.value : null,
          side: box.getAttribute('data-md-math-editor-side'),
          invalid: box.hasAttribute('data-md-math-invalid'),
          rect: rect(box),
          taFontFamily: tacs ? tacs.fontFamily : null,
          connected: box.isConnected,
          taConnected: ta ? ta.isConnected : null,
          label: (box.querySelector('[data-md-math-editor-label]') || {}).textContent ?? null
        }
      : null,
    inlineRect: rect(inlineRendered),
    blockRect: rect(blockRendered),
    blockOuterRect: rect(document.querySelector('.md-preview .md-math-block')),
    wideRect: rect(document.querySelectorAll('.md-preview .md-math-block')[1]),
    blockDump: [...document.querySelectorAll('.md-preview .md-math-block')].map((b) => ({
      src: (b.getAttribute('data-source') || '').slice(0, 24),
      kids: [...b.children].map((c) => c.className).join('|'),
      hasDisplay: !!b.querySelector('.katex-display'),
      hasErr: !!b.querySelector('.katex-error'),
      isConnected: b.isConnected
    })),
    docBlockCount: (() => {
      let n = 0
      ed.state.doc.descendants((x) => { if (x.type.name === 'mathBlock') n += 1; return true })
      return n
    })(),
    wideOverflow: (() => {
      const el = document.querySelectorAll('.md-preview .md-math-block')[1]
      return el ? el.scrollWidth - el.clientWidth : null
    })(),
    wideInnerWidth: (() => {
      const el = document.querySelectorAll('.md-preview .md-math-block')[1]
      if (!el) return null
      const inner = el.querySelector('.katex-html')
      if (!inner) return null
      try {
        const rg = document.createRange()
        rg.selectNodeContents(inner)
        const bs = [...rg.getClientRects()].filter((b) => b.width > 0)
        return bs.length ? Math.round(Math.max(...bs.map((b) => b.right)) - Math.min(...bs.map((b) => b.left))) : null
      } catch { return null }
    })(),
    blockInnerOffset: (() => {
      const outer = document.querySelector('.md-preview .md-math-block')
      if (!outer) return null
      const inner = outer.querySelector('.katex-html')
      if (!inner) return null
      try {
        const rg = document.createRange()
        rg.selectNodeContents(inner)
        const bs = [...rg.getClientRects()].filter((b) => b.width > 0)
        if (!bs.length) return null
        const l = Math.min(...bs.map((b) => b.left))
        const r = Math.max(...bs.map((b) => b.right))
        const or = outer.getBoundingClientRect()
        return {
          leftGap: Math.round(l - or.left),
          rightGap: Math.round(or.right - r),
          inkWidth: Math.round(r - l)
        }
      } catch { return null }
    })(),
    // 诊断用（E5b 红时看现场：块数 / .katex-html 在不在 / Range 有没有拿到盒 / 计算样式）
    blockCount: document.querySelectorAll('.md-preview .md-math-block').length,
    displayCount: document.querySelectorAll('.md-preview .md-math-block .katex-display').length,
    firstHasHtml: !!document.querySelector('.md-preview .md-math-block .katex-html'),
    htmlDisplay: (() => {
      const h = document.querySelector('.md-preview .md-math-block .katex-html')
      return h ? getComputedStyle(h).display : null
    })(),
    rectCount: (() => {
      const h = document.querySelector('.md-preview .md-math-block .katex-html')
      if (!h) return null
      try {
        const rg = document.createRange()
        rg.selectNodeContents(h)
        return [...rg.getClientRects()].filter((b) => b.width > 0).length
      } catch { return -1 }
    })(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // 未捕获异常计数（E4 用：渲染器不许抛到 window.onerror）
    uncaught: window.__MATH_UNCAUGHT ?? 0
  }
  return JSON.stringify(out)
})()`

/** 页面里装一个未捕获异常计数器（E4 的判据必须是"真的没抛"，不是"看起来没崩"） */
const INSTALL_ERROR_HOOK = `(() => {
  if (window.__MATH_UNCAUGHT === undefined) {
    window.__MATH_UNCAUGHT = 0
    window.addEventListener('error', () => { window.__MATH_UNCAUGHT += 1 })
    window.addEventListener('unhandledrejection', () => { window.__MATH_UNCAUGHT += 1 })
  }
  return 'ok'
})()`

/** 在源码框里"输入"（真的派发 input 事件，与逐键同一条路径） */
function setSource(text) {
  return `(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    if (!ta) return 'NO_BOX'
    ta.value = ${JSON.stringify(text)}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`
}

const focusEditor = `(() => {
  const ed = window.__L.ed()
  ed.chain().focus().run()
  return 'ok'
})()`

async function main() {
  const report = new Reporter('验收：公式点击编辑（上方源码框 + 逐键实时渲染）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(350)
  await openDocWith(app, MD, 'math-edit.md')
  await waitEditor(app.ev)
  await app.ev(INSTALL_ERROR_HOOK)
  await sleep(900)

  // ─── E1 渲染 + 保真 ──────────────────────────────────────────────────────
  const s = JSON.parse(await app.ev(SNAPSHOT))
  report.check(
    'E1a 公式渲染成 KaTeX DOM（行内 2 个 / 块级 2 个的标志类名）',
    s.inlineRendered === 2 && s.blockRendered === 2,
    `inline=${s.inlineRendered} block=${s.blockRendered}`
  )
  report.check(
    'E1b KaTeX 样式表**本地**加载（有 @font-face，字体随包，不依赖网络）',
    s.katexFontFaces >= 10,
    `katexFontFaces=${s.katexFontFaces}`
  )
  report.check(
    'E1c 序列化文本仍是原文（`$E = mc^2$` 与 `$$…$$` 逐字保真）',
    s.mathTexts.includes('$E = mc^2$') &&
      s.mathTexts.includes('$\\frac{a}{b}$') &&
      s.content.includes('$E = mc^2$') &&
      s.content.includes('\\int_0^1 x^2\\,dx = \\frac{1}{3}') &&
      s.content.includes('$$'),
    `mathTexts=${JSON.stringify(s.mathTexts)}`
  )

  // ─── E2 点击 → 上方源码框 ────────────────────────────────────────────────
  const inlinePos = await centerOf(app.ev, '.md-preview .md-math-rendered')
  if (!inlinePos) {
    report.skip('E2 点击公式 → 上方源码框', '页面上没有行内公式')
  } else {
    await clickAt(app.send, inlinePos.x, inlinePos.y)
    await sleep(450)
    const open = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E2a 点击公式出现源码框，且框里就是公式源码',
      !!open.box && open.box.value === 'E = mc^2',
      `box=${open.box ? JSON.stringify(open.box.value) : 'null'}`
    )
    // 「上方」= 源码框底 ≤ 公式顶 + 容差（容差 2px：整数化的取整误差）
    const above = !!open.box && open.box.rect.bottom <= open.inlineRect.top + 2
    report.check(
      'E2b 源码框位于公式**上方**（框底 ≤ 公式顶 + 2px 容差）',
      above,
      `boxBottom=${open.box?.rect.bottom} formulaTop=${open.inlineRect.top} side=${open.box?.side}`
    )
    report.check(
      'E2c 源码框用等宽字体（与公式视觉成一组，不是正文衬线体）',
      !!open.box && /mono|Cascadia|Consolas|JetBrains/i.test(open.box.taFontFamily ?? ''),
      `fontFamily=${open.box?.taFontFamily}`
    )
    report.check(
      'E2d 源码框出现**不改变**公式的渲染态（公式仍然画着，没变成 `$…$` 源码）',
      open.inlineRendered === 2 && open.folded === 2,
      `rendered=${open.inlineRendered} folded=${open.folded}`
    )

    // ─── E3 逐键实时渲染 ───────────────────────────────────────────────────
    const before = open.inlineKatexText
    await app.ev(setSource('E = mc^3'))
    await sleep(400)
    const changed = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E3a 框里改一处 → 公式 DOM 文本随之变化（不重开、不重载）',
      changed.inlineKatexText !== before && /mc3/.test(changed.inlineKatexText ?? ''),
      `before=${JSON.stringify(before)} after=${JSON.stringify(changed.inlineKatexText)}`
    )
    report.check(
      'E3b 序列化文本同步更新（且仍是 `$…$` 原文形态）',
      changed.content.includes('$E = mc^3$') && !changed.content.includes('$E = mc^2$'),
      `has mc3=${changed.content.includes('$E = mc^3$')}`
    )
    report.check(
      'E3c 实时渲染后源码框仍开着、且仍指向这一条公式',
      !!changed.box && changed.box.value === 'E = mc^3',
      `box=${JSON.stringify(changed.box?.value)}`
    )

    // Esc 收起（语义：收起但不改内容）
    await app.ev(focusEditor)
    await sleep(100)
    await clickAt(app.send, inlinePos.x, inlinePos.y)
    await sleep(350)
    const reopened = await app.ev(`!!document.querySelector('[data-md-math-editor]')`)
    await app.ev(`(() => {
      const ta = document.querySelector('[data-md-math-editor-src]')
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'ok'
    })()`)
    await sleep(350)
    const afterEsc = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E3d Esc 收起源码框，且**不改内容**（`$E = mc^3$` 仍在）',
      reopened === true && afterEsc.box === null && afterEsc.content.includes('$E = mc^3$'),
      `reopened=${reopened} box=${afterEsc.box === null ? 'null' : 'open'}`
    )
  }

  // ─── E4 坏公式：有错误态、不抛、别处仍可编辑、源码不丢 ────────────────────
  const blockPos = await centerOf(app.ev, '.md-preview .md-math-block')
  if (!blockPos) {
    report.skip('E4 坏公式的错误态', '页面上没有块级公式')
  } else {
    await clickAt(app.send, blockPos.x, blockPos.y)
    await sleep(400)
    const blockOpen = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E4a 点击块级公式也能打开源码框（框里是块公式原文）',
      !!blockOpen.box && blockOpen.box.value === '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
      `value=${JSON.stringify(blockOpen.box?.value)}`
    )
    await app.ev(setSource('\\frac{1}{'))
    await sleep(450)
    const broken = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E4b 坏公式有**明确错误态**（data-md-math-invalid + 文档不脏）',
      broken.box !== null && broken.box.invalid === true && broken.content.includes('\\frac{1}{'),
      `invalid=${broken.box?.invalid} sourceKept=${broken.content.includes('\\frac{1}{')}`
    )
    report.check(
      'E4c 坏公式**不抛未捕获异常**（window 的 error/unhandledrejection 计数仍为 0）',
      broken.uncaught === 0,
      `uncaught=${broken.uncaught}`
    )
    // 文档其余部分仍可编辑：在末尾插一段文字。
    // ⚠️ 这一步会把焦点拿走 → 源码框按设计**失焦收起**（内容保留），所以下面要复原坏公式
    //    必须**重新点开**那条公式；不然写入的是一个已经收起的会话（这个坑本套件踩过一次）。
    const editable = await app.ev(`(() => {
      const ed = window.__L.ed()
      const size = ed.state.doc.content.size
      return ed.chain().focus().insertContentAt(size - 1, ' 仍然可编辑。').run() ? 'ok' : 'fail'
    })()`)
    await sleep(400)
    const afterTyping = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E4d 坏公式旁边文档仍可编辑，且坏公式的源码不丢',
      editable === 'ok' &&
        afterTyping.content.includes('仍然可编辑。') &&
        afterTyping.content.includes('\\frac{1}{'),
      `editable=${editable} kept=${afterTyping.content.includes('\\frac{1}{')}`
    )
    report.check(
      'E4e 焦点移走后源码框按设计**失焦收起**（内容没丢）',
      afterTyping.box === null && afterTyping.content.includes('\\frac{1}{'),
      `box=${afterTyping.box === null ? 'closed' : 'open'}`
    )
    // 复原（后续尺寸断言用一个渲染正常的块公式）：重新点开那一条再写回去
    const reopen = await centerOf(app.ev, '.md-preview .md-math-block')
    await clickAt(app.send, reopen.x, reopen.y)
    await sleep(400)
    await app.ev(setSource('\\int_0^1 x^2\\,dx = \\frac{1}{3}'))
    await sleep(400)
    const restored = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E4f 把源码改回合法公式 → 错误态消失、公式重新画出来',
      restored.blockRendered === 2 && restored.content.includes('\\int_0^1 x^2\\,dx = \\frac{1}{3}'),
      `blockRendered=${restored.blockRendered}`
    )
    await app.ev(`(() => {
      const ta = document.querySelector('[data-md-math-editor-src]')
      if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'ok'
    })()`)
    await sleep(300)
  }

  // ─── E5 尺寸 / 布局 ─────────────────────────────────────────────────────
  const layout = JSON.parse(await app.ev(SNAPSHOT))
  const inlineSize = parseFloat(layout.inlineFontSize ?? '0')
  const paraSize = parseFloat(layout.paraFontSize ?? '0')
  const ratio = paraSize ? inlineSize / paraSize : 0
  // 口径：行内公式的字号应当在正文的 0.95~1.30 倍之间 —— 小于 0.95 会显得"缩水"，
  // 大于 1.3 会在行里顶出行高、把正文行距撑开。实测本仓为 1.06（KaTeX 默认 1.21em
  // 被 `.md-preview .katex { font-size: 1.06em }` 收到 1.06）。
  report.check(
    'E5a 行内公式字号 / 正文字号在 0.95~1.30 之间',
    ratio >= 0.95 && ratio <= 1.3,
    `inline=${inlineSize}px para=${paraSize}px ratio=${ratio.toFixed(3)}`
  )
  const ink = layout.blockInnerOffset
  report.check(
    'E5b 块级公式在正文列内居中（左右留白差 ≤ 8px）',
    !!ink && Math.abs(ink.leftGap - ink.rightGap) <= 8,
    ink ? `leftGap=${ink.leftGap} rightGap=${ink.rightGap} ink=${ink.inkWidth}` : 'no block'
  )
  report.check(
    'E5c 超宽公式**不横向溢出**（scrollWidth ≤ clientWidth + 1）',
    layout.wideOverflow !== null && layout.wideOverflow <= 1,
    `overflow=${layout.wideOverflow} inkWidth=${layout.wideInnerWidth} colWidth=${layout.blockOuterRect?.width}`
  )
  report.check(
    'E5d 块级公式宽度被正文列夹住（要么放得下、要么在块内横向滚动）',
    !!layout.wideRect &&
      layout.wideRect.width <= (layout.blockOuterRect?.width ?? 0) + 1 &&
      (layout.wideInnerWidth ?? 0) >= 0,
    `wideBlock=${layout.wideRect?.width} contentCol=${layout.blockOuterRect?.width}`
  )

  // ─── E6 不许破坏的对照 ──────────────────────────────────────────────────
  report.check(
    'E6a 代码块里的 `$` 不被当成公式（围栏代码块仍是 codeBlock，内容逐字保留）',
    layout.codeBlocks.length === 1 &&
      layout.codeBlocks[0].lang === 'sh' &&
      layout.codeBlocks[0].text === 'echo "$HOME and $PATH"' &&
      layout.codeCmNodes === 1 &&
      !layout.mathTexts.some((t) => t.includes('HOME')),
    `codeBlocks=${JSON.stringify(layout.codeBlocks)} cmNodes=${layout.codeCmNodes} mathTexts=${JSON.stringify(layout.mathTexts)}`
  )
  report.check(
    'E6b `\\$` 转义仍是字面美元（没被吃成公式）',
    layout.content.includes('\\$5') && layout.content.includes('\\$6'),
    `content has \\$5=${layout.content.includes('\\$5')}`
  )
  report.check(
    'E6c `**加粗**` 的显隐机制仍正常（文档里是真加粗节点，标记仍可序列化回来）',
    layout.strikeBold >= 1 && layout.content.includes('**粗体词**'),
    `strongNodes=${layout.strikeBold} contentKeepsMarkers=${layout.content.includes('**粗体词**')}`
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
