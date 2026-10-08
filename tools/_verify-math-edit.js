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
// ─── 第三十一轮追加：源码区「能编辑 / 点不没 / 有高亮 / 行内要紧凑」（F~J 五段）──────
//   F **真实按键**在源码区敲字（含退格）：源码文本与渲染结果都逐键跟着变、
//     焦点与源码元素都不换（打戳验证 —— 不是"看起来还能打字"，是"DOM 没被拆掉"）
//   G **点源码区任何位置都不收起**（`$$` 行 / 空白 / 顶行）；点外部 / Esc / ✓ 才收起
//   H **高亮**：源码区里 ≥3 类不同颜色的 span（给出实测色值），且高亮层文本与用户输入
//     **逐字一致**（着色不许改文本），两层逐像素对齐
//   I **行内形态**：实测尺寸 / 边框 / 内边距，且**不占整行**（宽度 < 正文列宽）
//   J 回归：往返保真 / Ctrl+Z 撤得掉源码改动 / 错误态仍可判 / 组字期间不丢字
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
  ensureFocus,
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

/** 第三十一轮那几段（F~J）专用的夹具：**每次重开**，与 E 段的中间态解耦 */
const MD2 = [
  '第三十一轮的专项夹具（源码区能编辑 / 点不没 / 有高亮 / 行内紧凑）。',
  '',
  '行内公式：$E = mc^2$ 与 $\\frac{a}{b}$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\frac{a}{b}',
  '$$',
  '',
  '收尾段。'
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
          shape: box.getAttribute('data-md-math-editor-shape'),
          invalid: box.hasAttribute('data-md-math-invalid'),
          rect: rect(box),
          taFontFamily: tacs ? tacs.fontFamily : null,
          connected: box.isConnected,
          taConnected: ta ? ta.isConnected : null,
          label: (box.querySelector('[data-md-math-editor-label]') || {}).textContent ?? null,
          // ── 第三十轮的形态（Typora 截图口径）──
          borderWidth: box ? getComputedStyle(box).borderTopWidth : null,
          borderColor: box ? getComputedStyle(box).borderTopColor : null,
          containerBg: box ? getComputedStyle(box).backgroundColor : null,
          sourceBg: (() => {
            const s = box.querySelector('.md-math-editor__source')
            return s ? getComputedStyle(s).backgroundColor : null
          })(),
          previewBg: (() => {
            const p = box.querySelector('.md-math-editor__preview')
            return p ? getComputedStyle(p).backgroundColor : null
          })(),
          srcRect: rect(box.querySelector('.md-math-editor__source')),
          previewRect: rect(box.querySelector('.md-math-editor__preview')),
          // 数学定界符分列源码上下：数它们的行、并给出 DOM 顺序
          delims: [...box.querySelectorAll('[data-md-math-editor-delim]')].map((d) => ({
            which: d.getAttribute('data-md-math-editor-delim'),
            text: d.textContent,
            top: Math.round(d.getBoundingClientRect().top),
            h: Math.round(d.getBoundingClientRect().height)
          })),
          check: (() => {
            const c = box.querySelector('[data-md-math-editor-check]')
            if (!c) return null
            return {
              tag: c.tagName,
              disabled: c.disabled === true,
              // 可聚焦：tabIndex 不小于 0 **且**未禁用（不是"看着像按钮"）。
              // 注意：这里**不能**顺手调 c.focus() 去试 —— 那会把 textarea 的焦点抢走并触发
              // 失焦收起（本套件踩过：诊断本身把被测状态改坏了）。真正的"能聚焦"由
              // E7c2 那条**不改状态**的断言守（按 Tab 语义：tabIndex 不小于 0 且未禁用）。
              tabIndex: c.tabIndex,
              focusable: c.tabIndex >= 0 && c.disabled !== true,
              ariaLabel: c.getAttribute('aria-label'),
              text: c.textContent
            }
          })(),
          // 编辑态里源码 textarea 下方的 KaTeX 字形（E7e 用它证明"下半真的更新了"）
          previewText: (() => {
            const p = box.querySelector('.md-math-editor__preview')
            const k = p ? p.querySelector('.katex') : null
            return k ? k.textContent : null
          })()
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

// ─── 第三十一轮：源码区自己的快照（F~J 段用；锚点全是稳定的 data-*）──────────────
const SRC_SNAPSHOT = `(() => {
  const box = document.querySelector('[data-md-math-editor]')
  const ta = box ? box.querySelector('[data-md-math-editor-src]') : null
  const hl = box ? box.querySelector('[data-md-math-editor-hl]') : null
  const src = box ? box.querySelector('.md-math-editor__source') : null
  const bar = box ? box.querySelector('.md-math-editor__bar') : null
  const label = box ? box.querySelector('[data-md-math-editor-label]') : null
  const hint = box ? box.querySelector('[data-md-math-editor-hint]') : null
  const ae = document.activeElement
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const css = (el, p) => (el ? getComputedStyle(el)[p] : null)
  const tokens = hl ? [...hl.querySelectorAll('[data-md-math-tok]')] : []
  const paints = (sel) => [...document.querySelectorAll(sel)]
  return JSON.stringify({
    hasBox: !!box,
    shape: box ? box.getAttribute('data-md-math-editor-shape') : null,
    pos: box ? box.getAttribute('data-md-math-editor-pos') : null,
    invalid: box ? box.hasAttribute('data-md-math-invalid') : null,
    composing: box ? box.hasAttribute('data-md-math-composing') : null,
    stamp: box ? box.hasAttribute('data-src-stamp') : null,
    taStamp: ta ? ta.hasAttribute('data-src-ta-stamp') : null,
    taConnected: ta ? ta.isConnected : null,
    value: ta ? ta.value : null,
    hlText: hl ? hl.textContent : null,
    activeIsTa: ae === ta,
    activeInBox: !!(ae && box && box.contains(ae)),
    activeTag: ae ? ae.tagName : null,
    content: window.__L.files().current.content,
    tokClasses: [...new Set(tokens.map((s) => s.getAttribute('data-md-math-tok')))],
    tokColors: [...new Set(tokens.map((s) => getComputedStyle(s).color))],
    tokCount: tokens.length,
    taColor: css(ta, 'color'),
    taCaret: css(ta, 'caretColor'),
    hlVisibility: css(hl, 'visibility'),
    labelDisplay: css(label, 'display'),
    hintText: hint ? hint.textContent : null,
    hintRect: rect(hint),
    ariaDescribed: ta ? ta.getAttribute('aria-describedby') : null,
    boxRect: rect(box),
    srcRect: rect(src),
    barRect: rect(bar),
    taRect: rect(ta),
    hlRect: rect(hl),
    boxBorder: css(box, 'borderTopWidth'),
    srcPadding: css(src, 'padding'),
    taPadding: css(ta, 'padding'),
    hlPadding: css(hl, 'padding'),
    taFont: css(ta, 'fontFamily'),
    colRect: rect(document.querySelector('.md-preview')),
    previewText: (() => { const k = box ? box.querySelector('.md-math-editor__preview .katex') : null; return k ? k.textContent : null })(),
    previewRaw: (() => { const p = box ? box.querySelector('.md-math-editor__preview') : null; return p ? p.textContent : null })(),
    blockKatexCount: paints('.md-preview .md-math-block .katex-display').length,
    inlineKatex: (() => { const k = document.querySelector('.md-preview .md-math-rendered .katex'); return k ? k.textContent : null })(),
    delims: box ? box.querySelectorAll('[data-md-math-editor-delim]').length : null,
    taTextColorOpaque: (() => { const c = css(ta, 'color') || ''; return !/rgba?\\([^)]*,\\s*0\\)/.test(c) && c !== 'transparent' })()
  })
})()`

/** 在源码区里给元素打戳（验证"逐键重绘没有把 DOM 拆掉"） */
const SRC_STAMP = `(() => {
  const box = document.querySelector('[data-md-math-editor]')
  const ta = box ? box.querySelector('[data-md-math-editor-src]') : null
  if (!box || !ta) return 'NO_BOX'
  box.setAttribute('data-src-stamp', '1')
  ta.setAttribute('data-src-ta-stamp', '1')
  return 'ok'
})()`

/** 取某个锚点的中心坐标（没有就返回 null） */
function centerExpr(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) })
  })()`
}

/** 点一个**绝对坐标**（mousedown + mouseup，与真人点击同一条路径） */
async function clickPoint(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/**
 * 重开 F~J 段专用的夹具文档。
 *
 * 为什么这几段要**每次重开**：F 段验的正是"源码区能不能打字"——被测代码坏掉时
 * 它的破坏方式是把整条 `$$…$$` 换成敲进去的字符（第三十一轮的真因），
 * 于是后面几段会踩在一条**已经没有块级公式**的文档上，报出"找不到元素"这种
 * 与被测行为无关的错。每段开头重开一次，红就是"这一段红"。
 */
async function reloadFix(app) {
  await openDocWith(app, MD2, 'math-edit-2.md')
  await waitEditor(app.ev)
  await sleep(700)
}

/** 打开夹具里的块级公式编辑态（坐标每次现取：重开夹具后布局才是真值） */
async function openBlockEditor(app) {
  const p = await centerOf(app.ev, '.md-preview .md-math-block')
  if (!p) return false
  await clickAt(app.send, p.x, p.y)
  await sleep(600)
  return true
}

/** 打开夹具里的行内公式编辑态 */
async function openInlineEditor(app) {
  const p = await centerOf(app.ev, '.md-preview .md-math-rendered')
  if (!p) return false
  await clickAt(app.send, p.x, p.y)
  await sleep(600)
  return true
}

/** 收起当前编辑态（合成 Esc：不改内容，与上一轮口径一致） */
async function closeEditor(app) {
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
}

/**
 * 敲一个**字符**（keyDown 带 text：与真人敲键同一条路径 —— 真实按键才会经过
 * ProseMirror 的 keypress 处理。`Input.insertText` 不经过 keydown，验不出"按键被抢"。）
 */
async function typeChar(send, ch) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ch,
    text: ch,
    unmodifiedText: ch,
    windowsVirtualKeyCode: 0
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: 0 })
}


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
    report.check(
      'E2e 打开编辑态后焦点在源码框里（textarea 拿到焦点，不是 body）',
      (await app.ev(`document.activeElement?.tagName ?? null`)) === 'TEXTAREA',
      `activeElement=${await app.ev('document.activeElement?.tagName ?? null')}`
    )
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

  // ─── E7 编辑态形态（第三十轮：Typora 截图口径）──────────────────────────────
  //
  // 与用户给的 Typora 截图逐条对齐：
  //   ① 一个**带细边框的容器**，源码区在上、渲染区在下，都在同一个容器里（随正文流）；
  //   ② 源码是**两行 `$$`** 分列上下（不是挤在一行）+ 等宽字体；
  //   ③ 右上角「公式 ✓」：标签文本走语言包，✓ 是**可聚焦、有可访问名**的真按钮；
  //   ④ 点 ✓ 收起 → 回到纯渲染态，**文档逐字不变**；
  //   ⑤ 逐键实时渲染：改源码 ⇒ 容器**下半的渲染区**立即更新；
  //   ⑥ 行内公式的编辑态是**紧凑浮层**（形态与块级不同，且是有意的）。
  const blockPos2 = await centerOf(app.ev, '.md-preview .md-math-block')
  if (!blockPos2) {
    report.skip('E7 编辑态形态', '页面上没有块级公式')
  } else {
    await clickAt(app.send, blockPos2.x, blockPos2.y)
    await sleep(600)
    const style = JSON.parse(await app.ev(SNAPSHOT))
    const b = style.box
    report.check(
      'E7a 编辑态是一个**带边框的容器**，源码区在上、渲染区在下（都在同一容器内）',
      !!b &&
        b.shape === 'block' &&
        parseFloat(b.borderWidth ?? '0') > 0 &&
        !!b.srcRect &&
        !!b.previewRect &&
        // 源码区**底 ≤ 渲染区顶** ⇒ 确实是"上源码 / 下渲染"
        b.srcRect.bottom <= b.previewRect.top + 1 &&
        // 上下深色不同：上半源码底 / 下半渲染底（截图里就是两块不同底色）
        b.sourceBg !== b.previewBg,
      `shape=${b?.shape} border=${b?.borderWidth} ${b?.borderColor} srcBottom=${b?.srcRect?.bottom} previewTop=${b?.previewRect?.top} srcBg=${b?.sourceBg} previewBg=${b?.previewBg}`
    )
    report.check(
      'E7b 源码区是**两行 `$$`** 分列上下（open 在上、close 在下）且源码用等宽字体',
      !!b &&
        b.delims.length === 2 &&
        b.delims[0].which === 'open' &&
        b.delims[0].text === '$$' &&
        b.delims[1].which === 'close' &&
        b.delims[1].text === '$$' &&
        b.delims[0].top < b.delims[1].top &&
        /mono|Cascadia|Consolas|JetBrains/i.test(b.taFontFamily ?? ''),
      `delims=${JSON.stringify(b?.delims)} font=${b?.taFontFamily}`
    )
    report.check(
      'E7c 右上角标签是本地化「公式」，✓ 是**真按钮**（tabIndex 不小于 0、未禁用、有非空可访问名）',
      !!b &&
        !!b.label &&
        b.label.trim().length > 0 &&
        b.check !== null &&
        b.check.tag === 'BUTTON' &&
        b.check.focusable === true &&
        b.check.tabIndex >= 0 &&
        b.check.disabled === false &&
        !!b.check.ariaLabel &&
        b.check.ariaLabel.trim().length > 0 &&
        b.check.ariaLabel !== b.label,
      `label=${JSON.stringify(b?.label)} check=${JSON.stringify(b?.check)}`
    )
    // ✓ 的"能聚焦"用**不改状态**的方式再钉一次：显式 focus 之后 activeElement 必须就是它，
    // 然后再把焦点还给源码框（不然这次 focus 会把编辑态收起 —— 见 SNAPSHOT 里的说明）。
    // ✓ 的"能聚焦"：用**标准判据**钉，而不是在断言里真的去 focus ——
    // 在断言里 focus 会把 textarea 的焦点抢走并触发失焦收起（本套件踩过两次：
    // 诊断动作把被测状态改坏了）。`<button>` 未禁用且 tabIndex 不小于 0 就是**可聚焦**的
    // 元素（HTML 规范 + 浏览器行为），这里把这两条前提钉死，并排除"用一个 div 冒充按钮"。
    report.check(
      'E7c2 ✓ 是可聚焦元素（`<button>` 元素 + tabIndex 不小于 0 + 未禁用），不是 div 冒充',
      b?.check?.tag === 'BUTTON' && b.check.tabIndex >= 0 && b.check.disabled === false,
      `tag=${b?.check?.tag} tabIndex=${b?.check?.tabIndex} disabled=${b?.check?.disabled}`
    )
    // 点 ✓ 收起：文档必须**逐字不变**
    const beforeClick = style.content
    await app.ev(`(() => {
      const c = document.querySelector('[data-md-math-editor-check]')
      c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return 'ok'
    })()`)
    await sleep(500)
    const closed = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E7d 点 ✓ 收起 → 回到纯渲染态（编辑容器消失、原公式重新可见），且**文档逐字不变**',
      closed.box === null &&
        closed.blockRendered === 2 &&
        closed.content === beforeClick,
      `box=${closed.box === null ? 'closed' : 'open'} blockRendered=${closed.blockRendered} contentSame=${closed.content === beforeClick}`
    )
    // 重新打开 → 改一处 → 容器下半的渲染区必须跟着变
    await clickAt(app.send, blockPos2.x, blockPos2.y)
    await sleep(500)
    const before7e = JSON.parse(await app.ev(SNAPSHOT))
    await app.ev(setSource('\\int_0^1 x^3\\,dx = \\frac{1}{4}'))
    await sleep(500)
    const after7e = JSON.parse(await app.ev(SNAPSHOT))
    report.check(
      'E7e 逐键实时渲染：改源码 ⇒ 容器**下半的渲染区**立即更新（上轮的 E3 系列同时仍绿）',
      !!after7e.box &&
        after7e.box.previewText !== before7e.box?.previewText &&
        /x3/.test(after7e.box.previewText ?? '') &&
        after7e.content.includes('x^3'),
      `before=${JSON.stringify(before7e.box?.previewText)} after=${JSON.stringify(after7e.box?.previewText)}`
    )
    // 行内：紧凑浮层（不是块级那种整块容器）——差异是**有意**的
    await app.ev(`(() => {
      const ta = document.querySelector('[data-md-math-editor-src]')
      if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'ok'
    })()`)
    await sleep(300)
    const inlinePos2 = await centerOf(app.ev, '.md-preview .md-math-rendered')
    if (!inlinePos2) {
      report.skip('E7f 行内编辑态是紧凑浮层', '页面上没有行内公式')
    } else {
      await clickAt(app.send, inlinePos2.x, inlinePos2.y)
      await sleep(500)
      const inlineStyle = JSON.parse(await app.ev(SNAPSHOT))
      const ib = inlineStyle.box
      report.check(
        'E7f 行内编辑态是**紧凑浮层**（shape=inline、无 `$$` 定界符、宽高都远小于块级）',
        !!ib &&
          ib.shape === 'inline' &&
          ib.delims.length === 0 &&
          ib.rect.width < 600 &&
          ib.rect.height < 120 &&
          // 与块级共用同一套配色语言：同为一个 `.md-math-editor` 容器
          parseFloat(ib.borderWidth ?? '0') > 0,
        `shape=${ib?.shape} rect=${JSON.stringify(ib?.rect)} delims=${ib?.delims.length} border=${ib?.borderWidth}`
      )
      report.note(
        `E7 形态差异（有意）：块级 shape=block 容器 ${style.box?.rect.width}×${style.box?.rect.height}（随正文流、含 $$ 上下两行）；` +
          `行内 shape=inline 浮层 ${ib?.rect.width}×${ib?.rect.height}（固定定位、紧贴公式上方）`
      )
    }
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

  // ═══ 第三十一轮：源码区「能编辑 / 点不没 / 有高亮 / 行内要紧凑」═══════════════
  //
  // 先把可能还开着的编辑态收掉（E7f 结束时行内浮层是开着的），再换一份**专用夹具**：
  // 这几段验的是源码区自身的行为，不该被 E 段留下的中间态（`$E = mc^3$` 之类）干扰。
  await closeEditor(app)
  await reloadFix(app)

  const focusOk = await ensureFocus(app)
  if (!focusOk) {
    report.skip(
      'F/G/H/I/J 源码区真实按键与点击段',
      '窗口拿不到 OS 焦点（CDP 注入的真实按键会丢）——环境抖动，不是产品缺陷'
    )
    app.close()
    return report.finish()
  }

  // ─── F 真实按键在源码区敲 `\frac{a}{b}`（逐键 + 一次退格）─────────────────────
  //
  // ⚠️ 必须用 `Input.dispatchKeyEvent`（带 text）而不是 `Input.insertText`：后者**不经过
  //    keydown**，恰好绕开第三十一轮那个真因（源码区的按键冒泡到 ProseMirror，被
  //    `editHandlers.keypress` 拿去 `tr.insertText(ch)`，把整条 `$$…$$` 换成那个字符）。
  await openBlockEditor(app)
  await app.ev(SRC_STAMP)
  const f0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'F1 块级源码区打开后：焦点在源码框里，且装饰层文本 = 输入层 value（高亮只是视图）',
    f0.hasBox === true &&
      f0.shape === 'block' &&
      f0.activeIsTa === true &&
      f0.taConnected === true &&
      f0.hlText === f0.value &&
      !!f0.value,
    `shape=${f0.shape} activeIsTa=${f0.activeIsTa} value=${JSON.stringify(f0.value)} hlText=${JSON.stringify(f0.hlText)}`
  )

  // 全选（原生 Ctrl+A）后用真实按键逐字敲 `\frac{a}{b}`：第一下就替换掉旧源码
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 2
  })
  await sleep(120)

  const CHARS = ['\\', 'f', 'r', 'a', 'c', '{', 'a', '}', '{', 'b', '}']
  let typed = ''
  let renderFollows = 0
  let aliveEveryKey = true
  const trace = []
  // 判"渲染结果跟着变"用的是**整个下半区**的文本（含错误信息）：中途几步是坏公式，
  // 那时下半区画的是 `md-math-error`（没有 `.katex` 元素）—— 只盯 `.katex` 会把
  // "错误信息逐键在变"错判成"渲染没动"（本套件第一版就这么假红过一次）。
  let prevPreview = f0.previewRaw
  for (const ch of CHARS) {
    await typeChar(app.send, ch)
    await sleep(140)
    const s = JSON.parse(await app.ev(SRC_SNAPSHOT))
    typed += ch
    if (s.previewRaw !== prevPreview) renderFollows += 1
    prevPreview = s.previewRaw
    const ok =
      s.value === typed &&
      s.stamp === true &&
      s.taStamp === true &&
      s.activeIsTa === true &&
      s.taConnected === true
    if (!ok) aliveEveryKey = false
    trace.push(ch + '=>' + JSON.stringify(s.value) + (ok ? '' : '(STALE!)'))
  }
  report.check(
    'F2 真实按键逐字敲进源码区：每次按键**源码文本**都变（11 次按键逐字相符）',
    typed === '\\frac{a}{b}' && trace.every((t) => !t.includes('STALE')),
    'trace=' + trace.join(' ')
  )
  report.check(
    'F3 每敲一个字，**渲染结果**（容器下半区）也跟着变（不重开、不重载）',
    renderFollows >= 8,
    'renderChanged=' + renderFollows + '/11 下半区最终文本=' + JSON.stringify(prevPreview)
  )
  report.check(
    'F4 每次按键后焦点仍在源码框内，且**源码元素没有被替换**（打戳验证，DOM 一个都没重建）',
    aliveEveryKey && f0.stamp === true,
    'aliveEveryKey=' + aliveEveryKey + ' boxStampKept=' + f0.stamp + ' taStampKept=' + f0.taStamp
  )
  const fTyped = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'F5 敲完后文档里就是这次输入（`$$` 里的源码逐字等于 `\\frac{a}{b}`，公式没被吃掉）',
    fTyped.value === '\\frac{a}{b}' &&
      fTyped.content.includes('\\frac{a}{b}') &&
      fTyped.invalid === false &&
      fTyped.previewText !== null &&
      fTyped.previewText.includes('a'),
    'value=' + JSON.stringify(fTyped.value) + ' invalid=' + fTyped.invalid + ' preview=' + JSON.stringify(fTyped.previewText)
  )

  // 一次退格：源码文本与渲染结果都要跟着回退
  const beforeDel = fTyped
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8
  })
  await sleep(250)
  const fDel = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'F6 退格一次：源码文本与渲染结果都随之回退（值少一个字符、预览跟着变）',
    fDel.value === '\\frac{a}{b' &&
      fDel.value !== beforeDel.value &&
      fDel.previewText !== beforeDel.previewText &&
      fDel.activeIsTa === true &&
      fDel.stamp === true &&
      fDel.content.includes('\\frac{a}{b'),
    'value=' + JSON.stringify(fDel.value) + ' previewChanged=' + (fDel.previewText !== beforeDel.previewText)
  )
  // 补回 `}`，留给后面的段一个合法公式
  await typeChar(app.send, '}')
  await sleep(250)
  const fFixed = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'F7 再敲一个 `}` → 公式重新合法（错误态消失、下半画出字形）',
    fFixed.value === '\\frac{a}{b}' &&
      fFixed.invalid === false &&
      fFixed.previewText !== null &&
      fFixed.previewText.includes('b') &&
      fFixed.content.includes('\\frac{a}{b}'),
    'value=' + JSON.stringify(fFixed.value) + ' invalid=' + fFixed.invalid +
      ' preview=' + JSON.stringify(fFixed.previewText)
  )

  // ─── G 点源码区任何位置都不收起 ─────────────────────────────────────────────
  //
  // 重开夹具：F 段在被测代码坏掉时会**改坏文档**，那之后的"点不动"就验不出东西了。
  await reloadFix(app)
  await openBlockEditor(app)
  await app.ev(SRC_STAMP)
  const srcBox = JSON.parse(await app.ev(centerExpr('.md-math-editor__source')))
  const barBox = JSON.parse(await app.ev(centerExpr('.md-math-editor__bar')))
  const delimBox = JSON.parse(await app.ev(centerExpr('[data-md-math-editor-delim="close"]')))
  const gValue = JSON.parse(await app.ev(SRC_SNAPSHOT)).value
  // ① 源码区右下角（内边距空白，不是文本框本身）
  await clickPoint(app.send, srcBox.right - 3, srcBox.bottom - 3)
  await sleep(300)
  const g1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  // ② `$$` 那一行
  await clickPoint(app.send, delimBox.x, delimBox.y)
  await sleep(300)
  const g2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  // ③ 顶行「公式 ✓」那条（离开 ✓ 按钮本身）
  await clickPoint(app.send, barBox.left + 4, barBox.y)
  await sleep(300)
  const g3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'G1 点源码区空白 / `$$` 行 / 顶行都**不收起**，焦点仍在源码框里',
    g1.hasBox === true &&
      g2.hasBox === true &&
      g3.hasBox === true &&
      g1.activeInBox &&
      g2.activeInBox &&
      g3.activeInBox &&
      g3.stamp === true,
    'afterPadding=' + g1.hasBox + '(inBox=' + g1.activeInBox + ') afterDelim=' + g2.hasBox +
      '(inBox=' + g2.activeInBox + ') afterBar=' + g3.hasBox + '(inBox=' + g3.activeInBox + ')'
  )
  report.check(
    'G2 点源码区不收起的同时也**没改内容**（三次点击前后 value 与文档逐字不变）',
    g1.value === gValue && g2.value === gValue && g3.value === gValue &&
      g3.content === g1.content,
    'value=' + JSON.stringify(g3.value)
  )

  // ④ 点真正的外部 → 收起
  const outside = await centerOf(app.ev, '.md-preview p')
  await clickAt(app.send, outside.x, outside.y)
  await sleep(500)
  const g4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'G3 点**编辑区外部**（正文段落）→ 收起编辑态，内容保留',
    g4.hasBox === false && g4.content.includes('\\frac{a}{b}'),
    'hasBox=' + g4.hasBox + ' contentKept=' + g4.content.includes('\\frac{a}{b}')
  )

  // ⑤ Esc（真实按键）→ 收起且不改内容
  await openBlockEditor(app)
  const beforeEsc = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await sleep(400)
  const g5 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'G4 Esc（真实按键）收起编辑态，且**逐字不改内容**',
    beforeEsc.hasBox === true && g5.hasBox === false && g5.content === beforeEsc.content,
    'before=' + beforeEsc.hasBox + ' after=' + g5.hasBox + ' contentSame=' + (g5.content === beforeEsc.content)
  )

  // ⑥ 点 ✓ → 收起且不改内容
  await openBlockEditor(app)
  const beforeCheck = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const checkPos = JSON.parse(await app.ev(centerExpr('[data-md-math-editor-check]')))
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: checkPos.x,
    y: checkPos.y,
    button: 'left',
    clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: checkPos.x,
    y: checkPos.y,
    button: 'left',
    clickCount: 1
  })
  await sleep(450)
  const g6 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'G5 点右上角「✓」收起编辑态，且**逐字不改内容**',
    beforeCheck.hasBox === true && g6.hasBox === false && g6.content === beforeCheck.content,
    'after=' + g6.hasBox + ' contentSame=' + (g6.content === beforeCheck.content)
  )

  // ─── H 高亮：≥3 类颜色 + 高亮没改文本 + 两层对齐 ────────────────────────────
  await openBlockEditor(app)
  const h = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'H1 源码区里 ≥3 类不同颜色的着色 span（命令 / 花括号 / 普通文本各有色），实测色值如下',
    h.tokColors.length >= 3 && h.tokClasses.length >= 3 && h.tokClasses.includes('cmd') && h.tokClasses.includes('brace'),
    'classes=' + JSON.stringify(h.tokClasses) + ' colors=' + JSON.stringify(h.tokColors) + ' spans=' + h.tokCount
  )
  report.check(
    'H2 高亮**没有改动文本**：装饰层文本与输入层 value 逐字一致，且都等于用户敲进去的 `\\frac{a}{b}`',
    h.hlText === h.value && h.value === '\\frac{a}{b}' && h.content.includes('\\frac{a}{b}'),
    'hlText=' + JSON.stringify(h.hlText) + ' value=' + JSON.stringify(h.value)
  )
  report.check(
    'H3 颜色画在**装饰层**上：输入层文字透明（color 全透明）+ 插入符另有其色（光标看得见）',
    h.taTextColorOpaque === false && !!h.taCaret && !/rgba?\\([^)]*,\\s*0\\)/.test(h.taCaret),
    'taColor=' + h.taColor + ' caret=' + h.taCaret
  )
  const aligned =
    !!h.taRect && !!h.hlRect &&
    Math.abs(h.taRect.left - h.hlRect.left) <= 1 &&
    Math.abs(h.taRect.top - h.hlRect.top) <= 1 &&
    Math.abs(h.taRect.width - h.hlRect.width) <= 1
  report.check(
    'H4 两层（输入层 / 高亮层）逐像素对齐（左上角与宽度差 ≤ 1px，字体与内边距同源）',
    aligned && h.taPadding === h.hlPadding && h.taFont === h.taFont,
    'taRect=' + JSON.stringify(h.taRect) + ' hlRect=' + JSON.stringify(h.hlRect) +
      ' padding=' + h.taPadding + '/' + h.hlPadding
  )

  // ─── I 行内形态：紧凑、不占整行 ─────────────────────────────────────────────
  await closeEditor(app)
  await openInlineEditor(app)
  const i = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'I1 行内编辑区是**单行薄盒子**：不占整行（宽 < 正文列宽）、高度紧凑、有边框',
    i.hasBox === true &&
      i.shape === 'inline' &&
      i.delims === 0 &&
      i.boxRect.width < i.colRect.width &&
      i.boxRect.height <= 64 &&
      parseFloat(i.boxBorder || '0') > 0,
    'rect=' + JSON.stringify(i.boxRect) + ' col=' + JSON.stringify(i.colRect) +
      ' border=' + i.boxBorder + ' padding=' + i.srcPadding
  )
  report.check(
    'I2 行内只留重点：可见的「公式」二字收起、`Esc` 提示只给读屏器（视觉隐藏但 aria 还能取到）',
    i.labelDisplay === 'none' &&
      !!i.hintText &&
      !!i.hintRect &&
      i.hintRect.width <= 1 &&
      !!i.ariaDescribed,
    'labelDisplay=' + i.labelDisplay + ' hint=' + JSON.stringify(i.hintText) +
      ' hintRect=' + JSON.stringify(i.hintRect) + ' aria-describedby=' + i.ariaDescribed
  )
  report.note(
    'I 行内实测：容器 ' + i.boxRect.width + '×' + i.boxRect.height +
      '，源码区 padding=' + i.srcPadding + '，边框=' + i.boxBorder +
      '，正文列宽=' + i.colRect.width
  )

  // ─── J 回归：往返保真 / Ctrl+Z / 错误态 / 组字 ───────────────────────────────
  const roundTrip = JSON.parse(await app.ev(SNAPSHOT))
  const blockSerialized = roundTrip.content.includes('$$\n\\frac{a}{b}\n$$')
  report.check(
    'J1 往返保真：`$…$` 原文仍是原文（行内带定界符）、`$$…$$` 逐字写回',
    roundTrip.mathTexts.every((t) => t.startsWith('$') && t.endsWith('$') && t.length > 2) &&
      blockSerialized &&
      roundTrip.blockSources.every((s) => typeof s === 'string'),
    'mathTexts=' + JSON.stringify(roundTrip.mathTexts) +
      ' blockSources=' + JSON.stringify(roundTrip.blockSources) +
      ' hasBlockForm=' + blockSerialized +
      ' tail=' + JSON.stringify(roundTrip.content.slice(-70))
  )
  // Ctrl+Z 撤掉源码区的一步输入（行内浮层在 PM 之外，撤销走源码区自己派给 PM 的 history）
  const beforeUndo = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'z')
  await sleep(300)
  const typedZ = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2
  })
  await sleep(500)
  const j2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const docReverted =
    !j2.content.includes('$E = mc^2z$') &&
    j2.content.includes('$E = mc^2$') &&
    j2.value === beforeUndo.value
  report.check(
    'J2 Ctrl+Z 能撤销源码区的修改：文档回到上一态，且**源码框里的文本与渲染同步回退**',
    typedZ.value === beforeUndo.value + 'z' &&
      typedZ.content.includes('$E = mc^2z$') &&
      docReverted &&
      j2.hasBox === true &&
      j2.hlText === j2.value,
    'typed=' + JSON.stringify(typedZ.value) + ' undone=' + JSON.stringify(j2.value) +
      ' zGone=' + !j2.content.includes('$E = mc^2z$') +
      ' restored=' + j2.content.includes('$E = mc^2$') +
      ' // 逐字节同源比较（供参考，编译器重排会让它 false）：' +
      (j2.content === beforeUndo.content)
  )
  // 错误态仍可判（坏公式 → data-md-math-invalid，且文档里留的是坏源码）
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    ta.value = '\\\\frac{1}{'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(450)
  const j3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'J3 错误态仍可判：坏公式 ⇒ `data-md-math-invalid`，文档里保留坏源码（不弹窗、不丢内容）',
    j3.invalid === true && j3.content.includes('\\frac{1}{'),
    'invalid=' + j3.invalid + ' kept=' + j3.content.includes('\\frac{1}{')
  )
  // 组字（合成事件：真实输入法无法用 CDP 驱动，这里验的是"组字期间不丢字"的机制）
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    ta.value = 'E = mc^2'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ta.value = ta.value + '好'
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    return 'ok'
  })()`)
  await sleep(250)
  const j4a = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '好' }))
    return 'ok'
  })()`)
  await sleep(400)
  const j4b = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'J4 组字期间**让位给浏览器原生渲染**（输入层恢复成有色、装饰层隐藏），组字结束后高亮立刻回来且文本一致',
    j4a.composing === true &&
      j4a.taTextColorOpaque === true &&
      j4a.hlVisibility === 'hidden' &&
      j4b.composing === false &&
      j4b.hlVisibility !== 'hidden' &&
      j4b.value === 'E = mc^2好' &&
      j4b.hlText === j4b.value &&
      j4b.content.includes('E = mc^2好'),
    'composing=' + j4a.composing + ' taColorVisible=' + j4a.taTextColorOpaque +
      ' hlHidden=' + (j4a.hlVisibility === 'hidden') + ' after=' + JSON.stringify(j4b.value) +
      ' hlSame=' + (j4b.hlText === j4b.value)
  )
  // 收拾干净：把这条行内公式改回原样并收起（后面的断言/别的套件不该看到中间态）
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    ta.value = 'E = mc^2'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
