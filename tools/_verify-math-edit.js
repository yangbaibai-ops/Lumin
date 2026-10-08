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
// ─── 第三十二轮（用户第九轮反馈）追加：K~P 六段 ──────────────────────────────────
//   K ① 源码**书写面没有边框**（src/hl/source 四边全 0 + 无 focus 外环），
//        且「公式 ✓」**不占独立一行**（绝对定位、与源码区重叠、源码区顶到容器顶）
//   L ② **行内**源码区真实按键（含 `Ctrl+A` 全选替换 —— 这正是改前被 PM 抢走的那条）
//   M ③ 块级/行内公式**拖不走**（文档逐字不变）；**图片仍可拖动**（对照项）
//   N ④ 空段落里敲 `$$`+回车 → 直接得到空公式块且**已在编辑态**（一步撤销）
//   O ⑤ 空公式**保留框架** + 渲染区 `< Empty Math Block >`（占位**不进文档**）
//   P ⑥ 回归：块级仍能输入 / 点源码不收起 / 代码块里的 `$` 与 `\$` 不受影响
//
// ─── 第三十三轮（用户第十轮反馈）追加：Q~T 四段 ─────────────────────────────────
//   Q ① **空公式块的出路**：源码框为空时按退格/Delete ⇒ 删掉整条公式块（一个事务、一步撤销）；
//       顺带钉住"只剩这一块时删完文档仍合法（补一个空段落）"
//   R ② **对照项**：源码**非空**时退格只删字符、块要留着（防"一刀切删块"）
//   S ③ **逐键敲 `$E=mc^2$`**：收尾 `$` 落下的那一刻就出现行内公式渲染（给出逐键 widget 时间线）
//   T ④ 回归：空公式占位仍在且序列化无占位文案 / `$$`+回车仍出块并进编辑态
//       （`_verify-math.js` 8/8 与 `_verify-no-text-drag.js` 14/14 是独立套件，报告里单列）
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
  requireFocus,
  requireFrames,
  fatal
} = require('./lib/harness')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

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

/**
 * 第三十二轮（K~P 段）的夹具。
 *
 * 三个要点：
 *   * 图片用**绝对路径 + `%TEMP%`**：隔离实例的 `LUMIN_TRUSTED_PATHS` 就是 `%TEMP%`
 *     （见 tools/start-isolated.ps1），所以 `lumin-file://` 能读到它 —— 这是 M 段
 *     "图片仍然可以拖动"那条**对照项**的唯一可靠造法（数据 URI 会被 Tiptap 的
 *     `allowBase64: false` 挡掉，粘贴又要真工作区目录）。
 *   * 表格/代码块都在：P 段要证明代码块里的 `$` 与 `\$` 一个都没被当成公式。
 */
function buildMd3(imgPath) {
  return [
    '第一段：行内公式 $E = mc^2$ 在句子里，价格 \\$5 是字面量。',
    '',
    '第二段：块级公式在下面。',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    '第三段：图片在下面。',
    '',
    '![t](' + imgPath + ')',
    '',
    '第四段：代码块里的美元不算公式。',
    '',
    '```sh',
    'echo "$HOME"',
    '```',
    '',
    '第五段收尾。'
  ].join('\n')
}

/**
 * N 段专用：没有任何公式，只有段落。
 *
 * 空段落**不写在夹具里**（Markdown 的连续空行只是段落分隔，解析出来根本没有空 `p`），
 * 由 `newEmptyParagraph()` 用真实的"回车"造出来 —— 那也正是用户造空段落的方式。
 */
const MD4 = [
  '第一段：这里只是正文。',
  '',
  '第二段：光标放在这一段末尾，按回车会多出一个空段落。'
].join('\n')

/**
 * 第十轮（Q~T 段）夹具：一条普通段落 + 一条块级公式 + 一条后面的段落。
 *
 * 为什么自己一份：Q/R 段要"清空源码 → 按退格"，用 MD3 会牵动图片/代码块那些段落；
 * 这里留足上下文（块前后都有段落），才能同时验证"删块之后光标落在哪、文档还合不合法"。
 */
const MD5 = [
  '上一段：正文。',
  '',
  '$$',
  '\\frac{a}{b}',
  '$$',
  '',
  '下一段：紧跟在公式块后面。',
  '',
  '打字区。'
].join('\n')

/** Q5 专用：**整篇只有一条块级公式**（删掉它之后文档不能变成空的） */
const MD6 = ['$$', '\\frac{a}{b}', '$$'].join('\n')

/** S 段专用：只有一条段落，逐键打字用 */
const MD7 = ['打字区：在这里输入。'].join('\n')

/**
 * 第十二轮（X/Y/Z 段）夹具：段末公式 / 段中公式 / 两条挨着的公式 / 配平但未定义宏的公式。
 *
 * 为什么自己一份：①④ 要"段落末尾就是公式"这一格（用户报的那格），② 要一条**普通位置**
 * 做对照（不该出现自绘插入符），③④ 要能精确删掉开头/中间/收尾的 `$`，⑤ 要一条
 * "配平但语法错"的公式证明两种情形没被混为一谈。
 */
const MD8 = [
  '第一段：普通文字中间。',
  '',
  '第二段：段末公式 $E=mc^2$',
  '',
  '第三段：开头公式 $\\frac{1}{2}$ 后面还有字。',
  '',
  '第四段：两条 $a$ $b$',
  '',
  '第五段：坏公式 $\\notarealmacro$'
].join('\n')

// ─── 造一张真 PNG（zlib + CRC32，不依赖任何图形库）────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
/** 一张 w×h 的纯灰 PNG（够大、够好抓） */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 0xbb
      raw[o + 1] = 0xbb
      raw[o + 2] = 0xbb
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

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
    selStart: ta ? ta.selectionStart : null,
    selEnd: ta ? ta.selectionEnd : null,
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
    // 行内公式的**渲染 widget 数**与带 mdMath mark 的文本节点（S 段的逐键时间线看这两个）
    inlineWidgetCount: paints('.md-preview .md-math-rendered').length,
    mathMarkedTexts: (() => {
      const a = []
      window.__L.ed().state.doc.descendants((n) => {
        if (n.isText && n.marks.some((m) => m.type.name === 'mdMath')) a.push(n.text)
        return true
      })
      return a
    })(),
    delims: box ? box.querySelectorAll('[data-md-math-editor-delim]').length : null,
    taTextColorOpaque: (() => { const c = css(ta, 'color') || ''; return !/rgba?\\([^)]*,\\s*0\\)/.test(c) && c !== 'transparent' })(),
    // ── 第三十二轮（K~P 段）要看的几件事实 ──
    // 书写面四边边框 + 有没有 focus 外环（用户口径：书写区域不要边框）
    srcBorders: [css(ta, 'borderTopWidth'), css(ta, 'borderRightWidth'), css(ta, 'borderBottomWidth'), css(ta, 'borderLeftWidth')],
    hlBorders: [css(hl, 'borderTopWidth'), css(hl, 'borderRightWidth'), css(hl, 'borderBottomWidth'), css(hl, 'borderLeftWidth')],
    srcBordersource: [css(src, 'borderTopWidth'), css(src, 'borderRightWidth'), css(src, 'borderBottomWidth'), css(src, 'borderLeftWidth')],
    srcShadow: css(ta, 'boxShadow'),
    srcOutline: css(ta, 'outlineStyle'),
    srcBg: css(src, 'backgroundColor'),
    // 「公式 ✓」是不是绝对定位（不占一行）
    barPosition: css(bar, 'position'),
    checkAria: (() => { const c = box ? box.querySelector('[data-md-math-editor-check]') : null; return c ? c.getAttribute('aria-label') : null })(),
    checkTag: (() => { const c = box ? box.querySelector('[data-md-math-editor-check]') : null; return c ? c.tagName : null })(),
    // PM 选区类型（改前 Ctrl+A 会变成 AllSelection，下一个键就被 PM 吃掉）
    pmSelName: (() => { try { return window.__L.ed().state.selection.constructor.name } catch { return null } })(),
    pmSelFrom: (() => { try { return window.__L.ed().state.selection.from } catch { return null } })(),
    // ── 第三十三轮（U/V/W 段）要看的几件事实：光标所在位置的 mark / 光标矩形 ──
    // 光标处生效的 mark（inclusive 的病灶就在这里：改前停在公式右边界会带上 mdMath）
    marksAtCaret: (() => {
      try {
        const st = window.__L.ed().state
        return st.doc.resolve(st.selection.from).marks().map((m) => m.type.name)
      } catch (e) { return ['ERR'] }
    })(),
    storedMarks: (() => {
      try { return (window.__L.ed().state.storedMarks || []).map((m) => m.type.name) } catch (e) { return ['ERR'] }
    })(),
    // 光标矩形高度（0 = 浏览器画不出插入符；第十一轮就是这条把"点了没光标"锤死的）
    caretHeight: (() => {
      try {
        const sel = window.getSelection()
        return sel && sel.rangeCount ? +sel.getRangeAt(0).getBoundingClientRect().height.toFixed(1) : null
      } catch (e) { return null }
    })(),
    // 带 mdMath mark 的文本节点在文档里的**位置**（用来算"公式右边界"到底在哪）
    mathMarkedSpans: (() => {
      const a = []
      window.__L.ed().state.doc.descendants((n, pos) => {
        if (n.isText && n.marks.some((m) => m.type.name === 'mdMath')) a.push({ from: pos, to: pos + n.nodeSize, t: n.text })
        return true
      })
      return a
    })(),
    activeTag: document.activeElement ? document.activeElement.tagName : null,
    // ── 第三十四轮（X/Y/Z 段）：自绘插入符 / 配平退回普通文本 ──
    // 自绘插入符元素（每个给宽高；宽 ≥1、高 >0 才算"看得见"）
    caretWidgets: (() => {
      const a = []
      document.querySelectorAll('[data-md-math-caret]').forEach((el) => {
        const r = el.getBoundingClientRect()
        a.push({ w: +r.width.toFixed(1), h: +r.height.toFixed(1) })
      })
      return a
    })(),
    // 行内公式的 KaTeX 渲染数 / 错误态数（配平但语法错才该有错误态）
    inlineKatexCount: paints('.md-preview .katex').length,
    mathErrorCount: paints('.md-preview .md-math-error').length,
    mathErrorTitle: (() => { const e = document.querySelector('.md-preview .md-math-error'); return e ? e.getAttribute('title') : null })(),
    invalidCount: paints('[data-md-math-invalid]').length,
    // 空公式占位
    emptyCount: box ? box.querySelectorAll('[data-md-math-empty]').length : null,
    emptyText: (() => { const e = box ? box.querySelector('[data-md-math-empty]') : null; return e ? e.textContent : null })(),
    emptyRenderedCount: paints('.md-preview .md-math-block [data-md-math-empty]').length,
    emptyUserSelect: (() => { const e = box ? box.querySelector('[data-md-math-empty]') : null; return e ? getComputedStyle(e).userSelect : null })(),
    emptyPointer: (() => { const e = box ? box.querySelector('[data-md-math-empty]') : null; return e ? getComputedStyle(e).pointerEvents : null })(),
    emptyEditable: (() => { const e = box ? box.querySelector('[data-md-math-empty]') : null; return e ? e.getAttribute('contenteditable') : null })(),
    emptyColor: (() => { const e = box ? box.querySelector('[data-md-math-empty]') : null; return e ? getComputedStyle(e).color : null })(),
    // 文档结构：块级公式条数 / 各节点类型 / 文档纯文本（占位文案绝不能出现在这里）
    freshMarkdown: (() => { try { return String(window.__L.ed().storage.markdown.getMarkdown()) } catch (e) { return 'ERR:' + String(e) } })(),
    blockSources: (() => { const a = []; window.__L.ed().state.doc.descendants((n) => { if (n.type.name === 'mathBlock') a.push(String(n.attrs.source)); return true }); return a })(),
    docTypes: (() => { const a = []; window.__L.ed().state.doc.descendants((n) => { a.push(n.type.name); return true }); return a })(),
    docText: (() => { try { return window.__L.ed().state.doc.textBetween(0, window.__L.ed().state.doc.content.size, '\\n', '\\n') } catch { return null } })(),
    paraTexts: (() => { const a = []; window.__L.ed().state.doc.descendants((n) => { if (n.type.name === 'paragraph') a.push(n.textContent); return true }); return a })(),
    // 图片（M 段的对照项）
    imgRect: (() => { const i = document.querySelector('.md-preview img'); if (!i) return null; const r = i.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) } })(),
    imgDraggable: (() => { const i = document.querySelector('.md-preview img'); return i ? i.getAttribute('draggable') : null })(),
    blockDraggable: (() => { const b = document.querySelector('.md-preview .md-math-block'); return b ? b.getAttribute('draggable') : null })(),
    // 真实拖拽期间的 PM 侧事实（dragstart/drop 时 view.dragging 长什么样）
    dragLog: (window.__DRAG_V2 || []).splice(0, (window.__DRAG_V2 || []).length)
  })
})()`

/**
 * 真实拖拽期间把 PM 的 `view.dragging` 记下来（M 段用它区分"搬文字"与"搬节点"）。
 *
 * 只在 `dragstart`/`drop` 两个时刻取样：`dragover` 会连发几十次。
 * 每个时刻**只留前两条**：一次手势里 Chromium 会把 `dragstart` 重发很多遍
 * （实测一次手势 25 条），全记下来会把报告撑成一面墙。
 */
const DRAG_WATCH = `(() => {
  if (window.__DRAG_V2) return 'ok'
  window.__DRAG_V2 = []
  const seen = {}
  const sample = (phase, e) => {
    seen[phase] = (seen[phase] || 0) + 1
    if (seen[phase] > 2) return
    let d = null
    try {
      const g = window.__L.ed().view.dragging
      d = g ? { node: !!g.node, move: g.move, first: g.slice && g.slice.content.firstChild ? g.slice.content.firstChild.type.name : null } : null
    } catch {}
    window.__DRAG_V2.push({ phase, target: String((e.target && (e.target.className || e.target.nodeName)) || '').slice(0, 24), dragging: d, dp: e.defaultPrevented })
  }
  document.addEventListener('dragstart', (e) => { sample('dragstart-immediate', e); setTimeout(() => sample('dragstart-after', e), 0) }, true)
  document.addEventListener('drop', (e) => sample('drop', e), true)
  return 'ok'
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
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
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

/**
 * 打开夹具里的块级公式编辑态（坐标每次现取：重开夹具后布局才是真值）。
 *
 * 带重试：`openDocWith` 之后布局/焦点要一小会儿才稳，一次点空就判红会把环境抖动
 * 当成产品缺陷（本套件踩过）。判据用"编辑容器真的出现了"，不靠"点过了"。
 */
async function openBlockEditor(app, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    const p = await centerOf(app.ev, '.md-preview .md-math-block')
    if (p) {
      await clickAt(app.send, p.x, p.y)
      await sleep(600)
      const open = await app.ev(`!!document.querySelector('[data-md-math-editor]')`)
      if (open === true) return true
    }
    await sleep(350)
  }
  return false
}

/** 打开夹具里的行内公式编辑态（同样带重试） */
async function openInlineEditor(app, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    const p = await centerOf(app.ev, '.md-preview .md-math-rendered')
    if (p) {
      await clickAt(app.send, p.x, p.y)
      await sleep(600)
      const open = await app.ev(`!!document.querySelector('[data-md-math-editor]')`)
      if (open === true) return true
    }
    await sleep(350)
  }
  return false
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
 * 重开 K~P 段的夹具（`MD3`：行内公式 / 块级公式 / 图片 / 代码块 / `\$` 字面量）。
 *
 * 图片先写一张真 PNG 到 `%TEMP%`（隔离实例的 `LUMIN_TRUSTED_PATHS` 就是它），
 * 再用**绝对路径**写进 markdown —— 这样 M 段的"图片仍可拖动"对照项才拿得到一张
 * 有尺寸、真能加载的图。
 * @returns 图片路径（套件用它做额外交代）
 */
async function reloadFix3(app) {
  const pngPath = path.join(os.tmpdir(), 'lumin-math-v2-drag.png')
  fs.writeFileSync(pngPath, makePng(200, 100))
  await openDocWith(app, buildMd3(pngPath.replace(/\\/g, '/')), 'math-edit-3.md')
  await waitEditor(app.ev)
  await app.ev(DRAG_WATCH)
  await sleep(800)
  return pngPath
}

/**
 * 在当前光标处**造一个空段落**并把光标放进去（N 段要用它当"敲 `$$` 的地方"）。
 *
 * 为什么不让夹具里直接放一个空段落：Markdown 里连续空行会被解析成"段落分隔"，
 * **根本不会产生空段落**（实测夹具里留空行 → 文档里没有空 `p`）。真人也是敲回车造出来的，
 * 所以这里就用回车：点最后一段 → End → Enter ⇒ 下面多出一个空段落，光标正好在里面。
 */
async function newEmptyParagraph(app) {
  const last = await centerOf(app.ev, '.md-preview p:last-of-type')
  if (!last) return false
  await clickAt(app.send, last.x, last.y)
  await sleep(300)
  await pressKey(app, 'End', 'End', 35)
  await pressKey(app, 'Enter', 'Enter', 13)
  await sleep(300)
  return true
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

/** 敲一个**功能键**（Backspace / Enter / Escape / 方向键…），可带修饰键（2 = Ctrl） */
async function pressKey(app, key, code, vk, modifiers = 0, extra = {}) {
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    modifiers,
    ...extra
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    modifiers
  })
  await sleep(220)
}

