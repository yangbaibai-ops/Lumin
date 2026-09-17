'use strict'
// ─── 颜色关系的共享原语（CDP 套件用）─────────────────────────────────────────
//
// 为什么套件里一律量**关系**、不量绝对值：主题令牌迟早要调（「写作区改成近白」这一轮就是），
// 而钉死 `rgb(245, 246, 248)` 这类绝对色的断言守的是**实现细节** —— 每次调令牌都要红一片，
// 于是没人再敢动主题。真正要守的是意图：
//
//   · 纸比外壳（chrome）亮一档       —— 否则侧栏与正文糊成一片
//   · 代码块 / 表头 / 引用色条 与纸不同 —— 否则在白纸上像掉了块
//   · 正文对纸的 WCAG 对比度达标      —— 这是可读性的硬底线
//
// 这些都是「两个颜色之间的关系」，用本文件的 `contrast()` / `deltaL()` 现算即可。
//
// 计算样式里的颜色字符串有好几种写法，都要认：
//   rgb(252, 252, 251) / rgba(0, 0, 0, 0) / color(srgb 0.988 0.988 0.984)   ← color-mix 的产物
//   / color(srgb 0.35 0.36 0.38 / 0.07)                                     ← 带 alpha 的 color-mix
// 带 alpha 的色**不能**直接比：先 `over(前景, 底色)` 合到实际底色上（合完是不透明的）。

/** 解析成 { r, g, b, a }（0–255 / 0–1）；认不出来返回 null */
function parseColor(input) {
  if (input && typeof input === 'object' && 'r' in input) return { a: 1, ...input }
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  let m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (m) {
    const p = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number)
    if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  // color(srgb r g b [/ a])：分量是 0–1 的 sRGB 浮点
  m = /^color\(srgb\s+([^)]+)\)$/.exec(s)
  if (m) {
    const p = m[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number)
    if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null
    return {
      r: p[0] * 255,
      g: p[1] * 255,
      b: p[2] * 255,
      a: p.length > 3 ? p[3] : 1
    }
  }
  m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1
    }
  }
  return null
}

/** 把 fg 叠到 bg 上（fg 可带 alpha），返回不透明色 */
function over(fg, bg) {
  const f = parseColor(fg)
  const b = parseColor(bg)
  if (!f || !b) throw new Error(`over() 认不出的颜色：${fg} / ${bg}`)
  const a = f.a === undefined ? 1 : f.a
  return {
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
    a: 1
  }
}