/** 一次真实鼠标事件（`buttons` 决定是拖拽途中还是普通移动） */
function mouseEvent(send, type, x, y, buttons) {
  return send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1
  })
}

/**
 * 一次**真实拖拽手势**：移动 → 按下 → 8~10 步移动 → 抬起。
 *
 * 为什么要这么多步：原生 drag & drop 需要浏览器先过掉"拖动阈值"才会派发 `dragstart`；
 * 只有"按下→抬起"两步是选不中拖动的（见 tools/_verify-drag-selection.js 的同一套路）。
 */
async function dragFromTo(app, from, to, steps = 10) {
  await mouseEvent(app.send, 'mouseMoved', from.x, from.y, 0)
  await sleep(140)
  await mouseEvent(app.send, 'mousePressed', from.x, from.y, 1)
  await sleep(140)
  for (let i = 1; i <= steps; i++) {
    await mouseEvent(
      app.send,
      'mouseMoved',
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
      1
    )
    await sleep(40)
  }
  await sleep(140)
  await mouseEvent(app.send, 'mouseReleased', to.x, to.y, 0)
  await sleep(650)
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
  /**
   * 前提：窗口得拿到 OS 焦点、并且**在出帧**。
   *
   * 为什么必须在开头就卡住（第十轮踩到的坑）：这个套件大量依赖①真实按键②rAF 驱动的收尾
   * （失焦收起是"下一帧再判定"）③`setTimeout` 的防抖（store 的 `content` 同步）。
   * 当被测窗口被别的窗口挡住时，Chromium 会**暂停出帧**、把后台定时器压到 ≥1s ——
   * 于是 rAF 里的收尾不发生、`content` 迟迟不更新，一次能冒出十几条**假红**
   *（实测：同一次提交在窗口前台时 93/93，被遮住时 79/93）。
   *
   * 按仓库口径（harness §10 / 清单 §1.C.1）：环境不满足 ⇒ **如实 SKIP**，不要判红。
   */
  await requireFocus(app, '公式编辑套件（真实按键段）')
  await requireFrames(app, '公式编辑套件（rAF 收尾与防抖同步）')
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
      restored.blockRendered === 2 &&
        restored.content.includes('\\int_0^1 x^2\\,dx = \\frac{1}{3}'),
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
      closed.box === null && closed.blockRendered === 2 && closed.content === beforeClick,
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
    'value=' +
      JSON.stringify(fTyped.value) +
      ' invalid=' +
      fTyped.invalid +
      ' preview=' +
      JSON.stringify(fTyped.previewText)
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
    'value=' +
      JSON.stringify(fDel.value) +
      ' previewChanged=' +
      (fDel.previewText !== beforeDel.previewText)
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
    'value=' +
      JSON.stringify(fFixed.value) +
      ' invalid=' +
      fFixed.invalid +
      ' preview=' +
      JSON.stringify(fFixed.previewText)
  )

  // ─── G 点源码区任何位置都不收起 ─────────────────────────────────────────────
  //
  // 重开夹具：F 段在被测代码坏掉时会**改坏文档**，那之后的"点不动"就验不出东西了。
  await reloadFix(app)
  await openBlockEditor(app)
  await app.ev(SRC_STAMP)
  const srcBox = JSON.parse(await app.ev(centerExpr('.md-math-editor__source')))
  const boxBox = JSON.parse(await app.ev(centerExpr('[data-md-math-editor]')))
  const delimBox = JSON.parse(await app.ev(centerExpr('[data-md-math-editor-delim="close"]')))
  const delimOpenBox = JSON.parse(await app.ev(centerExpr('[data-md-math-editor-delim="open"]')))
  const gValue = JSON.parse(await app.ev(SRC_SNAPSHOT)).value
  // ① 源码区右下角（内边距空白，不是文本框本身）
  await clickPoint(app.send, srcBox.right - 3, srcBox.bottom - 3)
  await sleep(300)
  const g1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  // ② `$$` 那一行
  await clickPoint(app.send, delimBox.x, delimBox.y)
  await sleep(300)
  const g2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  /**
   * ③ 容器**左上角**（`$$` 开定界符那一带的空白）。
   *
   * ⚠️ 第三十二轮改了这条的落点：以前点的是"顶行那一整条 bar"，而本轮起
   * 「公式 ✓」是**绝对定位的小标记**（不再占一行），那条 bar 就缩成 ✓ 按钮自己
   * —— 点它当然会收起（那是它的语义）。所以这里改成点在**容器左上角**：
   * 它落在开定界符那一行上、又不在任何按钮里，正是"点源码区任何位置都不收起"要守的地方。
   */
  await clickPoint(app.send, boxBox.left + 8, delimOpenBox.y)
  await sleep(300)
  const g3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'G1 点源码区空白 / `$$` 行 / 容器左上角都**不收起**，焦点仍在源码框里',
    g1.hasBox === true &&
      g2.hasBox === true &&
      g3.hasBox === true &&
      g1.activeInBox &&
      g2.activeInBox &&
      g3.activeInBox &&
      g3.stamp === true,
    'afterPadding=' +
      g1.hasBox +
      '(inBox=' +
      g1.activeInBox +
      ') afterDelim=' +
      g2.hasBox +
      '(inBox=' +
      g2.activeInBox +
      ') afterTopLeft=' +
      g3.hasBox +
      '(inBox=' +
      g3.activeInBox +
      ')'
  )
  report.check(
    'G2 点源码区不收起的同时也**没改内容**（三次点击前后 value 与文档逐字不变）',
    g1.value === gValue && g2.value === gValue && g3.value === gValue && g3.content === g1.content,
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
    'before=' +
      beforeEsc.hasBox +
      ' after=' +
      g5.hasBox +
      ' contentSame=' +
      (g5.content === beforeEsc.content)
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
    h.tokColors.length >= 3 &&
      h.tokClasses.length >= 3 &&
      h.tokClasses.includes('cmd') &&
      h.tokClasses.includes('brace'),
    'classes=' +
      JSON.stringify(h.tokClasses) +
      ' colors=' +
      JSON.stringify(h.tokColors) +
      ' spans=' +
      h.tokCount
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
    !!h.taRect &&
    !!h.hlRect &&
    Math.abs(h.taRect.left - h.hlRect.left) <= 1 &&
    Math.abs(h.taRect.top - h.hlRect.top) <= 1 &&
    Math.abs(h.taRect.width - h.hlRect.width) <= 1
  report.check(
    'H4 两层（输入层 / 高亮层）逐像素对齐（左上角与宽度差 ≤ 1px，字体与内边距同源）',
    aligned && h.taPadding === h.hlPadding && h.taFont === h.taFont,
    'taRect=' +
      JSON.stringify(h.taRect) +
      ' hlRect=' +
      JSON.stringify(h.hlRect) +
      ' padding=' +
      h.taPadding +
      '/' +
      h.hlPadding
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
    'rect=' +
      JSON.stringify(i.boxRect) +
      ' col=' +
      JSON.stringify(i.colRect) +
      ' border=' +
      i.boxBorder +
      ' padding=' +
      i.srcPadding
  )
  report.check(
    'I2 行内只留重点：可见的「公式」二字收起、`Esc` 提示只给读屏器（视觉隐藏但 aria 还能取到）',
    i.labelDisplay === 'none' &&
      !!i.hintText &&
      !!i.hintRect &&
      i.hintRect.width <= 1 &&
      !!i.ariaDescribed,
    'labelDisplay=' +
      i.labelDisplay +
      ' hint=' +
      JSON.stringify(i.hintText) +
      ' hintRect=' +
      JSON.stringify(i.hintRect) +
      ' aria-describedby=' +
      i.ariaDescribed
  )
  report.note(
    'I 行内实测：容器 ' +
      i.boxRect.width +
      '×' +
      i.boxRect.height +
      '，源码区 padding=' +
      i.srcPadding +
      '，边框=' +
      i.boxBorder +
      '，正文列宽=' +
      i.colRect.width
  )

  // ─── J 回归：往返保真 / Ctrl+Z / 错误态 / 组字 ───────────────────────────────
  const roundTrip = JSON.parse(await app.ev(SNAPSHOT))
  const blockSerialized = roundTrip.content.includes('$$\n\\frac{a}{b}\n$$')
  report.check(
    'J1 往返保真：`$…$` 原文仍是原文（行内带定界符）、`$$…$$` 逐字写回',
    roundTrip.mathTexts.every((t) => t.startsWith('$') && t.endsWith('$') && t.length > 2) &&
      blockSerialized &&
      roundTrip.blockSources.every((s) => typeof s === 'string'),
    'mathTexts=' +
      JSON.stringify(roundTrip.mathTexts) +
      ' blockSources=' +
      JSON.stringify(roundTrip.blockSources) +
      ' hasBlockForm=' +
      blockSerialized +
      ' tail=' +
      JSON.stringify(roundTrip.content.slice(-70))
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
    'typed=' +
      JSON.stringify(typedZ.value) +
      ' undone=' +
      JSON.stringify(j2.value) +
      ' zGone=' +
      !j2.content.includes('$E = mc^2z$') +
      ' restored=' +
      j2.content.includes('$E = mc^2$') +
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
    'composing=' +
      j4a.composing +
      ' taColorVisible=' +
      j4a.taTextColorOpaque +
      ' hlHidden=' +
      (j4a.hlVisibility === 'hidden') +
      ' after=' +
      JSON.stringify(j4b.value) +
      ' hlSame=' +
      (j4b.hlText === j4b.value)
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

  // ═══ 第三十二轮（用户第九轮反馈）：K~P 六段 ═══════════════════════════════

  // ─── K ① 书写面去边框 + 「公式 ✓」不占一行 ───────────────────────────────
  await reloadFix3(app)
  await openBlockEditor(app)
  const k = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const allZero = (arr) => Array.isArray(arr) && arr.length === 4 && arr.every((v) => v === '0px')
  report.check(
    'K1 源码书写面**没有边框**：输入层/装饰层/源码区四边全 0，且没有 focus 外环（box-shadow none）',
    allZero(k.srcBorders) &&
      allZero(k.hlBorders) &&
      allZero(k.srcBordersource) &&
      k.srcShadow === 'none' &&
      k.srcOutline === 'none',
    'src=' +
      JSON.stringify(k.srcBorders) +
      ' hl=' +
      JSON.stringify(k.hlBorders) +
      ' source=' +
      JSON.stringify(k.srcBordersource) +
      ' shadow=' +
      k.srcShadow +
      ' outline=' +
      k.srcOutline
  )
  report.check(
    'K2 「公式 ✓」**不占独立一行**：绝对定位，且与源码区在同一行带里（源码区顶到容器顶）',
    k.barPosition === 'absolute' &&
      !!k.barRect &&
      !!k.srcRect &&
      !!k.boxRect &&
      k.srcRect.top - k.boxRect.top <= 3 &&
      k.barRect.bottom > k.srcRect.top,
    'barPosition=' +
      k.barPosition +
      ' boxTop=' +
      (k.boxRect && k.boxRect.top) +
      ' srcTop=' +
      (k.srcRect && k.srcRect.top) +
      ' bar=' +
      JSON.stringify(k.barRect)
  )
  report.check(
    'K3 靠**底色与留白**区分书写面（源码区仍有 --code-bg 底色与非零内边距），✓ 仍是真按钮且有可访问名',
    !!k.srcBg &&
      k.srcBg !== 'rgba(0, 0, 0, 0)' &&
      k.srcPadding !== '0px' &&
      k.checkTag === 'BUTTON' &&
      !!k.checkAria &&
      k.checkAria.trim().length > 0,
    'srcBg=' +
      k.srcBg +
      ' srcPadding=' +
      k.srcPadding +
      ' check=' +
      k.checkTag +
      '/' +
      JSON.stringify(k.checkAria)
  )
  report.note(
    'K 实测：容器边框 ' +
      k.boxBorder +
      '，源码区 padding=' +
      k.srcPadding +
      '，✓ 位置 ' +
      JSON.stringify(k.barRect)
  )

  // ─── L ② 行内源码区真实按键（改前：Ctrl+A 被 PM 抢成 AllSelection，下一个键整段被吃）──
  await closeEditor(app)
  await reloadFix3(app)
  await openInlineEditor(app)
  await app.ev(SRC_STAMP)
  const l0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  let lTyped = l0.value || ''
  let lAlive = l0.hasBox === true && l0.shape === 'inline' && l0.activeIsTa === true
  let lRenderFollows = 0
  let lPrevRender = l0.inlineKatex
  const lTrace = []
  for (const ch of ['x', 'y', 'z']) {
    await typeChar(app.send, ch)
    await sleep(240)
    const s = JSON.parse(await app.ev(SRC_SNAPSHOT))
    lTyped += ch
    if (s.inlineKatex !== lPrevRender) lRenderFollows += 1
    lPrevRender = s.inlineKatex
    const ok =
      s.value === lTyped && s.activeIsTa === true && s.stamp === true && s.taConnected === true
    if (!ok) lAlive = false
    lTrace.push(ch + '=>' + JSON.stringify(s.value) + (ok ? '' : '(STALE!)'))
  }
  await pressKey(app, 'Backspace', 'Backspace', 8)
  const lDel = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'L1 行内源码区**真实按键**：连敲 3 个字符 + 一次退格，源码文本逐字相符、焦点与元素都没换',
    lAlive && lDel.value === lTyped.slice(0, -1) && lDel.activeIsTa === true && lDel.stamp === true,
    'trace=' +
      lTrace.join(' ') +
      ' afterBackspace=' +
      JSON.stringify(lDel.value) +
      ' activeIsTa=' +
      lDel.activeIsTa +
      ' stamp=' +
      lDel.stamp
  )
  report.check(
    'L2 行内渲染**逐键**跟着变（框外那条 KaTeX 随输入更新）',
    lRenderFollows >= 2 && lDel.inlineKatex !== l0.inlineKatex,
    'renderChanged=' +
      lRenderFollows +
      '/3 before=' +
      JSON.stringify(l0.inlineKatex) +
      ' after=' +
      JSON.stringify(lDel.inlineKatex)
  )
  // 光标移动（用户口径点名：光标移动要能用）
  await pressKey(app, 'Home', 'Home', 36)
  const lHome = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await pressKey(app, 'End', 'End', 35)
  const lEnd = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'L3 行内源码里 Home / End 能移动光标（没有被 PM 的 keymap 抢走）',
    lHome.selStart === 0 && lEnd.selStart === (lEnd.value || '').length,
    'home=' + lHome.selStart + ' end=' + lEnd.selStart + ' len=' + (lEnd.value || '').length
  )
  // ⚠️ 这一条是改前的"死穴"：Ctrl+A 会冒泡到 PM 的 selectAll，把**文档选区**变成 AllSelection
  await pressKey(app, 'a', 'KeyA', 65, 2)
  const lSelectAll = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'q')
  await sleep(260)
  const lReplace = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const lBlocksKept = JSON.stringify(lReplace.blockSources) === JSON.stringify(l0.blockSources)
  report.check(
    'L4 Ctrl+A 后敲字：替换发生在**源码框**里（PM 选区没被抢成 AllSelection，文档内容也没被换掉）',
    lSelectAll.pmSelName !== 'AllSelection' &&
      lReplace.value === 'q' &&
      lReplace.hasBox === true &&
      lReplace.activeIsTa === true &&
      lReplace.pmSelName !== 'AllSelection' &&
      lBlocksKept,
    'pmSel@Ctrl+A=' +
      lSelectAll.pmSelName +
      ' value=' +
      JSON.stringify(lReplace.value) +
      ' hasBox=' +
      lReplace.hasBox +
      ' pmSelAfter=' +
      lReplace.pmSelName +
      ' blocks=' +
      JSON.stringify(lReplace.blockSources)
  )
  // 还原这条行内公式（后面的段落不该看到中间态）
  // ⚠️ `if (!ta)` 不是客套：被测代码坏掉时（改前正是这条 L4 会把编辑框弄没）
  //    这里取到的是 null —— 套件要**继续跑完**、把后面的红都如实报出来，
  //    而不是在第一条就抛异常把报告截断。
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    if (!ta) return 'NO_BOX'
    ta.value = 'E = mc^2'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  await closeEditor(app)

  // ─── M ③ 公式拖不走；图片仍可拖（对照项）────────────────────────────────
  await reloadFix3(app)
  const p1Rect = await centerOf(app.ev, '.md-preview p')
  await openBlockEditor(app)
  await closeEditor(app)
  /**
   * 显式把公式选成 `NodeSelection` —— **前提要可复现**。
   *
   * 为什么要这一步：真实用户"拖公式"的前提是**节点已被选中**——PM 会给选中的叶节点补
   * `draggable="true"`（`prosemirror-view` 的 `selectNode()`），只有那样 `dragstart` 才会
   * 走"节点拖动"分支。而"点一下公式"这条路径**不总是**留下 `NodeSelection`：编辑容器一开，
   * 后续的点击会落进容器里（PM 选区停在附近），实测日志里这时 `dragging.node` 是 `false`
   *（拖拽退化成"文字拖动"，M1 的前提条款就会假红）。
   * 所以这里用 API 把前提钉死，再用手势去拖 —— 拖拽本身仍是**真实鼠标事件**。
   */
  await app.ev(`(() => {
    const ed = window.__L.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => {
      if (n.type.name === 'mathBlock') { pos = p; return false }
      return true
    })
    if (pos < 0) return 'no-block'
    ed.chain().setNodeSelection(pos).run()
    return 'ok'
  })()`)
  await sleep(350)
  const mSelected = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const blockRect = JSON.parse(await app.ev(centerExpr('.md-preview .md-math-block')))
  const mBefore = JSON.parse(await app.ev(SRC_SNAPSHOT)) // 顺手清空 dragLog
  await dragFromTo(
    app,
    { x: (blockRect.left + blockRect.right) / 2, y: (blockRect.top + blockRect.bottom) / 2 },
    { x: p1Rect.x, y: p1Rect.y + 6 }
  )
  const mBlock = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const blockDragSeen = (mBlock.dragLog || []).some(
    (l) => l.dragging && l.dragging.first === 'mathBlock'
  )
  /**
   * 判据用**现场序列化**（`freshMarkdown`）而不是 store 的 `content`：
   * 后者有一个 debounce，两次快照之间哪怕文档没动也可能因为"补一次同步"而不同
   *（实测会给出假红）。`freshMarkdown` 直接来自 `state.doc`，是"逐字不变"的可靠口径。
   * 另外钉住**这次拖动的性质**：公式必须已经被选中（PM 会给选中的叶节点补
   * `draggable=true` —— 那正是它会走"节点拖动"分支的入口）。
   */
  report.check(
    'M1 块级公式**拖不走**：真实拖拽手势之后文档逐字不变（且此时它正处于"选中后可被节点拖动"的状态）',
    mBlock.freshMarkdown === mBefore.freshMarkdown && mSelected.blockDraggable === 'true',
    'markdownSame=' +
      (mBlock.freshMarkdown === mBefore.freshMarkdown) +
      ' dragSeen=' +
      blockDragSeen +
      ' blockDraggableAfterSelect=' +
      mSelected.blockDraggable +
      ' log=' +
      JSON.stringify(mBlock.dragLog)
  )
  // 行内公式：拖着它走（基线取**上一次拖拽之后**的状态：每条断言只对自己那一次手势负责）
  const inlineRect = JSON.parse(await app.ev(centerExpr('.md-preview .md-math-rendered')))
  const mBeforeInline = mBlock.freshMarkdown
  await dragFromTo(
    app,
    { x: inlineRect.x, y: inlineRect.y },
    { x: p1Rect.x + 80, y: p1Rect.y + 10 }
  )
  const mInline = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'M2 行内公式**拖不走**：真实拖拽手势之后文档逐字不变',
    mInline.freshMarkdown === mBeforeInline,
    'markdownSame=' +
      (mInline.freshMarkdown === mBeforeInline) +
      ' log=' +
      JSON.stringify(mInline.dragLog)
  )
  // 对照项：图片（同一套手势、同一个判据 —— 它**必须**还能搬）
  if (!mInline.imgRect || mInline.imgRect.width < 20) {
    report.skip(
      'M3 图片节点仍然可以拖动（对照项）',
      '图片没加载出来（imgRect=' +
        JSON.stringify(mInline.imgRect) +
        '）——多半是实例的 LUMIN_TRUSTED_PATHS 没覆盖 %TEMP%'
    )
  } else {
    const imgRect = mInline.imgRect
    const mBeforeImg = mInline.freshMarkdown
    await clickAt(app.send, (imgRect.left + imgRect.right) / 2, (imgRect.top + imgRect.bottom) / 2)
    await sleep(400)
    await dragFromTo(
      app,
      { x: (imgRect.left + imgRect.right) / 2, y: (imgRect.top + imgRect.bottom) / 2 },
      { x: p1Rect.x, y: p1Rect.y + 6 }
    )
    const mImg = JSON.parse(await app.ev(SRC_SNAPSHOT))
    report.check(
      'M3 图片节点**仍然可以拖动**（同一套手势、同一个判据：文档必须变）—— 数学那条没误伤节点拖动',
      mImg.freshMarkdown !== mBeforeImg,
      'markdownChanged=' +
        (mImg.freshMarkdown !== mBeforeImg) +
        ' imgDraggableAfterSelect=' +
        mInline.imgDraggable +
        ' imgRect=' +
        JSON.stringify(mImg.imgRect)
    )
  }

  // ─── N ④ 空段落里敲 `$$` + 回车 → 空公式块 + 直接进编辑态 ─────────────────
  await openDocWith(app, MD4, 'math-edit-4.md')
  await waitEditor(app.ev)
  await sleep(900)
  await newEmptyParagraph(app)
  await typeChar(app.send, '$')
  await typeChar(app.send, '$')
  await sleep(250)
  const n0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'N1 在空段落里敲出 `$$`（此时还没有任何公式节点）—— 起点干净',
    n0.blockSources.length === 0 && n0.paraTexts.includes('$$'),
    'blocks=' + JSON.stringify(n0.blockSources) + ' paras=' + JSON.stringify(n0.paraTexts)
  )
  // 停一下再回车：把"敲 `$$`"与"回车插入"分成**两个历史分组**，
  // 这样下面那条 Ctrl+Z 验的就是"插入本身是一步"，而不是"两次编辑被并成一步"
  //（prosemirror-history 的 `newGroupDelay` 默认 500ms）。
  await sleep(750)
  await pressKey(app, 'Enter', 'Enter', 13)
  await sleep(500)
  const n1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'N2 回车 → 插入块级公式节点，且**编辑态已经打开、焦点就在源码框里**（不用再点一次）',
    n1.blockSources.length === 1 &&
      n1.blockSources[0] === '' &&
      n1.hasBox === true &&
      n1.shape === 'block' &&
      n1.activeIsTa === true &&
      n1.value === '',
    'blocks=' +
      JSON.stringify(n1.blockSources) +
      ' hasBox=' +
      n1.hasBox +
      ' shape=' +
      n1.shape +
      ' activeIsTa=' +
      n1.activeIsTa +
      ' value=' +
      JSON.stringify(n1.value)
  )
  /**
   * 一步撤销。
   *
   * ⚠️ 判据用**模型**（`blockSources` / `paraTexts`）而不是 `files().current.content`：
   * 后者是 store 侧的快照，敲完到落库有一个 debounce —— 拿它跟"打字之前"逐字节比，
   * 比的是两次快照谁更新，不是"撤销到底撤了几步"（本套件第一版就这么假红过）。
   */
  await pressKey(app, 'z', 'KeyZ', 90, 2) // Ctrl+Z
  await sleep(500)
  const n2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'N3 插入是**一步撤销**：一次 Ctrl+Z 就撤掉整块（节点消失、`$$` 段落回来、编辑态收起）',
    n2.blockSources.length === 0 && n2.paraTexts.includes('$$') && n2.hasBox === false,
    'blocks=' +
      JSON.stringify(n2.blockSources) +
      ' paras=' +
      JSON.stringify(n2.paraTexts) +
      ' hasBox=' +
      n2.hasBox
  )
  // 边界一：`$$` 出现在**行中间**（整段不是恰好 `$$`）不许触发
  //
  // 这里**重开一次夹具**：上一条撤销之后文档里正好留着一段文本 `$$`，
  // 而"在 `$$` 段落上按回车"本来就该触发插入 —— 拿它当边界用例会验错东西。
  await openDocWith(app, MD4, 'math-edit-4c.md')
  await waitEditor(app.ev)
  await sleep(900)
  await newEmptyParagraph(app)
  for (const ch of ['a', 'b', 'c', ' ', '$', '$']) await typeChar(app.send, ch)
  await sleep(250)
  const n3a = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const n3ParaCount = n3a.paraTexts.length
  await sleep(750)
  await pressKey(app, 'Enter', 'Enter', 13)
  await sleep(400)
  const n3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'N4 边界：「abc $$」这种**行中间**的 `$$` 不触发（回车还是普通换行），没有多出公式节点',
    n3a.paraTexts.includes('abc $$') &&
      n3.blockSources.length === 0 &&
      n3.hasBox === false &&
      n3.paraTexts.length === n3ParaCount + 1,
    'beforeEnter=' +
      JSON.stringify(n3a.paraTexts) +
      ' afterEnter=' +
      JSON.stringify(n3.paraTexts) +
      ' blocks=' +
      JSON.stringify(n3.blockSources) +
      ' hasBox=' +
      n3.hasBox
  )
  // 边界二：输入法组字中的回车**绝不能**触发（合成事件：真实 IME 无法用 CDP 驱动）
  await openDocWith(app, MD4, 'math-edit-4b.md')
  await waitEditor(app.ev)
  await sleep(900)
  await newEmptyParagraph(app)
  await typeChar(app.send, '$')
  await typeChar(app.send, '$')
  await sleep(250)
  await app.ev(`(() => {
    const el = document.querySelector('.ProseMirror')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
    return 'ok'
  })()`)
  await sleep(400)
  const n4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'N5 边界：**输入法组字中**的回车（`isComposing: true`）不触发插入 —— 那是"确认候选词"',
    n4.blockSources.length === 0 && n4.hasBox === false && n4.paraTexts.includes('$$'),
    'blocks=' +
      JSON.stringify(n4.blockSources) +
      ' hasBox=' +
      n4.hasBox +
      ' paras=' +
      JSON.stringify(n4.paraTexts)
  )
  // 边界三：代码块里绝不触发
  await reloadFix3(app)
  const cmBox = await centerOf(app.ev, '.md-preview .cm-content')
  if (!cmBox) {
    report.skip('N6 边界：代码块里敲 `$$`+回车 不触发', '代码块没渲染出来（找不到 .cm-content）')
  } else {
    await clickAt(app.send, cmBox.x, cmBox.y)
    await sleep(400)
    await typeChar(app.send, '$')
    await typeChar(app.send, '$')
    await pressKey(app, 'Enter', 'Enter', 13)
    await sleep(400)
    const n5 = JSON.parse(await app.ev(SRC_SNAPSHOT))
    report.check(
      'N6 边界：**代码块内**敲 `$$`+回车 绝不触发（公式节点数不变、代码块里就是那两个字面 `$`）',
      n5.blockSources.length === 1 &&
        n5.blockSources[0] === '\\frac{a}{b}' &&
        n5.docTypes.filter((t) => t === 'codeBlock').length === 1,
      'blocks=' +
        JSON.stringify(n5.blockSources) +
        ' codeBlocks=' +
        n5.docTypes.filter((t) => t === 'codeBlock').length +
        ' hasBox=' +
        n5.hasBox
    )
  }

  // ─── O ⑤ 空公式：保留框架 + `< Empty Math Block >`（占位不进文档）──────────
  await reloadFix3(app)
  await openBlockEditor(app)
  await pressKey(app, 'a', 'KeyA', 65, 2) // Ctrl+A（全选源码）
  await pressKey(app, 'Backspace', 'Backspace', 8) // 清空
  await sleep(300)
  const o = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'O1 空公式**保留框架**：节点还在（source 为空）、容器还开着、源码框还能继续输入',
    o.hasBox === true && o.value === '' && o.blockSources.length === 1 && o.blockSources[0] === '',
    'hasBox=' +
      o.hasBox +
      ' value=' +
      JSON.stringify(o.value) +
      ' blocks=' +
      JSON.stringify(o.blockSources)
  )
  report.check(
    'O2 编辑态下半区显示 `< Empty Math Block >`，用次级正文色、且**不可选中/不可点击**',
    o.emptyCount === 1 &&
      o.emptyText === '< Empty Math Block >' &&
      o.emptyUserSelect === 'none' &&
      o.emptyPointer === 'none' &&
      o.emptyEditable === 'false' &&
      !!o.emptyColor,
    'count=' +
      o.emptyCount +
      ' text=' +
      JSON.stringify(o.emptyText) +
      ' color=' +
      o.emptyColor +
      ' userSelect=' +
      o.emptyUserSelect +
      ' pointerEvents=' +
      o.emptyPointer +
      ' editable=' +
      o.emptyEditable
  )
  // 序列化那条单独再看一眼：判据用**现场序列化**（`ed.storage.markdown.getMarkdown()`），
  // 不用 store 侧的快照（它有一个 debounce，比的是谁更新而不是"文档里到底有什么"）
  await sleep(400)
  const oDoc = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const oSer = String(oDoc.freshMarkdown)
  report.check(
    'O3 占位**一个字都没进文档**：序列化是空的 `$$` 块，文档纯文本里搜不到那句话',
    /^\$\$\n\n\$\$$/m.test(oSer.replace(/\n$/, '')) &&
      !oSer.includes('Empty Math Block') &&
      !String(oDoc.docText).includes('Empty Math Block'),
    'hasEmptyBlock=' +
      /\$\$\n\n\$\$/m.test(oSer) +
      ' serHasPlaceholder=' +
      oSer.includes('Empty Math Block') +
      ' docTextHasPlaceholder=' +
      String(oDoc.docText).includes('Empty Math Block') +
      ' blocks=' +
      JSON.stringify(oDoc.blockSources) +
      ' around=' +
      JSON.stringify((oSer.match(/[$]{2}[\\s\\S]{0,14}?[$]{2}/) || ['<none>'])[0])
  )
  // 还能接着输入（占位让位、公式画出来）
  await typeChar(app.send, 'x')
  await typeChar(app.send, 'y')
  await sleep(300)
  const o4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'O4 空框里还能继续输入：敲两个字符后占位消失、源码与文档同步',
    o4.value === 'xy' &&
      o4.emptyCount === 0 &&
      o4.blockSources[0] === 'xy' &&
      o4.content.includes('xy'),
    'value=' +
      JSON.stringify(o4.value) +
      ' empty=' +
      o4.emptyCount +
      ' blocks=' +
      JSON.stringify(o4.blockSources)
  )
  // 收起来之后，**非编辑**渲染也要显示占位
  await app.ev(`(() => {
    const ta = document.querySelector('[data-md-math-editor-src]')
    if (!ta) return 'NO_BOX'
    ta.value = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  await closeEditor(app)
  await sleep(300)
  const o5 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'O5 收起编辑态后，**非编辑**的块级公式也画占位（框架仍在，观感与 Typora 一致）',
    o5.hasBox === false && o5.emptyRenderedCount === 1 && o5.blockSources[0] === '',
    'hasBox=' +
      o5.hasBox +
      ' renderedEmpty=' +
      o5.emptyRenderedCount +
      ' blocks=' +
      JSON.stringify(o5.blockSources)
  )

  // ─── P ⑥ 回归 ────────────────────────────────────────────────────────────
  await reloadFix3(app)
  const pOpened = await openBlockEditor(app)
  const p0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'x')
  await sleep(300)
  const p1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'P1 回归：块级源码区仍能**真实按键输入**（本轮改动没有回退上一轮的成果）',
    pOpened === true &&
      p1.value === (p0.value || '') + 'x' &&
      p1.activeIsTa === true &&
      String(p1.content).includes((p0.value || '') + 'x'),
    'opened=' +
      pOpened +
      ' before=' +
      JSON.stringify(p0.value) +
      ' after=' +
      JSON.stringify(p1.value) +
      ' activeIsTa=' +
      p1.activeIsTa +
      ' types=' +
      JSON.stringify(p1.docTypes)
  )
  const pSrcBox = JSON.parse(await app.ev(centerExpr('.md-math-editor__source')))
  await clickPoint(app.send, pSrcBox.right - 3, pSrcBox.bottom - 3)
  await sleep(300)
  const p2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'P2 回归：点源码区空白仍**不收起**（focus 还在框内、内容不变）',
    p2.hasBox === true && p2.activeInBox === true && p2.value === p1.value,
    'hasBox=' + p2.hasBox + ' activeInBox=' + p2.activeInBox + ' value=' + JSON.stringify(p2.value)
  )
  await closeEditor(app)
  const p3src = JSON.parse(await app.ev(SNAPSHOT))
  report.check(
    'P3 回归：代码块里的 `$` 与 `\\$` 字面量都不受影响（本轮新增的 `$$`+回车 规则没有误伤）',
    p3src.codeBlocks.length === 1 &&
      p3src.codeBlocks[0].lang === 'sh' &&
      p3src.codeBlocks[0].text === 'echo "$HOME"' &&
      p3src.content.includes('\\$5') &&
      p3src.blockSources.length === 1,
    'codeBlocks=' +
      JSON.stringify(p3src.codeBlocks) +
      ' has\\$5=' +
      p3src.content.includes('\\$5') +
      ' blocks=' +
      JSON.stringify(p3src.blockSources)
  )

  // ═══ 第三十三轮（用户第十轮反馈）：Q~T 四段 ═══════════════════════════════

  // ─── Q ① 空公式块的出路：源码框为空时按退格/Delete = 删掉整条公式块 ──────────
  await openDocWith(app, MD5, 'math-edit-5.md')
  await waitEditor(app.ev)
  await sleep(900)
  const qOpened = await openBlockEditor(app)
  await pressKey(app, 'a', 'KeyA', 65, 2) // Ctrl+A：选中整段源码
  await pressKey(app, 'Backspace', 'Backspace', 8) // 删掉选中的源码 ⇒ 空公式（框架保留）
  await sleep(300)
  const q0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q1 先把源码清空：**框架保留**（第九轮口径没被本轮改动碰坏）—— 节点还在、容器还开着、值为空',
    qOpened === true &&
      q0.hasBox === true &&
      q0.value === '' &&
      q0.blockSources.length === 1 &&
      q0.blockSources[0] === '' &&
      q0.emptyCount === 1,
    'opened=' +
      qOpened +
      ' hasBox=' +
      q0.hasBox +
      ' value=' +
      JSON.stringify(q0.value) +
      ' blocks=' +
      JSON.stringify(q0.blockSources) +
      ' empty=' +
      q0.emptyCount
  )
  // 留足 750ms 再删：清空源码与删块要落在**两个**历史组里，才好验证"删块只用一步"
  //（prosemirror-history 的 `newGroupDelay` 是 500ms，挨太近会被并成一步）
  await sleep(750)
  await pressKey(app, 'Backspace', 'Backspace', 8) // 空源码里按退格 ⇒ 删整条
  await sleep(400)
  const q1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q2 空源码里按**退格** → 删掉整条公式块（节点消失、编辑态收起、序列化里没有它）',
    q1.hasBox === false && q1.blockSources.length === 0 && !String(q1.freshMarkdown).includes('$$'),
    'hasBox=' +
      q1.hasBox +
      ' blocks=' +
      JSON.stringify(q1.blockSources) +
      ' freshHas$$=' +
      String(q1.freshMarkdown).includes('$$') +
      ' fresh=' +
      JSON.stringify(String(q1.freshMarkdown).slice(0, 60))
  )
  await pressKey(app, 'z', 'KeyZ', 90, 2) // Ctrl+Z：撤销"删除"这一步
  await sleep(400)
  const q2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q3 删除是**一个事务**：一次 Ctrl+Z 只回到"删除之前"那里（空公式框架回来，不是回到有源码的样子）',
    q2.blockSources.length === 1 &&
      q2.blockSources[0] === '' &&
      String(q2.freshMarkdown).includes('$$\n\n$$'),
    'blocks=' +
      JSON.stringify(q2.blockSources) +
      ' fresh=' +
      JSON.stringify(String(q2.freshMarkdown).slice(0, 60))
  )
  await pressKey(app, 'z', 'KeyZ', 90, 2) // 再撤一次：清空源码那一步
  await sleep(400)
  const q2b = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q3b 再撤一次 → 源码原文 `\\frac{a}{b}` 也回来（"删块"本身只占一步：两步撤销刚好回到最初）',
    q2b.blockSources.length === 1 && q2b.blockSources[0] === '\\frac{a}{b}',
    'blocks=' + JSON.stringify(q2b.blockSources)
  )
  // Delete 是同一语义（对称）
  await openBlockEditor(app)
  await pressKey(app, 'a', 'KeyA', 65, 2)
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await pressKey(app, 'Delete', 'Delete', 46)
  await sleep(400)
  const q3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q4 空源码里按 **Delete** 也是同一语义（删掉整条，不是"什么都不发生"）',
    q3.hasBox === false && q3.blockSources.length === 0,
    'hasBox=' + q3.hasBox + ' blocks=' + JSON.stringify(q3.blockSources)
  )
  // 整篇只有这一条公式：删掉之后文档仍要合法（补空段落，不能出现空 doc）
  await openDocWith(app, MD6, 'math-edit-6.md')
  await waitEditor(app.ev)
  await sleep(900)
  const qSoloOpened = await openBlockEditor(app)
  await pressKey(app, 'a', 'KeyA', 65, 2)
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const q4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q5 「整篇只剩这一条公式」时删掉它仍**合法**：文档留下一个空段落（不是空 doc、也不抛异常）',
    qSoloOpened === true &&
      q4.blockSources.length === 0 &&
      q4.docTypes.length === 1 &&
      q4.docTypes[0] === 'paragraph',
    'opened=' +
      qSoloOpened +
      ' blocks=' +
      JSON.stringify(q4.blockSources) +
      ' types=' +
      JSON.stringify(q4.docTypes)
  )

  /**
   * Q6/Q7：**光标紧贴块的两端**（在文档里，不在源码框）按退格/Delete。
   *
   * 这一路本来就走 PM/Tiptap 的既有路径（实测：一次就删掉整块、`Ctrl+Z` 一步回来，
   * 与图片那种"先选中再删"不同）——本轮**没有改**它，但用户口径要求"至少覆盖第一种与
   * 最后一种"，所以钉在这里：以后谁为了改公式（比如给 mathBlock 加 `draggable`、
   * 改 keymap priority）把这条路弄坏，这里会立刻红。
   */
  const paraEdge = (prefix, side) => `(() => {
    const ps = [...document.querySelectorAll('.md-preview p')]
    const el = ps.find((x) => x.textContent.startsWith(${JSON.stringify(prefix)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(${side === 'left' ? 'r.left + 2' : 'r.right - 2'}), y: Math.round(r.top + r.height / 2) })
  })()`
  await openDocWith(app, MD5, 'math-edit-5d.md')
  await waitEditor(app.ev)
  await sleep(900)
  const q6pos = JSON.parse(await app.ev(paraEdge('下一段', 'left')))
  await clickAt(app.send, q6pos.x, q6pos.y)
  await sleep(300)
  await pressKey(app, 'Home', 'Home', 36)
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const q6 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await pressKey(app, 'z', 'KeyZ', 90, 2)
  await sleep(400)
  const q6b = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q6 光标在**块后那一段的行首**按退格 → 同样一次删掉整条公式块，且 `Ctrl+Z` 一步回来',
    q6.blockSources.length === 0 &&
      q6b.blockSources.length === 1 &&
      q6b.blockSources[0] === '\\frac{a}{b}',
    'afterBackspace=' +
      JSON.stringify(q6.blockSources) +
      ' afterUndo=' +
      JSON.stringify(q6b.blockSources)
  )
  await openDocWith(app, MD5, 'math-edit-5e.md')
  await waitEditor(app.ev)
  await sleep(900)
  const q7pos = JSON.parse(await app.ev(paraEdge('上一段', 'right')))
  await clickAt(app.send, q7pos.x, q7pos.y)
  await sleep(300)
  await pressKey(app, 'End', 'End', 35)
  await pressKey(app, 'Delete', 'Delete', 46)
  await sleep(400)
  const q7 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Q7 光标在**块前那一段的行尾**按 Delete → 也一次删掉整条公式块（两端对称）',
    q7.blockSources.length === 0,
    'afterDelete=' + JSON.stringify(q7.blockSources)
  )

  // ─── R ② 对照项：源码**非空**时退格只删字符 ────────────────────────────────
  await openDocWith(app, MD5, 'math-edit-5b.md')
  await waitEditor(app.ev)
  await sleep(900)
  const rOpened = await openBlockEditor(app)
  const r0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(300)
  const r1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'R1 对照：源码**非空**时退格只删一个字符 —— 块还在、编辑态还开着（没有一刀切删块）',
    rOpened === true &&
      r0.value === '\\frac{a}{b}' &&
      r1.value === '\\frac{a}{b' &&
      r1.hasBox === true &&
      r1.blockSources.length === 1 &&
      r1.blockSources[0] === '\\frac{a}{b',
    'before=' +
      JSON.stringify(r0.value) +
      ' after=' +
      JSON.stringify(r1.value) +
      ' hasBox=' +
      r1.hasBox +
      ' blocks=' +
      JSON.stringify(r1.blockSources)
  )

  // ─── S ③ 逐键敲 `$E=mc^2$`：收尾 `$` 落下那一刻就渲染 ──────────────────────
  await openDocWith(app, MD7, 'math-edit-7.md')
  await waitEditor(app.ev)
  await sleep(900)
  const sPara = await centerOf(app.ev, '.md-preview p')
  await clickAt(app.send, sPara.x, sPara.y)
  await sleep(300)
  await pressKey(app, 'End', 'End', 35)
  const sChars = ['$', 'E', '=', 'm', 'c', '^', '2', '$']
  const timeline = []
  let sLast = null
  for (const ch of sChars) {
    await typeChar(app.send, ch)
    await sleep(200)
    sLast = JSON.parse(await app.ev(SRC_SNAPSHOT))
    timeline.push(sLast.inlineWidgetCount)
  }
  report.check(
    'S1 逐键敲 `$E=mc^2$`：**收尾 `$` 落下的那一刻**就出现行内公式渲染（给出的逐键 widget 时间线只有最后一位变成 1）',
    timeline.length === 8 &&
      timeline.slice(0, 7).every((n) => n === 0) &&
      timeline[7] === 1 &&
      sLast !== null &&
      sLast.mathMarkedTexts.length === 1 &&
      sLast.mathMarkedTexts[0] === '$E=mc^2$',
    '时间线=' +
      JSON.stringify(timeline) +
      ' marked=' +
      JSON.stringify(sLast && sLast.mathMarkedTexts)
  )
  report.check(
    'S2 立刻渲染出来的那条公式：原文逐字留在文档里、光标停在公式**之后**（没被吞进公式）',
    sLast !== null &&
      String(sLast.freshMarkdown).includes('$E=mc^2$') &&
      sLast.paraTexts.some((t) => t.endsWith('$E=mc^2$')) &&
      sLast.pmSelName === 'TextSelection',
    'fresh=' +
      JSON.stringify(String(sLast && sLast.freshMarkdown).slice(0, 70)) +
      ' sel=' +
      (sLast && sLast.pmSelName) +
      '@' +
      (sLast && sLast.pmSelFrom)
  )
  report.check(
    'S3 同一套判据：收尾 `$` 前若只有空白/转义或根本没有开括号，**不会**凭空造公式',
    (() => {
      const t = sLast
      // 这条断言是"反面"的：`$E=mc^2$` 之外没有第二个 widget（比如 `$$`、`$ x$` 那种被误判）
      return t !== null && t.inlineWidgetCount === 1 && t.mathMarkedTexts.length === 1
    })(),
    'widgets=' +
      (sLast && sLast.inlineWidgetCount) +
      ' marked=' +
      JSON.stringify(sLast && sLast.mathMarkedTexts)
  )
  // 继续输入普通文字：不该被吞进公式（storedMarks 清干净了）
  await typeChar(app.send, 'x')
  await typeChar(app.send, 'y')
  await sleep(300)
  const sNext = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'S4 公式后面继续输入的 `xy` **不进公式**（storedMarks 已清，公式文本仍是 `$E=mc^2$`）',
    sNext.mathMarkedTexts.length === 1 &&
      sNext.mathMarkedTexts[0] === '$E=mc^2$' &&
      sNext.paraTexts.some((t) => t.endsWith('$E=mc^2$xy')),
    'marked=' + JSON.stringify(sNext.mathMarkedTexts) + ' paras=' + JSON.stringify(sNext.paraTexts)
  )

  // ─── T ④ 回归：占位仍在（且不在文档里）+ `$$`+回车仍出块并进编辑态 ──────────
  await openDocWith(app, MD5, 'math-edit-5c.md')
  await waitEditor(app.ev)
  await sleep(900)
  await openBlockEditor(app)
  await pressKey(app, 'a', 'KeyA', 65, 2)
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(700)
  const t0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'T1 回归：空公式仍画 `< Empty Math Block >` 占位，且**序列化里没有这句文案**、空块形态是 `$$\\n\\n$$`',
    t0.hasBox === true &&
      t0.emptyCount === 1 &&
      t0.emptyText === '< Empty Math Block >' &&
      !String(t0.freshMarkdown).includes('Empty Math Block') &&
      String(t0.freshMarkdown).includes('$$\n\n$$'),
    'empty=' +
      t0.emptyCount +
      ' text=' +
      JSON.stringify(t0.emptyText) +
      ' serHasPlaceholder=' +
      String(t0.freshMarkdown).includes('Empty Math Block') +
      ' hasEmptyBlock=' +
      String(t0.freshMarkdown).includes('$$\n\n$$') +
      ' fresh=' +
      JSON.stringify(String(t0.freshMarkdown).slice(0, 80))
  )
  await closeEditor(app)
  await openDocWith(app, MD4, 'math-edit-4d.md')
  await waitEditor(app.ev)
  await sleep(900)
  await newEmptyParagraph(app)
  await typeChar(app.send, '$')
  await typeChar(app.send, '$')
  await sleep(750)
  await pressKey(app, 'Enter', 'Enter', 13)
  await sleep(500)
  const t1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'T2 回归：空段落里 `$$`+回车 仍能出公式块、**编辑态已打开且焦点在源码框**（第九轮口径没被碰坏）',
    t1.blockSources.length === 1 &&
      t1.blockSources[0] === '' &&
      t1.hasBox === true &&
      t1.shape === 'block' &&
      t1.activeIsTa === true,
    'blocks=' +
      JSON.stringify(t1.blockSources) +
      ' hasBox=' +
      t1.hasBox +
      ' shape=' +
      t1.shape +
      ' activeIsTa=' +
      t1.activeIsTa
  )

  // ═══ 第三十三轮（用户第十一轮反馈）：U~W 三段 ═══════════════════════════════
  //
  // 病灶：`MdMath` 这个 mark 默认 `inclusive: true` —— 光标停在公式**右边界**时 mark 仍生效，
  // 于是「写完公式后在公式后打字」会把字**并进公式**（序列化跟着变），用户还报告"点右边界
  // 不出现光标"。U/V 段把「右边界打字落进正文」这件事按四条路径钉死。

  /**
   * U ①④：**现场敲出**一条公式后立刻继续打字（段落中/段落末尾各一次）。
   *
   * 判据两条（用户口径）：① 公式 mark 的文本仍是 `$E=mc^2$`（一个字都没被并进去）；
   * ② 现场序列化里多出来的字在公式**之外**。
   */
  const liveTypeFixture = ['上一段：占位。', '', '打字区：'].join('\n')
  await openDocWith(app, liveTypeFixture, 'math-edit-11.md')
  await waitEditor(app.ev)
  await sleep(900)
  const uPara = await centerOf(app.ev, '.md-preview p:last-of-type')
  await clickAt(app.send, uPara.x, uPara.y)
  await sleep(250)
  await pressKey(app, 'End', 'End', 35)
  for (const ch of ['$', 'E', '=', 'm', 'c', '^', '2', '$']) await typeChar(app.send, ch)
  await sleep(250)
  const uAfterMath = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'x')
  await typeChar(app.send, 'y')
  await sleep(300)
  const u = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'U1 ① 现场敲出公式后**继续打字**：新字落在公式之外（公式 mark 文本仍是 `$E=mc^2$`，序列化里是公式在前、新字在后）',
    uAfterMath.mathMarkedTexts.length === 1 &&
      uAfterMath.mathMarkedTexts[0] === '$E=mc^2$' &&
      u.mathMarkedTexts.length === 1 &&
      u.mathMarkedTexts[0] === '$E=mc^2$' &&
      String(u.freshMarkdown).includes('$E=mc^2$xy') &&
      String(u.freshMarkdown).indexOf('$E=mc^2$') < String(u.freshMarkdown).indexOf('xy'),
    'markedBefore=' +
      JSON.stringify(uAfterMath.mathMarkedTexts) +
      ' markedAfter=' +
      JSON.stringify(u.mathMarkedTexts) +
      ' fresh=' +
      JSON.stringify(String(u.freshMarkdown).slice(0, 70))
  )
  report.check(
    'U2 ① 打字之后光标处**不继承** mdMath（`marksAtCaret` / `storedMarks` 里都没有它）',
    !u.marksAtCaret.includes('mdMath') && !u.storedMarks.includes('mdMath'),
    'marksAtCaret=' + JSON.stringify(u.marksAtCaret) + ' stored=' + JSON.stringify(u.storedMarks)
  )

  /**
   * V ②③：**点击公式右侧**与**方向键走到右边界**两条路径（段落中/段落末尾各一次）。
   *
   * 判据（用户口径）：`activeElement` 是编辑器、选区 offset 落在公式**之后**、位置**不带
   * math mark**；再打字 → 落进正文。
   */
  const clickFixture = ['第一段：中间 $E=mc^2$ 后面还有字。', '', '第二段：末尾就是 $E=mc^2$'].join(
    '\n'
  )
  await openDocWith(app, clickFixture, 'math-edit-11b.md')
  await waitEditor(app.ev)
  await sleep(900)
  const vMid = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const vMidSpan = vMid.mathMarkedSpans[0]
  const vMidWidget = await centerOf(app.ev, '.md-preview .md-math-rendered')
  // 点渲染结果的**右边缘再往右 1px**：这正是"点公式右侧"最容易踩到的那一格
  const vMidRect = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelectorAll('.md-preview .md-math-rendered')[0]
      const r = el.getBoundingClientRect()
      return JSON.stringify({ right: Math.round(r.right), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  await clickAt(app.send, vMidRect.right + 1, vMidRect.y)
  await sleep(350)
  const v2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'V1 ② 点公式右侧 → 选区落在**公式之后**（offset === 公式右边界），且 `activeElement` 是编辑器',
    vMidSpan !== undefined &&
      v2.pmSelFrom === vMidSpan.to &&
      v2.marksAtCaret.length === 0 &&
      v2.activeTag !== 'BODY',
    'spanTo=' +
      (vMidSpan && vMidSpan.to) +
      ' selFrom=' +
      v2.pmSelFrom +
      ' marksAtCaret=' +
      JSON.stringify(v2.marksAtCaret) +
      ' active=' +
      v2.activeTag
  )
  await typeChar(app.send, 'a')
  await typeChar(app.send, 'b')
  await sleep(300)
  const v3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'V2 ② 点完再打字 → 字落进**正文**（公式文本一个字没变，序列化里新字在公式之后）',
    v3.mathMarkedTexts.length === 2 &&
      v3.mathMarkedTexts[0] === '$E=mc^2$' &&
      String(v3.freshMarkdown).includes('$E=mc^2$ab'),
    'marked=' +
      JSON.stringify(v3.mathMarkedTexts) +
      ' fresh=' +
      JSON.stringify(String(v3.freshMarkdown).slice(0, 60))
  )
  // 段落**末尾**就是公式：点它右侧（这一格改前永远点不出光标、而且打字会并进公式）
  await openDocWith(app, clickFixture, 'math-edit-11c.md')
  await waitEditor(app.ev)
  await sleep(900)
  const vEnd = JSON.parse(await app.ev(SRC_SNAPSHOT))
  const vEndSpan = vEnd.mathMarkedSpans[1]
  const vEndRect = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelectorAll('.md-preview .md-math-rendered')[1]
      const r = el.getBoundingClientRect()
      return JSON.stringify({ right: Math.round(r.right), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  await clickAt(app.send, vEndRect.right + 1, vEndRect.y)
  await sleep(350)
  const v4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'c')
  await sleep(300)
  const v5 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'V3 ④ 段落**末尾**就是公式：点它右侧 → 选区在公式之后且不带 mark；打字落进正文（不并进公式）',
    vEndSpan !== undefined &&
      v4.pmSelFrom === vEndSpan.to &&
      v4.marksAtCaret.length === 0 &&
      v5.mathMarkedTexts.length === 2 &&
      v5.mathMarkedTexts[1] === '$E=mc^2$' &&
      String(v5.freshMarkdown).includes('$E=mc^2$c'),
    'spanTo=' +
      (vEndSpan && vEndSpan.to) +
      ' selFrom=' +
      v4.pmSelFrom +
      ' marksAtCaret=' +
      JSON.stringify(v4.marksAtCaret) +
      ' marked=' +
      JSON.stringify(v5.mathMarkedTexts) +
      ' fresh=' +
      JSON.stringify(String(v5.freshMarkdown).slice(0, 70))
  )
  // ③ 方向键：从公式内部按 → 到右边界，再打字
  await openDocWith(app, clickFixture, 'math-edit-11d.md')
  await waitEditor(app.ev)
  await sleep(900)
  const wSpan = JSON.parse(await app.ev(SRC_SNAPSHOT)).mathMarkedSpans[0]
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.chain().focus().setTextSelection(${wSpan.to - 1}).run()
    return 'ok'
  })()`)
  await sleep(250)
  await pressKey(app, 'ArrowRight', 'ArrowRight', 39)
  await sleep(250)
  const w1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'z')
  await sleep(300)
  const w2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'V4 ③ 方向键走到公式右边界 → 位置不带 mark；再打字落进正文（键盘路径与点击路径一致）',
    w1.pmSelFrom === wSpan.to &&
      w1.marksAtCaret.length === 0 &&
      w2.mathMarkedTexts[0] === '$E=mc^2$' &&
      String(w2.freshMarkdown).includes('$E=mc^2$z'),
    'spanTo=' +
      wSpan.to +
      ' selFrom=' +
      w1.pmSelFrom +
      ' marksAtCaret=' +
      JSON.stringify(w1.marksAtCaret) +
      ' marked=' +
      JSON.stringify(w2.mathMarkedTexts) +
      ' fresh=' +
      JSON.stringify(String(w2.freshMarkdown).slice(0, 60))
  )

  /**
   * W ⑤：**块级公式之后**也要能落光标、能打字（用户要求"同类检查块级公式，例如空公式块之后"）。
   * 夹具末尾就是块级公式 —— 点它下方的空白，应当得到一个可写的段落。
   */
  await openDocWith(
    app,
    ['前段：正文。', '', '$$', '\\frac{a}{b}', '$$'].join('\n'),
    'math-edit-11e.md'
  )
  await waitEditor(app.ev)
  await sleep(900)
  const wBlock = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelector('.md-preview .md-math-block')
      const r = el.getBoundingClientRect()
      return JSON.stringify({ bottom: Math.round(r.bottom), left: Math.round(r.left) })
    })()`)
  )
  await clickAt(app.send, wBlock.left + 60, wBlock.bottom + 26)
  await sleep(400)
  const w3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await typeChar(app.send, 'k')
  await sleep(300)
  const w4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'W1 ⑤ 块级公式之后：点它下方空白能落下光标并打字（文档末尾多出一个段落，块公式原文不变）',
    w3.blockSources.length === 1 &&
      w3.blockSources[0] === '\\frac{a}{b}' &&
      w4.blockSources.length === 1 &&
      w4.paraTexts.some((t) => t.includes('k')) &&
      String(w4.freshMarkdown).includes('k'),
    'blocks=' +
      JSON.stringify(w4.blockSources) +
      ' paras=' +
      JSON.stringify(w4.paraTexts) +
      ' fresh=' +
      JSON.stringify(String(w4.freshMarkdown).slice(-40))
  )

  // ═══ 第三十四轮（用户第十二轮反馈）：X~Z 三段 ═══════════════════════════════
  //
  // 两条：① "段末公式右边点一下，看不见光标、以为写不进去"（真因是折叠原文 font-size:0
  // ⇒ 原生插入符高度 0；这一轮补**自绘插入符**）；② 把收尾 `$` 删掉后 `$\frac{1}{2}`
  // 不再配平，应当**退回普通文本**而不是弹 `Can't use function '$' in math mode`。

  /**
   * X ①：**段落末尾是公式**这一格 —— 点右侧 + 真实按键敲 3 个字。
   *
   * 判据按用户口径：字**真的进文档**（现场序列化 + 段落文本两条），且公式原文一个字不变。
   */
  await openDocWith(app, MD8, 'math-edit-12.md')
  await waitEditor(app.ev)
  await sleep(900)
  const xSpans = JSON.parse(await app.ev(SRC_SNAPSHOT)).mathMarkedSpans
  const xEndSpan = xSpans[0] // 第二段那条（段末公式）
  const xRect = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelectorAll('.md-preview .md-math-rendered')[0]
      const r = el.getBoundingClientRect()
      return JSON.stringify({ right: Math.round(r.right), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  await clickAt(app.send, xRect.right + 1, xRect.y)
  await sleep(350)
  const x0 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  for (const ch of ['A', 'B', 'C']) await typeChar(app.send, ch)
  await sleep(350)
  const x1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'X1 ① 段末公式：点右侧（原生插入符高度为 0 的那一格）后敲 3 个字 → 字**真的进了文档**，公式原文不变',
    xEndSpan !== undefined &&
      x0.pmSelFrom === xEndSpan.to &&
      x0.marksAtCaret.length === 0 &&
      x1.mathMarkedTexts[0] === '$E=mc^2$' &&
      x1.paraTexts[1] === '第二段：段末公式 $E=mc^2$ABC' &&
      String(x1.freshMarkdown).includes('$E=mc^2$ABC'),
    'spanTo=' +
      (xEndSpan && xEndSpan.to) +
      ' selFrom=' +
      x0.pmSelFrom +
      ' marksAtCaret=' +
      JSON.stringify(x0.marksAtCaret) +
      ' marked=' +
      JSON.stringify(x1.mathMarkedTexts) +
      ' para=' +
      JSON.stringify(x1.paraTexts[1])
  )

  /**
   * Y ②：自绘插入符 —— 该出现的位置可见，普通位置不出现，失焦隐藏。
   */
  await openDocWith(app, MD8, 'math-edit-12b.md')
  await waitEditor(app.ev)
  await sleep(900)
  const ySpans = JSON.parse(await app.ev(SRC_SNAPSHOT)).mathMarkedSpans
  const yRect = JSON.parse(
    await app.ev(`(() => {
      const el = document.querySelectorAll('.md-preview .md-math-rendered')[0]
      const r = el.getBoundingClientRect()
      return JSON.stringify({ right: Math.round(r.right), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  await clickAt(app.send, yRect.right + 1, yRect.y)
  await sleep(400)
  const y1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Y1 ② 段末公式右边界：出现**自绘插入符**（宽 ≥1px、高 >0），且原生插入符高度确实是 0（自绘就是为它补的）',
    y1.caretWidgets.length === 1 &&
      y1.caretWidgets[0].w >= 1 &&
      y1.caretWidgets[0].h > 0 &&
      y1.caretHeight === 0 &&
      y1.pmSelFrom === ySpans[0].to,
    'carets=' +
      JSON.stringify(y1.caretWidgets) +
      ' nativeCaretH=' +
      y1.caretHeight +
      ' selFrom=' +
      y1.pmSelFrom +
      ' spanTo=' +
      ySpans[0].to
  )
  // 对照：普通文字位置不画自绘（那里原生插入符本来是好的）
  await app.ev(
    `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(3).run(); return 'ok' })()`
  )
  await sleep(350)
  const y2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Y2 ② 对照：普通文字中间**不出现**自绘插入符（原生插入符高度 >0，行为一点没变）',
    y2.caretWidgets.length === 0 && y2.caretHeight > 0,
    'carets=' + JSON.stringify(y2.caretWidgets) + ' nativeCaretH=' + y2.caretHeight
  )
  // 失焦 → 自绘隐藏
  await app.ev(
    `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(${ySpans[0].to}).run(); return 'ok' })()`
  )
  await sleep(350)
  const y3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await app.ev(`(() => { window.__L.ed().commands.blur(); return 'ok' })()`)
  await sleep(400)
  const y4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Y3 ② 失焦后自绘插入符隐藏（重新聚焦再出现）',
    y3.caretWidgets.length === 1 && y4.caretWidgets.length === 0 && y4.activeTag !== 'DIV',
    'beforeBlur=' +
      JSON.stringify(y3.caretWidgets) +
      ' afterBlur=' +
      JSON.stringify(y4.caretWidgets) +
      ' active=' +
      y4.activeTag
  )

  /**
   * Z ③④⑤：不配平 → 退回普通文本（不渲染、不报错）；配平但语法错 → 仍然报错态。
   */
  const zBase = async (name) => {
    await openDocWith(app, MD8, name)
    await waitEditor(app.ev)
    await sleep(900)
    return JSON.parse(await app.ev(SRC_SNAPSHOT))
  }
  const putCaretAt = async (posExpr) => {
    await app.ev(
      `(() => { const ed = window.__L.ed(); ed.chain().focus().setTextSelection(${posExpr}).run(); return 'ok' })()`
    )
    await sleep(280)
  }
  let z = await zBase('math-edit-12c.md')
  // ③a 段末公式：光标在右边界按退格 = 删掉收尾 `$`
  await putCaretAt(String(z.mathMarkedSpans[0].to))
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const z1 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Z1 ③ 删掉收尾 `$`（`$E=mc^2$` → `$E=mc^2`）：**退回普通文本** —— 不再带 mdMath、没有 KaTeX 错误、没有 invalid，段落文本与序列化都是字面文本',
    z1.mathMarkedSpans.length === 4 &&
      !z1.mathMarkedTexts.includes('$E=mc^2') &&
      z1.mathErrorCount === 1 && // 只剩第五段那条"配平但未定义宏"的错误态
      z1.invalidCount === 0 &&
      z1.paraTexts[1] === '第二段：段末公式 $E=mc^2' &&
      String(z1.freshMarkdown).includes('第二段：段末公式 $E=mc^2'),
    'marked=' +
      JSON.stringify(z1.mathMarkedTexts) +
      ' errors=' +
      z1.mathErrorCount +
      ' invalid=' +
      z1.invalidCount +
      ' para=' +
      JSON.stringify(z1.paraTexts[1])
  )
  // ③b 删掉开头 `$`（光标在开头 `$` 之后按退格）
  z = await zBase('math-edit-12d.md')
  await putCaretAt(String(z.mathMarkedSpans[1].from + 1))
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const z2 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Z2 ③ 删掉开头 `$`（`$\\frac{1}{2}$` → `\\frac{1}{2}$`）：同样退回普通文本（不渲染、不报错、无 mark）',
    z2.mathMarkedSpans.length === 4 &&
      z2.paraTexts[2].includes('开头公式 \\frac{1}{2}$ 后面还有字。') &&
      String(z2.freshMarkdown).includes('\\frac{1}{2}$ 后面还有字。'),
    'marked=' + JSON.stringify(z2.mathMarkedTexts) + ' para=' + JSON.stringify(z2.paraTexts[2])
  )
  // ④ 中间那条 `$` 被删：`$a$$b$` → `$a$b$`（前半仍是公式，后半退回普通文本）
  z = await zBase('math-edit-12e.md')
  const bSpan = z.mathMarkedSpans[3]
  await putCaretAt(String(bSpan.from))
  await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const z3a = JSON.parse(await app.ev(SRC_SNAPSHOT))
  await putCaretAt(String(z3a.mathMarkedSpans[2].from + 3))
  await pressKey(app, 'Delete', 'Delete', 46)
  await sleep(400)
  const z3 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Z3 ④ 中间那个 `$` 被删（`$a$$b$` → `$a$b$`）：前半 `$a$` 仍是公式，后半 `b$` 退回普通文本，且无错误节点',
    z3a.paraTexts[3] === '第四段：两条 $a$$b$' &&
      z3.paraTexts[3] === '第四段：两条 $a$b$' &&
      z3.mathMarkedTexts.includes('$a$') &&
      !z3.mathMarkedTexts.includes('b$') &&
      z3.mathErrorCount === 1,
    'afterSpace=' +
      JSON.stringify(z3a.paraTexts[3]) +
      ' afterDollar=' +
      JSON.stringify(z3.paraTexts[3]) +
      ' marked=' +
      JSON.stringify(z3.mathMarkedTexts) +
      ' errors=' +
      z3.mathErrorCount
  )
  // ④b 删到只剩一个 `$`
  z = await zBase('math-edit-12f.md')
  await putCaretAt(String(z.mathMarkedSpans[4].to))
  for (let i = 0; i < 3; i += 1) await pressKey(app, 'Backspace', 'Backspace', 8)
  await sleep(400)
  const z4 = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'Z4 ④ 配平公式被删到只剩一个 `$`：整段退回普通文本（没有 KaTeX 错误、没有 invalid）',
    z4.mathMarkedSpans.length === 4 &&
      z4.mathErrorCount === 0 &&
      z4.invalidCount === 0 &&
      z4.paraTexts[4].startsWith('第五段：坏公式 $'),
    'marked=' +
      JSON.stringify(z4.mathMarkedTexts) +
      ' errors=' +
      z4.mathErrorCount +
      ' invalid=' +
      z4.invalidCount +
      ' para=' +
      JSON.stringify(z4.paraTexts[4])
  )
  // ⑤ 对照：配平但未定义宏 → 仍然显示明确错误态（不静默降级）
  z = await zBase('math-edit-12g.md')
  report.check(
    'Z5 ⑤ 对照：`$\\notarealmacro$`（配平、但未定义宏）**仍然**进错误态（标题里带 Undefined control sequence），mark 也保留',
    z.mathErrorCount === 1 &&
      !!z.mathErrorTitle &&
      z.mathErrorTitle.includes('Undefined control sequence') &&
      z.mathMarkedTexts.includes('$\\notarealmacro$'),
    'errors=' +
      z.mathErrorCount +
      ' title=' +
      JSON.stringify(z.mathErrorTitle) +
      ' marked=' +
      JSON.stringify(z.mathMarkedTexts)
  )

  // ═══ 第三十五轮（用户第十三轮反馈）：PA 段 —— 从 Typora 连正文一起复制公式过来 ═══
  //
  // 实测真因（第十三轮探针原始数据见报告 §1）：剪贴板同时有 text/html 与 text/plain 时
  // ProseMirror 走 HTML 那条，而 Typora 的 HTML 里公式是 KaTeX 的 DOM（`.katex-display` +
  // MathML + `annotation`），我们的 schema 不认 ⇒ 被通用 HTML 解析拆成纯文本；随后写出器
  // 对普通文本的 `\` 做 CommonMark 转义、行内硬换行写成行尾 `\` ⇒ 用户看到的
  // `$$\\` + 加倍反斜杠全是下游症状。修法见 lib/editor/mathPaste.ts。

  /** 造一次"Typora 那种剪贴板"并派发 paste（html 为 null = 只发纯文本） */
  const pasteWith = (html, text) => `(() => {
    const view = window.__L.ed().view
    const dt = new DataTransfer()
    ${html === null ? '' : `dt.setData('text/html', ${JSON.stringify(html)})`}
    ${text === null ? '' : `dt.setData('text/plain', ${JSON.stringify(text)})`}
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    view.dom.dispatchEvent(ev)
    return 'ok'
  })()`
  const PASTE_TEX = 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'
  /** Typora 复制块级公式时 HTML 里那一坨（KaTeX 真实结构：mathml 带 annotation + 视觉层） */
  const PASTE_HTML_BLOCK = [
    '<p>前面一段普通文字。</p>',
    '<span class="katex-display"><span class="katex">',
    '<span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow>',
    '<annotation encoding="application/x-tex">' + PASTE_TEX + '</annotation>',
    '</semantics></math></span>',
    '<span class="katex-html" aria-hidden="true">x=2a\\u2212b\\u00b1b2\\u22124ac</span>',
    '</span></span>',
    '<p>后面一段普通文字。</p>'
  ].join('')
  const PASTE_HTML_INLINE = [
    '<p>前面 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow>',
    '<annotation encoding="application/x-tex">E = mc^2</annotation>',
    '</semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span> 后面。</p>'
  ].join('')
  const PASTE_TEXT_BLOCK = [
    '前面一段普通文字。',
    '',
    '$$',
    PASTE_TEX,
    '$$',
    '',
    '后面一段普通文字。'
  ].join('\n')
  const PASTE_BASE = ['第一段：占位。', '', '第二段：占位。'].join('\n')
  const pasteRun = async (name, html, text) => {
    await openDocWith(app, PASTE_BASE, name)
    await waitEditor(app.ev)
    await sleep(900)
    await ensureFocus(app)
    await app.ev(`(() => {
      const ed = window.__L.ed()
      ed.chain().focus().setTextSelection(ed.state.doc.content.size).run()
      return 'ok'
    })()`)
    await sleep(250)
    await app.ev(pasteWith(html, text))
    await sleep(700)
    return JSON.parse(await app.ev(SRC_SNAPSHOT))
  }

  // ① HTML 剪贴板（KaTeX 结构 + annotation，**前后各有一段普通文字**）
  const pa1 = await pasteRun('math-edit-13a.md', PASTE_HTML_BLOCK, null)
  report.check(
    'PA1 ① HTML 剪贴板（KaTeX + annotation，前后都有文字）→ 出**块级公式节点**、渲染出 KaTeX、前后文字都在、序列化是规范 `$$…$$`（单反斜杠、无行尾 `\\`）',
    pa1.blockSources.length === 1 &&
      pa1.blockSources[0] === PASTE_TEX &&
      pa1.paraTexts.includes('前面一段普通文字。') &&
      pa1.paraTexts.includes('后面一段普通文字。') &&
      pa1.inlineKatexCount >= 1 &&
      String(pa1.freshMarkdown).includes('$$\n' + PASTE_TEX + '\n$$') &&
      !String(pa1.freshMarkdown).includes('\\\\frac') &&
      !String(pa1.freshMarkdown).includes('\\\n'),
    'blocks=' +
      JSON.stringify(pa1.blockSources) +
      ' paras=' +
      JSON.stringify(pa1.paraTexts) +
      ' katex=' +
      pa1.inlineKatexCount +
      ' fresh=' +
      JSON.stringify(String(pa1.freshMarkdown).slice(-90))
  )
  // ①b 两者都发（Typora 真实情形：HTML + 纯文本）
  const pa1b = await pasteRun('math-edit-13b.md', PASTE_HTML_BLOCK, PASTE_TEXT_BLOCK)
  report.check(
    'PA1b ① 剪贴板**同时有 HTML 与纯文本**（Typora 真实情形）→ 结果与只发 HTML 一致：块级公式节点 + 规范序列化',
    pa1b.blockSources.length === 1 &&
      pa1b.blockSources[0] === PASTE_TEX &&
      pa1b.paraTexts.includes('前面一段普通文字。') &&
      pa1b.paraTexts.includes('后面一段普通文字。') &&
      String(pa1b.freshMarkdown).includes('$$\n' + PASTE_TEX + '\n$$'),
    'blocks=' + JSON.stringify(pa1b.blockSources) + ' paras=' + JSON.stringify(pa1b.paraTexts)
  )

  // ② 纯文本剪贴板（`$$…$$` 与其它内容混在一起）—— 这一条改前就是对的，本轮作为回归钉住
  const pa2 = await pasteRun('math-edit-13c.md', null, PASTE_TEXT_BLOCK)
  report.check(
    'PA2 ② 纯文本剪贴板（`$$…$$` 夹在普通段落之间）→ **整块**成公式节点（不是被拆成段落文本 + `\\` 换行）',
    pa2.blockSources.length === 1 &&
      pa2.blockSources[0] === PASTE_TEX &&
      pa2.paraTexts.includes('前面一段普通文字。') &&
      String(pa2.freshMarkdown).includes('$$\n' + PASTE_TEX + '\n$$') &&
      !String(pa2.freshMarkdown).includes('\\\n'),
    'blocks=' +
      JSON.stringify(pa2.blockSources) +
      ' paras=' +
      JSON.stringify(pa2.paraTexts) +
      ' fresh=' +
      JSON.stringify(String(pa2.freshMarkdown).slice(-80))
  )

  // ③ 行内公式从 HTML 粘贴 → 收成 `$…$` 且渲染
  const pa3 = await pasteRun('math-edit-13d.md', PASTE_HTML_INLINE, null)
  report.check(
    'PA3 ③ HTML 剪贴板里的**行内**公式 → 收成 `$…$`（带 mdMath mark）且渲染出 KaTeX，前后文字都在',
    pa3.mathMarkedTexts.includes('$E = mc^2$') &&
      pa3.inlineKatexCount >= 1 &&
      pa3.paraTexts.some((t) => t.includes('前面') && t.includes('后面。')) &&
      String(pa3.freshMarkdown).includes('$E = mc^2$'),
    'marked=' +
      JSON.stringify(pa3.mathMarkedTexts) +
      ' paras=' +
      JSON.stringify(pa3.paraTexts) +
      ' fresh=' +
      JSON.stringify(String(pa3.freshMarkdown).slice(-70))
  )

  // ④ 普通富文本粘贴回归：没有数学时**完全不接管**（结构照旧、没有多余转义反斜杠）
  const RICH_HTML = [
    '<p>带<strong>粗体</strong>的段落。</p>',
    '<ul><li>列表项一</li><li>列表项二</li></ul>',
    '<table><tbody><tr><th>表头</th><td>值</td></tr></tbody></table>'
  ].join('')
  const pa4 = await pasteRun(
    'math-edit-13e.md',
    RICH_HTML,
    '带粗体的段落。\n\n- 列表项一\n- 列表项二'
  )
  report.check(
    'PA4 ④ 普通富文本（粗体 + 列表 + 表格，**没有数学**）粘贴结构照旧：列表与表格都在，且序列化里没有多余的反斜杠转义',
    pa4.docTypes.includes('bulletList') &&
      pa4.docTypes.includes('table') &&
      String(pa4.freshMarkdown).includes('**粗体**') &&
      !String(pa4.freshMarkdown).includes('\\\\'),
    'types=' +
      JSON.stringify(pa4.docTypes) +
      ' fresh=' +
      JSON.stringify(String(pa4.freshMarkdown).slice(-110))
  )

  // ⑤ 撤销：粘贴是**一个**可撤销的步
  const pa5 = await pasteRun('math-edit-13f.md', PASTE_HTML_BLOCK, PASTE_TEXT_BLOCK)
  const pa5Before = String(pa5.freshMarkdown)
  await pressKey(app, 'z', 'KeyZ', 90, 2) // Ctrl+Z
  await sleep(450)
  const pa5Undo = JSON.parse(await app.ev(SRC_SNAPSHOT))
  report.check(
    'PA5 ⑤ 粘贴后一次 `Ctrl+Z` 撤销**整段**（公式节点与前后文字一起消失，回到粘贴前的文档）',
    pa5Before.includes('mathBlock') === false &&
      pa5.blockSources.length === 1 &&
      pa5Undo.blockSources.length === 0 &&
      !String(pa5Undo.freshMarkdown).includes('普通文字'),
    'afterPasteBlocks=' +
      JSON.stringify(pa5.blockSources) +
      ' afterUndoBlocks=' +
      JSON.stringify(pa5Undo.blockSources) +
      ' afterUndo=' +
      JSON.stringify(String(pa5Undo.freshMarkdown).slice(-60))
  )

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