/** WCAG 相对亮度（0–1） */
function luminance(c) {
  const col = parseColor(c)
  if (!col) throw new Error(`luminance() 认不出的颜色：${c}`)
  const [r, g, b] = [col.r, col.g, col.b].map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG 对比度（≥1）。两个色都可带 alpha：前景按 alpha 合到背景上，背景再合到白底上。
 * 需要「合到别的底」时先自己 `over()` 再传进来。
 */
function contrast(a, b) {
  const bg = over(b, '#ffffff')
  const fg = over(a, bg)
  const [x, y] = [luminance(fg), luminance(bg)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** 亮度差（0–1）：比对比度更贴近「两块大面并排时看不看得出差别」 */
function deltaL(a, b) {
  return Math.abs(luminance(a) - luminance(b))
}

/**
 * 两个颜色是不是「同一个」（容差 1/255 + alpha 容差 0.02）。
 * 用途：断言「某个面铺的就是某某令牌」——计算样式可能把 `#fcfcfb` 回成
 * `color(srgb 0.988 …)` 或 `rgb(252, 252, 251)`，逐字符比会假红。
 */
function sameColor(a, b) {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return false
  const near = (p, q) => Math.abs(p - q) <= 1
  const ax = x.a === undefined ? 1 : x.a
  const ay = y.a === undefined ? 1 : y.a
  return near(x.r, y.r) && near(x.g, y.g) && near(x.b, y.b) && Math.abs(ax - ay) < 0.02
}

/** `rgb(r, g, b)` 文本，便于把量到的数字写进报告 */
function rgbText(c) {
  const col = parseColor(c)
  if (!col) return String(c)
  const n = (v) => Math.round(v)
  return col.a === 1
    ? `rgb(${n(col.r)}, ${n(col.g)}, ${n(col.b)})`
    : `rgba(${n(col.r)}, ${n(col.g)}, ${n(col.b)}, ${col.a})`
}

const rat = (n) => Number(n.toFixed(3))

/** 页面侧的取值表达式（各套件共用，避免同一个探针各写一份又各自漂移） */
const SURFACE_PROBE = `JSON.stringify((() => {
  const token = (name) => {
    const p = document.createElement('span')
    p.style.color = 'var(' + name + ')'
    document.body.appendChild(p)
    const v = getComputedStyle(p).color
    p.remove()
    return v
  }
  const alphaOf = (s) => {
    const str = String(s).trim()
    let m = /^rgba?[(]([^)]*)[)]$/.exec(str)
    if (m) {
      const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
      return parts.length > 3 ? parts[3] : 1
    }
    m = /^color\\(srgb\\s+([^)]*)\\)$/.exec(str)
    if (m) {
      const parts = m[1].split(/[\\s/]+/).filter(Boolean).map(Number)
      return parts.length > 3 ? parts[3] : 1
    }
    return 0
  }
  /** 写作区 pane 的纸：元素自己是透明的，往上找第一层真刷了底色的祖先 */
  const painted = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor
      if (alphaOf(bg) > 0.01) {
        const cls = typeof n.className === 'string' ? n.className.slice(0, 48) : n.tagName.toLowerCase()
        return { bg, from: cls }
      }
    }
    return { bg: 'rgba(0, 0, 0, 0)', from: null }
  }
  const one = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { exists: false }
    const s = getComputedStyle(el)
    return {
      exists: true,
      bg: s.backgroundColor,
      color: s.color,
      borderLeftColor: s.borderLeftColor,
      borderLeftWidth: parseFloat(s.borderLeftWidth) || 0,
      borderColor: s.borderTopColor
    }
  }
  const preview = document.querySelector('.md-preview')
  const ta = document.querySelector('textarea.source-editor')
  // 注意：这里 return 的是**对象**（不是 JSON 字符串）——外层已经 JSON.stringify 了一次，
  // 里面再 stringify 就成了双重编码，套件 readJson 解出来是个字符串（踩过）。
  return {
    theme: [...document.documentElement.classList].find((c) => c.startsWith('theme-')) || null,
    tokens: {
      paper: token('--paper'), app: token('--app'), panel: token('--panel'),
      panel2: token('--panel-2'), codeBg: token('--code-bg'), edge: token('--edge'),
      edgeStrong: token('--edge-strong'), ink: token('--ink'), ink2: token('--ink-2'),
      ink3: token('--ink-3'), sel: token('--sel'), accentSoft: token('--accent-soft')
    },
    body: getComputedStyle(document.body).backgroundColor,
    pane: preview ? painted(preview) : null,
    sourcePane: ta ? painted(ta) : null,
    surfaces: {
      editorRoot: one('.editor-content .ProseMirror'),
      codeBlock: one('.md-preview .code-block-wrapper'),
      codeBlockHeader: one('.md-preview .code-block-header'),
      inlineCode: one('.md-preview p code'),
      quote: one('.md-preview blockquote'),
      frontmatter: one('.md-preview pre[data-md-frontmatter]'),
      thead: one('.md-preview thead'),
      th: one('.md-preview th'),
      hr: one('.md-preview hr'),
      mathBlock: one('.md-preview .md-math-block'),
      katex: one('.md-preview .katex')
    }
  }
})())`

module.exports = {
  parseColor,
  over,
  luminance,
  contrast,
  deltaL,
  sameColor,
  rgbText,
  rat,
  SURFACE_PROBE
}
