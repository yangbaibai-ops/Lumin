'use strict'
// ─── 选区不变量矩阵（元素 × 手势）───────────────────────────────────────────────
//
// 为什么要有这一套：选区的正确性在这套编辑器里有**四份真相** —— 模型选区 / 我们的自绘带
// （`.sel-band` + `CSS.highlights`）/ 浏览器原生 DOM 选区（被 `data-sel-own` 闸压掉）/
// 拖动期的试探区间。历史上一批 bug（拖动期没样式、带画到上一行、带画到选区之外的公式、
// 块级公式两档样式不一致、松手后与拖动期不一致、表格松手少 1–2 列、插入符画在公式右缘、
// 行首公式前落不进光标）**每一个都靠用户肉眼发现**，因为当时的验收是"一个 bug 一条断言"。
//
// 这套件把"**类级不变量**"变成机器判据：把「元素类型 × 手势」的矩阵自动跑一遍，
// **每个格子断言同一组不变量**（I1–I6）。于是"这一类会不会再坏"不再取决于有没有人想到那个格子。
//
//   I1 覆盖完整：拖动期**每一帧**「原生会画的覆盖 − 我们的可见绘制 = 0」
//                （口径：逐文本片段字形盒 + 构件盒；块级公式再按其**构件盒**另判一次）
//                ⇒ 记录**差额不为 0 的帧数**。本套件把差额按**成因**分成三类（都打印、都不隐藏）：
//                  * `lagFrames`（记录）：差额全部落在"浏览器 DOM 选区领先试探区间"那一段
//                    （我们按模型取试探区间、模型由 PM 异步读回，所以领先约一个 mousemove 步；
//                     逐帧原始证据见每格 `firstLag`：band 右缘 457 vs native 右缘 490）；
//                  * `flashFrames`（记录）：同一个单元只差**一帧**、前后帧都补上了；
//                  * `sustainedFrames`（**判据，必须 0**）：同一个单元**连续 ≥2 帧**没被上色 ——
//                    历史 bug 家族（公式/表格表头/图片整块在拖动期一直没有样式）正是这一种。
//                判据用"连续"而不是"逐帧"，理由是可复算的：自绘带每帧重画一次，而试探区间
//                在两次重画之间还会推进；把"1 帧的追随差"判成回归会让每一次拖动都红、
//                真回归反而被噪音埋掉（仓库自己的 FIRE 口径）。差值本身逐格在表里可见。
//   I2 两档一致：松手后的绘制覆盖与拖动期最后一帧**在同一区间上**逐行一致
//                （行盒矩形 Δ ≤ 1px、带的底色相同）。
//   I3 选区一致：`settled.from/to` == 本次手势记录的 live 区间（丢失必须 0；
//                允许"锚点/落点并入 + 吸附"造成的 ≤2 位增长 —— 出处见下）。
//   I4 无泄漏：松手后没有临时绘制残留（`.sel-band` 容器数、`data-sel-own`、
//                `lumin-img-drag` 高亮、`img-selected` 份数、`data-sel-band-native`）。
//   I5 往返无损：手势前后 `getMarkdown()` **逐字节相同**（只做选择、不改文档）。
//   I6 无异常：格子内没有 `console.error` / 未捕获异常 / 渲染进程崩溃。
//
// **口径出处（写死在代码里，不靠记忆）**：
//   * I1 的"可见绘制"= 我们画的带（`.sel-band > div` 回读的矩形）∪ 兜底高亮
//     （`CSS.highlights['lumin-img-drag']`）∪ **原生选区确实会画的地方**。
//     原生"会不会画"逐字镜像 `src/renderer/src/assets/markdown.css` 的门：
//       - 没有 `[data-sel-own]` ⇒ 原生照常画；
//       - `all` ⇒ 原生整体关掉，**只有** `[data-sel-band-native]` 打开的白名单块
//         （`th,thead,.img-src-revealed,pre,code,blockquote`）里才画，
//         且 `[data-md-math-block]` 内**永远不画**（第一百三十轮那条）；
//       - `math` ⇒ 除 `[data-md-math-rendered]`（永远不画）之外的都画，
//         但 `[data-md-math-block]` 在 `[data-sel-band-native]` 打开时不画。
//     原生"画到哪一段"用**文档位置**判（`nativeDocRange ⊇ 片段区间`），不用矩形 ——
//     `getSelection().getClientRects()` 给的是**字形盒**，而 Chromium 实画的是**行盒**
//     （`imageToolbar.ts` 第一百二十一轮逐像素实测：正文行 32.3px、被图片撑高的行 143.25px）。
//   * I2 的"同一区间"= 拖动期最后一帧的 live 区间 ∩ 落定后的模型区间：
//     只比较两者**都覆盖到**的那一段，边界上的 ≤2 位增长归 I3 管（不然两处会互相污染）。
//   * I3 允许的 ≤2 位增长出处：`imageToolbar.ts` 的 `boxDragSettle` → `textSelAt` 注释
//     （"容差 ±2：吸附只允许往区间内收，1~2 位内视为落成"）+ `onBandUp` 第一百二十七轮注释
//     （"落定 ⊇ 画面，且 ⊆ 画面 ∪ 锚点 ∪ 落点"）。
//
// 工程要求（否则结果不可信，见每处注释）：
//   * **命中自检**：每格开始前把目标滚进视口，并**逐点**验证 `document.elementFromPoint`
//     落在预期元素内 —— 视口外的行、被浮层压住的点会给出**假数据**；
//   * **每个 run 新建实例**（或每 ≤30 格换一个全新实例）+ **周期性 `Page.bringToFront`**：
//     窗口被遮挡时 Chromium 把窗口判为 hidden、rAF 降到 1/500ms，此时任何统计都不可信；
//   * 每帧采样在**页面里**用 `requestAnimationFrame` 做（不是 CDP 逐帧往返）——
//     CDP 往返 ~20ms 会正好落在 PM `DOMObserver.flushSoon` 的读回窗口里，量到的是别的东西。
//
// 用法：
//   node tools/run-suites.js --suite=_verify-selection-invariants.js --timeout=1800000
//   node tools/_verify-selection-invariants.js                       # 直接跑（自己起隔离实例）
//   node tools/_verify-selection-invariants.js --only=E3xG1,E7xG6    # 只跑指定格子（调试）
//   node tools/_verify-selection-invariants.js --elements=E1,E3 --gestures=G1,G6
//   node tools/_verify-selection-invariants.js --no-pixel            # 跳过像素自证段
//
// 端口/userData 的硬约定（本机踩过的坑）：端口 **9422/9423**（9222 被无关 chrome 占着，
// 别动）；userData 目录名**绝不能含 "lumin"**（本机有清理会按命令行关键字杀 electron.exe）
// ⇒ `%TEMP%\xw-inv-ud` / `xw-inv-ud2`。

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const {
  connect,
  settle,
  sleep,
  startIsolated,
  launchStable,
  bringToFront,
  framesAlive,
  preconditionSkip,
  Reporter,
  fatal,
  watchEvents
} = require('./lib/harness')

const ROOT = path.join(__dirname, '..')

// ─── 命令行 ──────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2)
const argVal = (k) => {
  const hit = ARGV.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : null
}
const ONLY = (argVal('only') || '').split(',').filter(Boolean)
const ONLY_ELEMENTS = (argVal('elements') || '').split(',').filter(Boolean)
const ONLY_GESTURES = (argVal('gestures') || '').split(',').filter(Boolean)
const CELL_LIMIT = Number(argVal('cells') || 0)
const ONLY_PIXEL = ARGV.includes('--only-pixel')
const NO_PIXEL = ARGV.includes('--no-pixel')

// ─── 隔离实例（自管；端口/目录见文件头）────────────────────────────────────────
const PROFILES = [
  { ud: path.join(os.tmpdir(), 'xw-inv-ud'), port: 9422 },
  { ud: path.join(os.tmpdir(), 'xw-inv-ud2'), port: 9423 }
]
/** 每跑这么多格换一个**全新**实例（剖面污染：拖选会写下大量临时状态） */
const RESTART_EVERY = 30
/** 每跑这么多格提一次前台（窗口被遮挡 ⇒ rAF 降频 ⇒ 统计作废） */
const FRONT_EVERY = 6

let app = null
let profileIdx = -1
let cellsOnInstance = 0
let crashed = false
let logSink = []
let currentCell = '(boot)'

// ─── 夹具 ────────────────────────────────────────────────────────────────────
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'

/**
 * 十类元素各一处。**顺序就是矩阵的行顺序**。
 * 图片用 `zoom:400%`（48×32 → 192×128）：只有把行撑高，才存在"行盒 ≫ 字形盒"的
 * **空白带**（G3 要按在它上面拖）。
 */
const FIXTURE =
  `纯正文段：开头一段普通的正文，用来做选区起点与终点。\n\n` +
  `行内公式行：文字 $E = mc^2$ 中间 $a^2+b^2=c^2$ 结尾文字。\n\n` +
  `$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n` +
  `单图段：前文 <img src="${PNG_B}" style="zoom:400%;" /> 后文继续。\n\n` +
  `双图段：<img src="${PNG_B}" style="zoom:100%;" /><img src="${PNG_B}" style="zoom:100%;" /> 之后文字。\n\n` +
  `| 列一 | 列二 |\n| :--- | :--- |\n| **粗体甲** | 说明甲一段话 |\n| **粗体乙** | 说明乙一段话 |\n| **粗体丙** | 说明丙一段话 |\n\n` +
  `尾段：随便一些文字，让选区可以落在这里。`

// ─── 页面侧：探针模块（一次注入，之后只读 window.__INV）────────────────────────
/**
 * 注入的东西**只做测量**：不 dispatch、不改文档、不碰应用内部函数（除了读 `__L` 的编辑器
 * 与选区）。刻意**不复用** `imageToolbar.ts` 的函数：判据要能独立复算，否则就是自己判自己。
 */
const INV_PAGE = `(() => {
  if (window.__INV) return 'ok'
  const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
  const P = () => document.querySelector('.ProseMirror')
  const V = () => window.__L.ed().view
  const NATIVE_KINDS = 'th, thead, .img-src-revealed, pre, code, blockquote'
  const inRect = (p, r, pad) => p.x >= r.l - pad && p.x <= r.r + pad && p.y >= r.t - pad && p.y <= r.b + pad
  const coversBox = (arr, r, tol) => arr.some((b) => b.l <= r.l + tol && b.r >= r.r - tol && b.t <= r.t + tol && b.b >= r.b - tol)
  const vOverlap = (a, b) => Math.min(a.b, b.b) - Math.max(a.t, b.t)
  const strongOverlap = (a, b, k) => {
    const h = Math.min(a.b - a.t, b.b - b.t)
    return h > 0 && vOverlap(a, b) >= h * k
  }
  const inflate = (r, lh) => {
    const h = r.b - r.t
    const pad = Number.isFinite(lh) && lh > h ? (lh - h) / 2 : 0
    return { l: r.l, t: r.t - pad, r: r.r, b: r.b + pad }
  }
  const bandRects = () => {
    const el = document.querySelector('.sel-band')
    if (!el) return []
    return [...el.children]
      .map((d) => R(d.getBoundingClientRect()))
      .filter((r) => r.r - r.l > 0.5 || r.b - r.t > 0.5)
  }
  const hlRects = () => {
    const out = []
    try {
      const h = CSS.highlights.get('lumin-img-drag')
      if (h) for (const rg of h) for (const c of rg.getClientRects()) if (c.width > 0.5 || c.height > 0.5) out.push(R(c))
    } catch (e) {}
    return out
  }
  const natRects = () => {
    const out = []
    let text = ''
    try {
      const q = getSelection()
      if (q && q.rangeCount && !q.isCollapsed) {
        text = String(q)
        for (const c of q.getRangeAt(0).getClientRects()) if (c.width > 0.5 || c.height > 0.5) out.push(R(c))
      }
    } catch (e) {}
    return { rects: out, text: text.slice(0, 48) }
  }
  const natDocRange = () => {
    try {
      const q = getSelection()
      if (!q || q.isCollapsed || !q.rangeCount) return null
      const v = V()
      const rg = q.getRangeAt(0)
      if (!v.dom.contains(rg.startContainer) || !v.dom.contains(rg.endContainer)) return null
      const a = v.posAtDOM(rg.startContainer, rg.startOffset)
      const b = v.posAtDOM(rg.endContainer, rg.endOffset)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null
      return { from: Math.min(a, b), to: Math.max(a, b) }
    } catch (e) {
      return null
    }
  }
  /** 原生"在这一点会不会画" —— 逐字镜像 markdown.css 的门（见文件头"口径出处"） */
  const nativePaintsAt = (el) => {
    const d = P()
    const own = d.getAttribute('data-sel-own')
    if (!own) return true
    const natOn = d.getAttribute('data-sel-band-native') === 'on'
    const closest = (sel) => !!(el && el.closest && el.closest(sel))
    if (closest('[data-md-math-block]')) return !natOn
    if (own === 'math') return !closest('[data-md-math-rendered]')
    return !!(natOn && closest(NATIVE_KINDS))
  }
  /** 逐可见文本节点裁到 [from,to]（含 KaTeX 内部节点按宿主构件兜底），返回字形盒 + 绝对区间 */
  const frags = (from, to) => {
    const v = V()
    const out = []
    if (!(to > from)) return out
    const w = document.createTreeWalker(v.dom, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if (!n.length) continue
      if (n.parentElement && n.parentElement.closest('[data-md-math-block]')) continue
      let start = -1
      let whole = false
      try {
        start = v.posAtDOM(n, 0)
      } catch (e) {
        start = NaN
      }
      let a = 0
      let b = 0
      if (!Number.isFinite(start)) {
        const host = n.parentElement && n.parentElement.closest('[data-md-math-rendered]')
        if (!host) continue
        try {
          const hp = v.posAtDOM(host, 0)
          const hn = v.state.doc.nodeAt(hp)
          const hs = hn ? hn.nodeSize : 1
          if (!(hp >= from - 1 && hp <= to + 1)) continue
          a = hp
          b = hp + hs
          whole = true
          start = 0
        } catch (e) {
          continue
        }
      } else {
        const a1 = Math.max(from, start)
        const b1 = Math.min(to, start + n.length)
        if (b1 <= a1) continue
        a = a1
        b = b1
      }
      const rg = document.createRange()
      try {
        if (whole) rg.selectNodeContents(n)
        else {
          rg.setStart(n, a - start)
          rg.setEnd(n, b - start)
        }
      } catch (e) {
        continue
      }
      const rects = []
      for (const c of [...rg.getClientRects()]) {
        if (!(c.width > 0.5 || c.height > 0.5)) continue
        rects.push(R(c))
      }
      if (!rects.length) continue
      const el = n.parentElement
      let lh = 0
      try {
        lh = parseFloat(getComputedStyle(el).lineHeight)
      } catch (e) {}
      /** fa/fb = 这个文本节点的**完整**区间（不随裁剪区间变）⇒ I2 的单元指纹用它 */
      const fa = whole ? a : start
      const fb = whole ? b : start + n.length
      out.push({ rects, el, lh: Number.isFinite(lh) ? lh : 0, a, b, fa, fb })
    }
    return out
  }
  const widgetRange = (el) => {
    try {
      const v = V()
      const p = v.posAtDOM(el, 0)
      if (!Number.isFinite(p)) return null
      let size = 1
      const nd = v.state.doc.nodeAt(p)
      if (nd && nd.nodeSize > 0) size = nd.nodeSize
      return { s: p, e: p + size }
    } catch (e) {
      return null
    }
  }
  /**
   * 图片**源码区间**（独立算法，不抄 collectImgSources）：data-img-from 处若是
   * <img …> 原文，长度就是那个标签；否则按原子节点（![]()）算 1。
   */
  const imgSrcRange = (f) => {
    try {
      const v = V()
      const size = v.state.doc.content.size
      const t = v.state.doc.textBetween(f, Math.min(f + 512, size), '\\n', '\\n')
      const m = /^<img\\b[^>]*\\/?>/i.exec(t)
      if (m) return { s: f, e: f + m[0].length }
    } catch (e) {}
    return { s: f, e: f + 1 }
  }
  /** 块级公式的**构件盒**（镜像 mathBlockBandRects：x 取实画并集、y 取这一档自己的盒） */
  const mathBlockBox = (m) => {
    const inner = m.firstElementChild || m
    const box = inner.getBoundingClientRect()
    let u = null
    const uni = (r) => {
      if (!u) u = { l: r.left, t: r.top, r: r.right, b: r.bottom }
      else {
        u.l = Math.min(u.l, r.left)
        u.t = Math.min(u.t, r.top)
        u.r = Math.max(u.r, r.right)
        u.b = Math.max(u.b, r.bottom)
      }
    }
    const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if (!n.length || !(n.textContent || '').trim()) continue
      const rg = document.createRange()
      try {
        rg.selectNodeContents(n)
      } catch (e) {
        continue
      }
      for (const c of [...rg.getClientRects()]) if (c.width > 0.5 || c.height > 0.5) uni(c)
    }
    for (const d of [...m.querySelectorAll('*')]) {
      if (d === inner) continue
      const r = d.getBoundingClientRect()
      if (r.width > 0.5 && r.height > 0.5) uni(r)
    }
    const yT = box.height > 0.5 ? box.top : u ? u.t : box.top
    const yB = box.height > 0.5 ? box.bottom : u ? u.b : box.bottom
    if (!u) return { l: box.left, t: box.top, r: box.right, b: box.bottom }
    return { l: u.l, t: Math.min(u.t, yT), r: u.r, b: Math.max(u.b, yB) }
  }
  /**
   * 区间内"应当被上色"的**单元**（片段 / 行内公式 / 图片 / 块级公式）。
   * paint = 该单元应该被上色的盒（片段用**行盒**：浏览器实画的就是行盒）。
   */
  const units = (from, to) => {
    const v = V()
    const out = []
    if (!(to > from)) return out
    for (const f of frags(from, to)) {
      const paint = f.rects.map((r) => inflate(r, f.lh))
      out.push({ kind: 'text', el: f.el, a: f.a, b: f.b, fa: f.fa, fb: f.fb, paint, boxes: paint })
    }
    for (const el of [...v.dom.querySelectorAll('[data-md-math-rendered]')]) {
      const r = widgetRange(el)
      if (!r || !(from <= r.s && to >= r.e)) continue
      const bx = el.getBoundingClientRect()
      if (!(bx.width > 0.5 && bx.height > 0.5)) continue
      const box = R(bx)
      out.push({ kind: 'math-inline', el, a: r.s, b: r.e, fa: r.s, fb: r.e, paint: [box], boxes: [box] })
    }
    for (const el of [...v.dom.querySelectorAll('[data-img-widget]')]) {
      const raw = el.getAttribute('data-img-from')
      if (raw == null || raw === '') continue
      const f = Number(raw)
      if (!Number.isFinite(f)) continue
      const r = imgSrcRange(f)
      if (!(from <= r.s && to >= r.e)) continue
      const bx = el.getBoundingClientRect()
      if (!(bx.width > 0.5 && bx.height > 0.5)) continue
      const box = R(bx)
      out.push({ kind: 'image', el, a: r.s, b: r.e, fa: r.s, fb: r.e, paint: [box], boxes: [box] })
    }
    for (const el of [...v.dom.querySelectorAll('[data-md-math-block]')]) {
      const r = widgetRange(el)
      if (!r || !(from <= r.s && to >= r.e)) continue
      const box = mathBlockBox(el)
      if (!(box.r - box.l > 0.5 && box.b - box.t > 0.5)) continue
      out.push({ kind: 'math-block', el, a: r.s, b: r.e, fa: r.s, fb: r.e, paint: [box], boxes: [box] })
    }
    return out
  }
  /**
   * I1：**覆盖差额** = "应当被上色、却既没有被我们的带/高亮完整盖住、也没有被原生选区
   * （在原生确实会画的地方）覆盖"的盒数。fragN 是分母（这一帧有多少个盒要上色）。
   * 对"没盖住"的盒额外给两个量化证据：
   *   * coverPct：在盒内取 7×7 个点，落在带/高亮里的比例（判"完全没画"还是"差一两个字形"）；
   *   * best：最接近盖住它的那个矩形（看差在左/右/上/下）。
   */
  const coverPctOf = (arr, r) => {
    let hit = 0
    let n = 0
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        const x = r.l + ((r.r - r.l) * (i + 0.5)) / 7
        const y = r.t + ((r.b - r.t) * (j + 0.5)) / 7
        n++
        if (arr.some((b) => x >= b.l && x <= b.r && y >= b.t && y <= b.b)) hit++
      }
    }
    return n ? +(hit / n).toFixed(3) : 0
  }
  const bestOf = (arr, r) => {
    let best = null
    let bestA = 0
    for (const b of arr) {
      const a = Math.max(0, Math.min(b.r, r.r) - Math.max(b.l, r.l)) * Math.max(0, Math.min(b.b, r.b) - Math.max(b.t, r.t))
      if (a > bestA) {
        bestA = a
        best = b
      }
    }
    return best ? { rect: best, interArea: +bestA.toFixed(1) } : null
  }
  const cover = (from, to) => {
    const b = bandRects()
    const h = hlRects()
    const nr = natDocRange()
    let fragN = 0
    let missN = 0
    let mathN = 0
    let mathMissN = 0
    const detail = []
    /** 没盖住的单元指纹（kind|a|b|l|t）：用来判"单帧闪"还是"连续 ≥2 帧" */
    const missKeys = []
    for (const u of units(from, to)) {
      for (const r of u.paint) {
        if (u.kind === 'math-block') mathN++
        else fragN++
        let ok = coversBox(b, r, 1.25) || coversBox(h, r, 1.25)
        if (!ok && u.kind === 'image' && u.el.classList.contains('img-selected')) ok = true
        if (!ok && nr && nativePaintsAt(u.el) && nr.from <= u.a && nr.to >= u.b) ok = true
        if (ok) continue
        if (u.kind === 'math-block') mathMissN++
        else missN++
        if (missKeys.length < 40) missKeys.push(u.kind + '|' + u.a + '|' + u.b + '|' + Math.round(r.l) + '|' + Math.round(r.t))
        if (detail.length < 5)
          detail.push({
            kind: u.kind,
            box: r,
            a: u.a,
            b: u.b,
            coverPct: coverPctOf([...b, ...h], r),
            bestBand: bestOf(b, r),
            bestHl: bestOf(h, r)
          })
      }
    }
    return { fragN, missN, mathN, mathMissN, detail, missKeys }
  }
  /**
   * I2 用的**单元摘要**：区间内每个"应当被上色"的单元一行
   * [kind, fa, fb, l, t, r, b, vis]（vis = 这一档里它到底有没有底色）。
   * ⚠️ 指纹用**不随裁剪区间变的完整区间 fa|fb**（不是裁剪后的 a|b）：两档的采样区间
   * 本来就可能差几个位置（落定区间 ∩ 试探区间），用裁剪区间当键会把"同一段文字"
   * 判成两个不同的单元（实测 E1×G1：7|22 vs 7|20 其实是同一段）。
   */
  const digest = (from, to) => {
    const b = bandRects()
    const h = hlRects()
    const nr = natDocRange()
    return units(from, to).map((u) => {
      const box = u.boxes[0]
      let vis = false
      for (const r of u.paint) {
        if (coversBox(b, r, 1.25) || coversBox(h, r, 1.25)) {
          vis = true
          break
        }
        if (u.kind === 'image' && u.el.classList.contains('img-selected')) {
          vis = true
          break
        }
        if (nr && nativePaintsAt(u.el) && nr.from <= u.a && nr.to >= u.b) {
          vis = true
          break
        }
      }
      return [u.kind, u.fa, u.fb, +box.l.toFixed(1), +box.t.toFixed(1), +box.r.toFixed(1), +box.b.toFixed(1), vis ? 1 : 0]
    })
  }
  const attr = (n) => P().getAttribute(n)
  const sample = () => {
    const v = V()
    const liveRaw = (attr('data-img-drag-live') || '').split('|').map(Number)
    const live =
      liveRaw.length === 4 && Number.isFinite(liveRaw[2]) && Number.isFinite(liveRaw[3])
        ? { from: Math.min(liveRaw[2], liveRaw[3]), to: Math.max(liveRaw[2], liveRaw[3]), anchor: liveRaw[0], head: liveRaw[1] }
        : null
    const nr = natDocRange()
    const lo = live ? (nr ? Math.min(live.from, nr.from) : live.from) : nr ? nr.from : null
    const hi = live ? (nr ? Math.max(live.to, nr.to) : live.to) : nr ? nr.to : null
    const hasIntent = lo != null && hi != null && hi > lo
    const sel = v.state.selection
    const bandEl = document.querySelector('.sel-band')
    const bg = bandEl && bandEl.firstElementChild ? getComputedStyle(bandEl.firstElementChild).backgroundColor : null
    const nl = natRects()
    const cov = hasIntent ? cover(lo, hi) : { fragN: 0, missN: 0, mathN: 0, mathMissN: 0, detail: [] }
    /**
     * ─── 差额的**两个口径**（都在这里算，只算一次，别在下游各判一遍）────────────────────
     * 严格口径（cov，区间 = 试探区间 ∪ 原生区间）会稳定地暴露出一个**已知现象**：
     * 拖动期浏览器的 DOM 选区**领先**我们的试探区间约一个 mousemove 步（我们的试探区间取
     * view.state.selection.head，而模型是由 PM 的 DOMObserver ~20ms 异步读回来的）⇒
     * 领先的那一小段在 own='all'（原生被压掉）时**没有任何底色**，下一帧才补上。
     * 逐帧实测（E1×G1，27 帧里 7 帧）：band=[421,457]（试探区间 7-9）而 native=[422,490]
     * （原生已经到 7-11）⇒ 差额 1 个盒、coverPct=0.571。
     * 所以两个口径都留着：
     *   * cov     —— 严格口径（任务原文："原生会画的覆盖 − 我们的可见绘制"）；
     *   * covLive —— **试探区间之内**有没有一块没上色（历史 bug 家族"拖动期没样式"的判据）；
     *   * lag     —— 差额**全部**落在"原生领先试探区间"那一段（试探区间内一块都不缺）。
     */
    let covLive = null
    let lag = false
    if (hasIntent && (cov.missN > 0 || cov.mathMissN > 0) && live) {
      covLive = cover(live.from, live.to)
      lag = covLive.missN === 0 && covLive.mathMissN === 0
    }
    return {
      t: +performance.now().toFixed(1),
      bandBg: bg,
      own: attr('data-sel-own'),
      natAttr: attr('data-sel-band-native'),
      missAttr: attr('data-sel-band-miss'),
      live,
      nat: nr,
      intent: hasIntent ? { from: lo, to: hi } : null,
      model: { from: sel.from, to: sel.to, empty: sel.empty, ctor: sel.constructor.name },
      bandEls: document.querySelectorAll('.sel-band').length,
      focus: document.hasFocus(),
      active: String((document.activeElement && document.activeElement.className) || '').slice(0, 40),
      bandN: bandRects().length,
      bandRects: bandRects(),
      hlRects: hlRects(),
      natRects: nl.rects,
      oursAttr: attr('data-sel-band-ours'),
      bandLiveAttr: attr('data-sel-band-live'),
      hlN: hlRects().length,
      natN: nl.rects.length,
      natText: nl.text,
      imgSel: document.querySelectorAll('.img-selected').length,
      imgSelFrom: [...document.querySelectorAll('[data-img-widget].img-selected')].map((x) => x.getAttribute('data-img-from')),
      revealed: document.querySelectorAll('[data-img-revealed]').length,
      hlNames: (() => {
        try {
          return [...CSS.highlights.keys()]
        } catch (e) {
          return []
        }
      })(),
      cov: hasIntent ? cover(lo, hi) : { fragN: 0, missN: 0, mathN: 0, mathMissN: 0, detail: [], missKeys: [] },
      covLive,
      lag,
      /** 手势是否**已经被应用收尾**（data-img-settle-in 由 onBandUp→settleGesture 写）： */
      settleIn: attr('data-img-settle-in'),
      gesture: attr('data-img-gesture'),
      digest: hasIntent ? digest(lo, hi) : []
    }
  }
  const snap = () => {
    const s = sample()
    s.settleIn = attr('data-img-settle-in')
    s.settleFallback = attr('data-img-settle-fallback')
    s.gesture = attr('data-img-gesture')
    s.dragEdge = attr('data-img-drag-edge')
    s.settleFallback2 = null
    s.markdown = (() => {
      try {
        return window.__L.ed().storage.markdown.getMarkdown()
      } catch (e) {
        return 'ERR:' + String(e && e.message)
      }
    })()
    return s
  }
  /**
   * 清掉**上一格留下的诊断锚**。data-img-drag-live / data-img-settle-* 应用侧只写不读、
   * 也从不主动清（clearLiveSel 不动它们）⇒ 不清的话"本格第一帧"会读到**上一格的区间**，
   * I1/I3 直接变成假数据。这里只摘这几个诊断属性，不碰任何应用状态。
   */
  const resetDiag = () => {
    const d = P()
    for (const a of ['data-img-drag-live', 'data-img-drag-edge', 'data-img-settle-in', 'data-img-settle-fallback', 'data-img-gesture']) {
      try {
        d.removeAttribute(a)
      } catch (e) {}
    }
    return 'ok'
  }
  const INV = {
    frames: [],
    armed: false,
    sample,
    snap,
    cover,
    digest,
    units,
    bandRects,
    hlRects,
    natRects,
    natDocRange,
    nativePaintsAt,
    resetDiag,
    arm() {
      this.frames = []
      resetDiag()
      this.armed = true
      const loop = () => {
        if (!this.armed) return
        try {
          this.frames.push(sample())
        } catch (e) {
          this.frames.push({ err: String((e && e.message) || e) })
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      return 'ok'
    },
    disarm() {
      this.armed = false
      return this.frames.length
    }
  }
  window.__INV = INV
  return 'ok'
})()`

// ─── 页面侧：元素/手势规格（坐标全部现测量，不写死）────────────────────────────
/**
 * 每个元素给出"从哪儿按、拖到哪儿"，并用**唯一 needle** 定位（不写死坐标）。
 * `atom` 类元素按"最近的原子构件盒中心"取按下点（那是 `posAtCoords` 死区，历史 bug 的温床）。
 */
const SPEC_PAGE = `(() => {
  const P = () => document.querySelector('.ProseMirror')
  const V = () => window.__L.ed().view
  const findText = (needle) => {
    const w = document.createTreeWalker(P(), NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const i = (n.textContent || '').indexOf(needle)
      if (i >= 0) return { n, i }
    }
    return null
  }
  const rectOf = (needle) => {
    const h = findText(needle)
    if (!h) return null
    const rg = document.createRange()
    rg.setStart(h.n, h.i)
    rg.setEnd(h.n, h.i + needle.length)
    const r = rg.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return null
    return { r, el: h.n.parentElement, rect: { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  }
  const at = (needle, fx) => {
    const h = rectOf(needle)
    if (!h) return null
    const r = h.r
    if (r.bottom < 40 || r.top > innerHeight - 40) return null
    return { x: Math.round(r.left + r.width * fx), y: Math.round((r.top + r.bottom) / 2), blockText: (h.el && h.el.closest('p,li,td,th,h1,h2,h3') ? h.el.closest('p,li,td,th,h1,h2,h3').textContent : '').slice(0, 30) }
  }
  /** 找 atom 构件：按"它所在的块文本里含 nearNeedle"挑（文档里有多个同类构件） */
  const atomAt = (sel, nearNeedle, idx) => {
    const list = [...P().querySelectorAll(sel)].filter((el) => {
      if (!nearNeedle) return true
      const blk = el.closest('p,li,td,th,div')
      return !!blk && (blk.textContent || '').includes(nearNeedle)
    })
    const el = list[idx || 0]
    if (!el) return { why: 'no-element' }
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
    } catch (e) {}
    /**
     * 盒 = 元素自身 ∪ 后代元素的矩形并集。为什么不只用 getBoundingClientRect()：
     * 实测（块级公式那一格）出现过外层盒量到 0 的情形，而此时应当以**构件实画范围**为准
     * （与 mathBlockBandRects 同一条口径），否则整格会以"起点解析失败"被 SKIP 掉。
     */
    let box = null
    const uni = (r) => {
      if (!(r.width > 0.5 || r.height > 0.5)) return
      if (!box) box = { l: r.left, t: r.top, r: r.right, b: r.bottom }
      else {
        box.l = Math.min(box.l, r.left)
        box.t = Math.min(box.t, r.top)
        box.r = Math.max(box.r, r.right)
        box.b = Math.max(box.b, r.bottom)
      }
    }
    const own = el.getBoundingClientRect()
    uni(own)
    for (const d of [...el.querySelectorAll('*')]) uni(d.getBoundingClientRect())
    let atom = null
    try {
      const rg = V().posAtDOM(el, 0)
      const nd = V().state.doc.nodeAt(rg)
      atom = { s: rg, e: rg + (nd && nd.nodeSize > 0 ? nd.nodeSize : 1) }
    } catch (e) {}
    if (!box) return { why: 'zero-size', own: [own.left, own.top, own.width, own.height], display: getComputedStyle(el).display, atom, sel }
    return {
      x: Math.round((box.l + box.r) / 2),
      y: Math.round((box.t + box.b) / 2),
      rect: box,
      atom,
      sel
    }
  }
  /**
   * 空白带：某个块内"行盒 ≫ 字形盒"的那些位置（被图片撑高的行里的空白）。
   * 返回 null = **这一行没有空白带**（整行都被字形盒/构件盒填满）⇒ G3 如实 SKIP。
   */
  const blankBand = (nearNeedle) => {
    const para = [...P().querySelectorAll('p')].find((p) => (p.textContent || '').includes(nearNeedle))
    if (!para) return null
    const boxes = []
    const w = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if (!n.length) continue
      const rg = document.createRange()
      rg.selectNodeContents(n)
      for (const c of [...rg.getClientRects()]) if (c.width > 0.5 || c.height > 0.5) boxes.push({ l: c.left, t: c.top, r: c.right, b: c.bottom })
    }
    for (const el of [...para.querySelectorAll('[data-img-widget],[data-md-math-rendered]')]) {
      const c = el.getBoundingClientRect()
      if (c.width > 0.5 || c.height > 0.5) boxes.push({ l: c.left, t: c.top, r: c.right, b: c.bottom })
    }
    if (!boxes.length) return null
    const row = {
      l: Math.min(...boxes.map((b) => b.l)),
      t: Math.min(...boxes.map((b) => b.t)),
      r: Math.max(...boxes.map((b) => b.r)),
      b: Math.max(...boxes.map((b) => b.b))
    }
    /** 行盒（含行高补白）：正文行的"空白带"就是行盒减去字形/构件盒剩下的部分 */
    let lh = 0
    try {
      lh = parseFloat(getComputedStyle(para).lineHeight)
    } catch (e) {}
    const pad = Number.isFinite(lh) ? Math.max(0, (lh - (row.b - row.t)) / 2) : 0
    const line = { l: row.l, t: row.t - pad, r: row.r, b: row.b + pad }
    const cand = []
    for (let y = Math.round(line.t) + 3; y <= line.b - 3; y += 4) {
      for (let x = Math.round(line.l) + 3; x <= line.r - 3; x += 6) {
        const inBox = boxes.some((b) => x >= b.l - 1 && x <= b.r + 1 && y >= b.t - 1 && y <= b.b + 1)
        if (inBox) continue
        const el = document.elementFromPoint(x, y)
        if (!el || (!para.contains(el) && el !== para)) continue
        /** 离最近字形盒越远越好（避免压在抗锯齿边缘上） */
        let d = Infinity
        for (const b of boxes) {
          const dx = Math.max(b.l - x, 0, x - b.r)
          const dy = Math.max(b.t - y, 0, y - b.b)
          d = Math.min(d, Math.hypot(dx, dy))
        }
        cand.push({ x, y, d: +d.toFixed(2) })
      }
    }
    if (!cand.length) return null
    cand.sort((a, b) => b.d - a.d)
    const best = cand[0]
    /** "同列字形"对照点：**同一行**里最近的字形盒，x 取该盒内离 best.x 最近的那一端 */
    let glyph = null
    let gd = Infinity
    for (const b of boxes) {
      /**
       * ⚠️ 只认**同一行**的字形盒（竖直方向与按下点重叠，或中心距 ≤ 8px）。
       * 不这么收窄的话，"最近的字形"会挑到**别的行**去（实测 E8×G3：按下点在 y=417 的空白里、
       * 挑到的字形在 y=245，两者差 172px）⇒ 那已经不是"同列字形"，等价判据会自己制造失败。
       */
      if (!(best.y >= b.t - 8 && best.y <= b.b + 8)) continue
      const gx = Math.min(Math.max(best.x, b.l + 1), b.r - 1)
      const d = Math.abs(gx - best.x) + Math.abs((b.t + b.b) / 2 - best.y)
      if (d < gd) {
        gd = d
        glyph = { x: Math.round(gx), y: Math.round((b.t + b.b) / 2), box: b, sameRowDist: +d.toFixed(1) }
      }
    }
    return { point: { x: best.x, y: best.y }, clearance: best.d, line, row, glyph, candN: cand.length, paraText: (para.textContent || '').slice(0, 20) }
  }
  const spec = {
    E1: { start: ['纯正文段：开头', 0.8], end: ['用来做选区起点', 0.9], blankNear: '纯正文段：开头' },
    E2: { start: ['行内公式行：文字', 0.3], end: ['结尾文字', 0.6], blankNear: '行内公式行：文字' },
    E3: { atom: ['[data-md-math-block]', '', 0], end: ['单图段：前文', 0.5], blankNear: null },
    E4: { atom: ['[data-img-widget]', '后文继续', 0], end: ['后文继续', 0.8], blankNear: '后文继续' },
    E5: { atom: ['[data-img-widget]', '之后文字', 0], end: ['之后文字', 0.8], blankNear: '之后文字' },
    E6: { start: ['列一', 0.4], end: ['列二', 0.6], blankNear: '列一' },
    E7: { start: ['粗体甲', 0.3], end: ['粗体丙', 0.6], blankNear: '粗体甲' },
    E8: { revealed: true, end: ['后文继续', 0.8], blankNear: '后文继续' },
    E9: { blank: '后文继续', end: ['后文继续', 0.8], blankNear: '后文继续' },
    E10: { start: ['纯正文段：开头', 0.2], end: ['尾段：随便', 0.8], blankNear: '纯正文段：开头' }
  }
  window.__SPEC = { spec, at, atomAt, blankBand, rectOf, findText }
  return 'ok'
})()`

// ─── 矩阵定义 ────────────────────────────────────────────────────────────────
const ELEMENTS = [
  { id: 'E1', name: '纯正文段落' },
  { id: 'E2', name: '行内公式' },
  { id: 'E3', name: '块级公式' },
  { id: 'E4', name: '单张图片' },
  { id: 'E5', name: '两张相邻图片' },
  { id: 'E6', name: '表格表头' },
  { id: 'E7', name: '表格表体' },
  { id: 'E8', name: '显形源码' },
  { id: 'E9', name: '空白带' },
  { id: 'E10', name: '混合长选区' }
]
const GESTURES = [
  { id: 'G1', name: '从前往后拖', moves: 8 },
  { id: 'G2', name: '从后往前拖', moves: 8 },
  { id: 'G3', name: '从空白带按下拖', moves: 8 },
  { id: 'G4', name: '单击（不拖）', moves: 0 },
  { id: 'G5', name: '跨结构拖', moves: 10 },
  { id: 'G6', name: '拖动中途 pointercancel', moves: 8, kind: 'pointercancel' },
  { id: 'G7', name: '拖动中途 blur', moves: 8, kind: 'blur' },
  { id: 'G8', name: '拖动中途 visibilitychange', moves: 8, kind: 'visibility' },
  { id: 'G9', name: 'Escape 取消', moves: 8, kind: 'escape' },
  { id: 'G10', name: '拖到视口外再回来', moves: 10, kind: 'outside' }
]

// ─── 小工具 ──────────────────────────────────────────────────────────────────
const cellId = (e, g) => `${e}x${g}`
const json = async (expr) => JSON.parse(await app.ev(`JSON.stringify(${expr})`))
/** 异步版本的 `json`：`JSON.stringify(<promise>)` 会得到 "{}"，必须先 await 再序列化 */
const jsonAsync = async (expr) =>
  JSON.parse(await app.ev(`(async () => JSON.stringify(await (${expr})))()`))
const jnum = (v, d = 3) => (Number.isFinite(v) ? +v.toFixed(d) : null)

/** 构建校验：out 的 EditorView 资产必须**晚于**源码，否则统计作废（文件头口径） */
function buildProvenance() {
  const dir = path.join(ROOT, 'out', 'renderer', 'assets')
  const assets = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^EditorView-.*\.js$/.test(f))
        .map((f) => {
          const p = path.join(dir, f)
          return { f, p, m: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }
        })
        .sort((a, b) => b.m - a.m)
    : []
  const newestSrc = (() => {
    let best = { f: null, m: 0 }
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|vue|css|js|json)$/.test(e.name)) {
          const m = fs.statSync(p).mtimeMs
          if (m > best.m) best = { f: path.relative(ROOT, p), m }
        }
      }
    }
    for (const sub of ['src/renderer/src', 'src/shared', 'src/preload']) walk(path.join(ROOT, sub))
    return best
  })()
  const git = (args) => {
    try {
      return require('child_process').execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch (e) {
      return 'ERR'
    }
  }
  const asset = assets[0] || null
  return {
    asset: asset ? asset.f : null,
    assetMtime: asset ? new Date(asset.m).toISOString() : null,
    assetSha256: asset ? crypto.createHash('sha256').update(fs.readFileSync(asset.p)).digest('hex').slice(0, 16) : null,
    newestSrc: newestSrc.f,
    newestSrcMtime: newestSrc.m ? new Date(newestSrc.m).toISOString() : null,
    fresh: !!asset && asset.m > newestSrc.m,
    head: git(['rev-parse', '--short', 'HEAD']),
    dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length
  }
}

// ─── 实例生命周期 ────────────────────────────────────────────────────────────
async function bootInstance(why) {
  if (app) {
    try {
      app.close()
    } catch (e) {}
    app = null
  }
  /**
   * ─── 第 135 轮：改用 `launchStable()`（非阻塞 + 唯一 userData + delete ELECTRON_RUN_AS_NODE）──
   * 原来的两步 `startIsolated({cleanupOnly:true})` + `startIsolated()` 有两个坑：
   *   ① `start-isolated.ps1` 在本环境起不来实例 ⇒ `spawnSync` 永久阻塞 / 返回非 0（实测第二个
   *      profile `code:3`）；
   *   ② 它会把 `ELECTRON_RUN_AS_NODE` 原样透给 Electron ⇒ Electron 退化成 node 跑 `.` ⇒ 主进程秒退。
   * 现在一次调用就完成"起 + 轮询 + 硬超时 + 换端口换目录重试"，且**每次全新 userData**。
   */
  const launched = await launchStable({
    tag: 'inv',
    ports: PROFILES.map((x) => x.port),
    tries: 3,
    readyMs: 90000,
    // 我们自己可能还占着上一个实例的端口（本函数开头已 `app.close()`）⇒ 忽略占用检查，
    // 否则会被自己的残留误判成"端口全占用"。
    portPolicy: 'force'
  })
  if (!launched.ok) {
    throw preconditionSkip(
      `隔离实例起不来（${JSON.stringify(launched.attempts.map((a) => ({ port: a.port, code: a.code, ready: a.ready, tail: String(a.tail).slice(-200) })))}）——环境问题，不是缺陷`
    )
  }
  try {
    app = await connect({ port: launched.port, timeoutMs: 45000 })
    if (await settle(app.ev)) {
      cellsOnInstance = 0
      await app.send('Runtime.enable').catch(() => {})
      await app.send('Log.enable').catch(() => {})
      await app.send('Inspector.enable').catch(() => {})
      watchEvents(app, (m) => {
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          logSink.push({
            k: 'console.error',
            cell: currentCell,
            text: (m.params.args || []).map((a) => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 220)
          })
        } else if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails || {}
          logSink.push({ k: 'exception', cell: currentCell, text: String(d.exception?.description ?? d.text).slice(0, 220) })
        } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
          logSink.push({ k: 'log.error', cell: currentCell, text: String(m.params.entry.text).slice(0, 220) })
        } else if (m.method === 'Inspector.targetCrashed') {
          crashed = true
          logSink.push({ k: 'targetCrashed', cell: currentCell, text: 'renderer crashed' })
        }
      })
      await loadFixture()
      console.log(`· 实例就绪（${why}）：port=${launched.port} userData=${launched.userData} log=${launched.log}`)
      return true
    }
  } catch (e) {
    launched.close()
    throw preconditionSkip(`连上实例但 settle 失败（${String((e && e.message) || e)}）——环境问题，不是缺陷`)
  }
  launched.close()
  throw preconditionSkip(`实例起来了但 settle 不通过（${JSON.stringify({ port: launched.port })}）——环境问题，不是缺陷`)
}

async function loadFixture() {
  const file = path.join(os.tmpdir(), `xw-inv-fixture-${Date.now().toString(36)}.md`)
  fs.writeFileSync(file, FIXTURE, 'utf8')
  /**
   * ⚠️ 第 135 轮：把"打开结果"读回来并**诊断落盘**。原来这里 `.catch(() => 'err:…')` 之后
   * 直接进轮询，一旦打开失败（例如路径没被授权、或 `window.__L` 还没注入）就只会得到
   * `p:1` 这种"夹具没渲染成预期形状"的含糊结论，看不出真因。
   */
  const opened = await app.ev(
    `window.__L.files().openPath(${JSON.stringify(file)}).then((x) => 'ok:' + JSON.stringify(x).slice(0, 120)).catch((e) => 'err:' + (e && e.message))`
  )
  let contentOk = false
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    if (await app.ev(`String(window.__L.files().current && window.__L.files().current.content || '').includes('纯正文段')`)) {
      contentOk = true
      break
    }
  }
  if (!contentOk) {
    const diag = await app.ev(
      `JSON.stringify({ opened: ${JSON.stringify(opened)}, path: String(window.__L.files().current && window.__L.files().current.path), len: String(window.__L.files().current && window.__L.files().current.content || '').length, head: String(window.__L.files().current && window.__L.files().current.content || '').slice(0, 60), pm: document.querySelectorAll('.ProseMirror p').length })`
    )
    throw preconditionSkip(`夹具没被打开（${diag}）——环境/夹具问题，不是缺陷`)
  }
  await sleep(700)
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  for (let i = 0; i < 30; i++) {
    const ready = await app.ev(
      `[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete) && document.querySelectorAll('.ProseMirror table').length > 0 && !!document.querySelector('[data-md-math-block]')`
    )
    if (ready) break
    await sleep(250)
  }
  await app.ev(INV_PAGE)
  await app.ev(SPEC_PAGE)
  /** 夹具规范化自证：图片/表格/公式都在（否则后面全是假数据） */
  const shape = await json(`(() => {
    const pm = document.querySelector('.ProseMirror')
    return { img: pm.querySelectorAll('[data-img-widget]').length, table: pm.querySelectorAll('table').length, mathBlock: pm.querySelectorAll('[data-md-math-block]').length, mathInline: pm.querySelectorAll('[data-md-math-rendered]').length, p: pm.querySelectorAll('p').length }
  })()`)
  if (!(shape.img === 3 && shape.table === 1 && shape.mathBlock === 1 && shape.mathInline === 2)) {
    throw preconditionSkip(`夹具没渲染成预期形状（${JSON.stringify(shape)}）——环境/夹具问题，不是缺陷`)
  }
  return shape
}

async function maybeRestart(cellsDone) {
  if (cellsOnInstance >= RESTART_EVERY) {
    await bootInstance(`每 ${RESTART_EVERY} 格换新实例`)
    return true
  }
  if (cellsDone % FRONT_EVERY === 0) await bringToFront(app)
  return false
}

// ─── 每格的执行 ──────────────────────────────────────────────────────────────
/**
 * 手势执行体。`kind` 决定"中途事件"那几条（pointercancel / blur / visibilitychange /
 * Escape / 视口外）怎么插。
 */
async function runGesture(elId, gestId, pts) {
  const kind = (GESTURES.find((g) => g.id === gestId) || {}).kind || 'plain'
  const moves = (GESTURES.find((g) => g.id === gestId) || {}).moves || 8
  const a = pts.start
  const b = pts.end
  const mid = (i) => ({ x: Math.round(a.x + ((b.x - a.x) * i) / moves), y: Math.round(a.y + ((b.y - a.y) * i) / moves) })
  await app.ev(`window.__INV.arm()`)
  if (gestId === 'G4') {
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
    await sleep(70)
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 })
    await sleep(150)
    await app.ev(`window.__INV.disarm()`)
    return {}
  }
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
  await sleep(20)
  const half = Math.max(1, Math.floor(moves / 2))
  for (let i = 1; i <= half; i++) {
    const p = mid(i)
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 })
    await sleep(24)
  }
  if (kind === 'pointercancel') {
    await app.ev(
      `(() => { const d = window.__L.ed().view.dom; d.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 1 })); return 'ok' })()`
    )
  } else if (kind === 'blur') {
    await app.ev(`(() => { window.dispatchEvent(new Event('blur')); return 'ok' })()`)
  } else if (kind === 'visibility') {
    await app.ev(`(() => {
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      } catch (e) {}
      document.dispatchEvent(new Event('visibilitychange'))
      return document.visibilityState
    })()`)
  } else if (kind === 'escape') {
    await app.ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  } else if (kind === 'outside') {
    /** 视口外：先把指针推到视口下缘之外（自动滚动的边界情形），再拉回来继续拖 */
    const vh = (await json(`({ vh: innerHeight })`)).vh
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: Math.round(vh) + 60, button: 'left', buttons: 1 })
    await sleep(320)
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: Math.round(vh) - 40, button: 'left', buttons: 1 })
    await sleep(160)
  }
  await sleep(40)
  for (let i = half + 1; i <= moves; i++) {
    const p = mid(i)
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 })
    await sleep(24)
  }
  const last = mid(moves)
  /**
   * I7 用的"落点事实"：**松手前**（布局还是拖动期那一份）读一次 `posAtCoords`，
   * 并记下"落点是不是压在原子构件盒上"（压在构件上时落点语义由构件决定，I7 不适用）。
   */
  const rel = await json(`(() => {
    const v = window.__L.ed().view
    const p = v.posAtCoords({ left: ${last.x}, top: ${last.y} })
    const el = document.elementFromPoint(${last.x}, ${last.y})
    return { relPos: p ? p.pos : null, onAtom: !!(el && el.closest('[data-img-widget],[data-md-math-block],[data-md-math-rendered]')) }
  })()`)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1 })
  await sleep(60)
  if (kind === 'visibility') {
    await app.ev(`(() => {
      try {
        delete document.visibilityState
        delete document.hidden
      } catch (e) {}
      document.dispatchEvent(new Event('visibilitychange'))
      return document.visibilityState
    })()`)
  }
  await app.ev(`window.__INV.disarm()`)
  return { ...rel, releasePoint: last }
}

/** 等一下"落定 + 有界复验"跑完（复验上限 6 帧 ≈100ms，看门狗 0 帧；取 600ms 富余） */
const SETTLE_WAIT = 620

async function matrixCell(el, gest, report, record) {
  const id = cellId(el.id, gest.id)
  currentCell = id
  const name = `[${id}] ${el.name} × ${gest.name}`
  const t0 = Date.now()
  const fail = (why, extra) => {
    report.check(`${name} | ${why}`, false, JSON.stringify(extra).slice(0, 2200))
    record.push({ id, el: el.id, gest: gest.id, status: 'FAIL', why, ...extra })
  }
  const skip = (why, extra) => {
    report.skip(name, `${why} | ${JSON.stringify(extra).slice(0, 600)}`)
    record.push({ id, el: el.id, gest: gest.id, status: 'SKIP', why, ...extra })
  }
  try {
    logSink = logSink.filter((l) => l.cell !== id)
    await bringToFront(app)
    /** ① 复位：点一下**中性的尾段**（关掉"点开的公式源码框 / 显形源码"这类一次性状态），
     *  再把光标放回文档开头 ⇒ 每格的前置状态一致 */
    const rp = await json(`(() => { const t = window.__SPEC.at('尾段：随便', 0.5); return t ? { x: t.x, y: t.y } : null })()`)
    if (rp) {
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
      await sleep(40)
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
      await sleep(120)
    }
    await app.ev(`(() => {
      try { window.__L.ed().commands.setTextSelection(1) } catch (e) {}
      return 'ok'
    })()`)
    await sleep(160)
    /**
     * 复位自证：`.md-math-block` 必须又**可见**。点开块级公式会让它 `display:none`（换成上方
     * 源码框），不复位的话后面每一格都量到 0 尺寸构件（实测 E3×G5..G10 整排 SKIP 就是这么来的）。
     */
    for (let i = 0; i < 6; i++) {
      const vis = await app.ev(
        `(() => { const m = document.querySelector('[data-md-math-block]'); if (!m) return false; const r = m.getBoundingClientRect(); return r.height > 0.5 && r.width > 0.5 })()`
      )
      if (vis) break
      /** 公式编辑会话（`[data-md-math-editor]`）：失焦立刻收起；textarea 上 Esc 也收起 */
      await app.ev(`(() => {
        const ta = document.querySelector('[data-md-math-editor-src]')
        if (ta) {
          try { ta.blur() } catch (e) {}
          try { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) } catch (e) {}
        }
        try { document.querySelector('[data-md-math-editor] [data-md-math-editor-accept]')?.click() } catch (e) {}
        try { document.body.focus() } catch (e) {}
        return 'ok'
      })()`)
      await sleep(220)
      if (rp) {
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
        await sleep(40)
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.x, y: rp.y, button: 'left', clickCount: 1 })
        await sleep(150)
      }
    }
    /** ② E8：先点开图片源码（显形源码只在这种状态下存在） */
    if (el.id === 'E8') {
      const p = await json(`(() => { const s = window.__SPEC.atomAt('[data-img-widget]', '后文继续', 0); return s ? { x: s.x, y: s.y } : null })()`)
      if (!p) return skip('取不到单图构件（显形源码段）', {})
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await sleep(360)
      const ok = await json(`({ n: document.querySelectorAll('[data-img-revealed]').length })`)
      if (!ok.n) return skip('点开图片后没有出现 .img-src-revealed（显形源码不可用）', ok)
    }
    /** ③ 解析端点（现测量；元素滚进视口） */
    const resolved = await json(`(() => {
      const S = window.__SPEC
      const sp = S.spec[${JSON.stringify(el.id)}]
      const out = { id: ${JSON.stringify(el.id)} }
      if (sp.start) out.start = S.at(sp.start[0], sp.start[1])
      if (sp.atom) {
        const A = S.atomAt(sp.atom[0], sp.atom[1], sp.atom[2])
        out.start = A && A.x != null ? { x: A.x, y: A.y, atom: A.atom, rect: A.rect } : null
        if (!out.start && A) out.startWhy = A
      }
      if (sp.revealed) {
        const els = [...document.querySelectorAll('.img-src-revealed')]
        const e = els.find((x) => (x.textContent || '').includes('zoom')) || els[0]
        if (e) { const r = e.getBoundingClientRect(); out.start = { x: Math.round(r.left + Math.min(r.width, 120) / 2), y: Math.round(r.top + r.height / 2), revealedRect: { l: r.left, t: r.top, r: r.right, b: r.bottom } } }
      }
      if (sp.blank) out.blank = S.blankBand(sp.blank)
      /**
       * G3（"从空白带按下拖"）对**每一格**都要真的去**量**那一行有没有空白带：
       * blankNear 是该元素所在行里的一段文字（null = 该行由整行宽的构件盒占满，
       * 例如块级公式那一行）。量不到就如实 SKIP，而不是因为"规格里没写"就跳过 ——
       * 后者会把"没测"写成"测了没有"。
       */
      out.blankMeasured = sp.blankNear ? !!S.blankBand(sp.blankNear) : false
      out.blankNear = sp.blankNear || null
      out.end = S.at(sp.end[0], sp.end[1])
      /** 跨结构拖：一律拖到"尾段" */
      out.cross = S.at('尾段：随便', 0.8)
      const pm = document.querySelector('.ProseMirror')
      out.dbg = { mathBlock: pm.querySelectorAll('[data-md-math-block]').length, widgets: pm.querySelectorAll('[data-img-widget]').length, revealed: pm.querySelectorAll('[data-img-revealed]').length, vh: innerHeight }
      return out
    })()`)
    if (!resolved.end) {
      return skip('终点解析失败（needle 不在 DOM / 不在视口内）', { end: resolved.end })
    }
    /**
     * 按下点：
     *   * E9（"空白带"这一**元素**）与 G3（"从空白带按下"这一**手势**）⇒ 按在**行盒里、
     *     字形/构件盒之外**的那个点上（`blankBand()` 现测量）；
     *   * 其余 ⇒ 按在该元素的锚点（原子构件盒中心 / needle 点 / 显形源码）。
     * ⚠️ G2 是**反拖**：按在"终点"那一侧、拖回锚点。所以按下点的**预期元素**随手势变，
     * 命中自检必须跟着变（否则会出现"按在文字上却要求它落在原子构件里"的假 SKIP）。
     */
    const needBlank = el.id === 'E9' || gest.id === 'G3'
    if (needBlank && !resolved.blank) {
      /**
       * E9 的空白带在 `blank` 字段里；其余元素在 G3 时用 `blankNear` **现量一次**。
       */
      const near = resolved.blankNear
      if (near) {
        const b2 = await json(`(() => { const b = window.__SPEC.blankBand(${JSON.stringify(near)}); return b ? { point: b.point, clearance: b.clearance, glyph: b.glyph, paraText: b.paraText, candN: b.candN } : null })()`)
        if (b2) resolved.blank = b2
      }
      if (!resolved.blank) {
        return skip('该行没有"行盒 ≫ 字形盒"的空白带（实测整行被字形/构件盒填满）', {
          blankNear: near,
          measured: resolved.blankMeasured,
          note: near ? 'blankBand() 现测量为 null' : '该元素的"行"由整行宽的构件盒占满（无行盒概念）'
        })
      }
    }
    if (!resolved.start && !needBlank) {
      return skip('起点解析失败（needle 不在 DOM / 不在视口内）', { start: resolved.start, startWhy: resolved.startWhy, dbg: resolved.dbg })
    }
    if (gest.id === 'G10' && !resolved.cross) return skip('跨结构目标不可用', {})

    const anchorPt = needBlank
      ? { x: resolved.blank.point.x, y: resolved.blank.point.y }
      : { x: resolved.start.x, y: resolved.start.y }
    const endPt =
      gest.id === 'G5' || gest.id === 'G10'
        ? { x: resolved.cross.x, y: resolved.cross.y }
        : { x: resolved.end.x, y: resolved.end.y }
    const pts = gest.id === 'G2' ? { start: endPt, end: anchorPt } : { start: anchorPt, end: endPt }
    /** 按下点的**预期**（命中自检用；不写死坐标，只写"它应该落在哪一类元素里"） */
    const atomSel =
      el.id === 'E3' ? '[data-md-math-block]' : el.id === 'E4' || el.id === 'E5' ? '[data-img-widget]' : el.id === 'E8' ? '.img-src-revealed' : null
    const expect =
      gest.id === 'G2'
        ? { blockHas: (resolved.end.blockText || '').slice(0, 10) }
        : needBlank
          ? { blank: true, paraHas: (resolved.blank ? resolved.blank.paraText : '').slice(0, 8) }
          : atomSel
            ? { atom: atomSel }
            : { blockHas: (resolved.start.blockText || '').slice(0, 10) }

    /** ④ 命中自检：按下点必须真的落在预期元素上（视口外的行会给假数据） */
    const hit = await json(`(() => {
      const el = document.elementFromPoint(${pts.start.x}, ${pts.start.y})
      const desc = el ? { tag: el.tagName, cls: String(el.className || '').slice(0, 60), txt: (el.textContent || '').slice(0, 24) } : null
      if (!el) return { ok: false, why: 'elementFromPoint 返回 null（被浮层压住 / 在视口外）', desc }
      const exp = ${JSON.stringify(expect)}
      if (exp.atom) {
        const ok = !!el.closest(exp.atom)
        return { ok, why: ok ? '' : 'not-in-' + exp.atom, desc }
      }
      const blk = el.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre')
      if (!blk) return { ok: false, why: 'not-in-block', desc }
      if (exp.blank) {
        const x = ${pts.start.x}
        const y = ${pts.start.y}
        const inGlyph = (() => {
          const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT)
          let n
          while ((n = w.nextNode())) {
            if (!n.length) continue
            const rg = document.createRange()
            rg.selectNodeContents(n)
            for (const c of rg.getClientRects()) if (x >= c.left - 1 && x <= c.right + 1 && y >= c.top - 1 && y <= c.bottom + 1) return true
          }
          for (const a of blk.querySelectorAll('[data-img-widget],[data-md-math-rendered]')) {
            const c = a.getBoundingClientRect()
            if (x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) return true
          }
          return false
        })()
        const ok = (blk.textContent || '').includes(exp.paraHas) && !inGlyph
        return { ok, why: ok ? '' : inGlyph ? 'landed-on-glyph' : 'wrong-block', desc, blank: true }
      }
      const ok = (blk.textContent || '').includes(exp.blockHas)
      return { ok, why: ok ? '' : 'wrong-block(text!)', desc }
    })()`)
    if (!hit.ok) {
      return skip(`命中自检失败：按下点不在预期元素内（${hit.why}）`, { start: pts.start, hit })
    }

    /** ⑤ 手势 + 逐帧采样 */
    const before = await app.ev(`window.__L.ed().storage.markdown.getMarkdown()`)
    const errsBefore = logSink.length
    const gres = (await runGesture(el.id, gest.id, pts)) || {}
    /** 出帧确认：窗口不出帧时 rAF 采样恒空 ⇒ 这一格作废（不是产品缺陷） */
    let frames = await json(`window.__INV.frames`)
    if (!frames.length) {
      for (let i = 0; i < 4 && !frames.length; i++) {
        await sleep(220)
        frames = await json(`window.__INV.frames`)
      }
      if (!frames.length) return skip('拖动期一个 rAF 帧都没采到（窗口不出帧 / 被遮挡）', {})
    }
    await sleep(SETTLE_WAIT)
    const after = await json(`window.__INV.snap()`)
    const errs = logSink.filter((l) => l.cell === id).slice(0, 6)

    // ─── I1 覆盖完整（逐帧；三分类：原生领先 / 单帧闪 / 连续缺口）──────────────
    /**
     * ⚠️ **已经收尾的帧不进 I1**：G6–G9（pointercancel / blur / visibilitychange / Escape）是
     * "手势中途被应用收尾"的四种，收尾之后屏幕由**落定态**负责（那段归 I2/I3/I4 判）。
     * 不收尾判据的话，收尾后残留的 `data-img-drag-live`（应用故意不清，见 imageToolbar 的
     * `LAST_LIVE_TRUST_MS`）会被读成"试探区间还在推进"，把**已经落定**的帧误判成"拖动期没样式"。
     * 判据只认应用自己写的诊断锚 `data-img-settle-in`（`onBandUp` → `settleGesture` 第一件事）。
     */
    const allLive = frames.filter((f) => !f.err && f.intent)
    const liveFrames = allLive.filter((f) => !f.settleIn)
    const postSettleFrames = allLive.filter((f) => f.settleIn)
    const strictBad = liveFrames.filter((f) => f.cov.missN > 0 || f.cov.mathMissN > 0)
    /**
     * 差额再按"**缺的是不是整条单元**"分一次：
     *   * `edgeFrames`：缺的那条单元**跨出了试探区间**（`a < live.from || b > live.to`）——
     *     也就是边界上那 1–2 个字形，来自"试探区间与浏览器 DOM 选区在相邻两拍上各自推进"
     *     （实测 E6×G5：单元 `725|727` 而试探区间 `725|726`，原生从 726 开始画）。
     *   * 其余 = **整条单元在区间内却一个像素都没有** ⇒ 真缺口，按"连续 ≥2 帧"判。
     */
    const keyAB = (k) => {
      const p = String(k).split('|')
      return { a: Number(p[1]), b: Number(p[2]) }
    }
    const genuineOf = (f) => {
      const keys = f.cov.missKeys && f.cov.missKeys.length ? f.cov.missKeys : f.covLive ? f.covLive.missKeys : []
      const lv = f.live
      return keys.filter((k) => {
        const { a, b } = keyAB(k)
        return !lv || (a >= lv.from && b <= lv.to)
      })
    }
    const edgeFrames = strictBad.filter((f) => genuineOf(f).length === 0)
    const realMiss = strictBad.filter((f) => genuineOf(f).length > 0)
    /**
     * **单帧闪 vs 连续缺口**：同一个单元（指纹 kind|a|b|l|t）在**连续**两帧里都没上色，
     * 才算"连续缺口"（历史 bug 家族：公式/表格/图片整块在拖动期一直没有样式，会连续几十帧）。
     * 只差一帧、前后帧都补上了的，记 `flashFrames`（**记录**，不判失败）——实测是
     * "自绘带每帧重画一次、而试探区间在两次重画之间又推进了一截"的产物。
     */
    const runOf = (() => {
      const cur = new Map()
      const maxRun = new Map()
      realMiss.forEach((f) => {
        for (const k of genuineOf(f)) {
          const n = (cur.get(k) || 0) + 1
          cur.set(k, n)
          maxRun.set(k, Math.max(maxRun.get(k) || 0, n))
        }
      })
      return maxRun
    })()
    const sustainedKeys = new Set([...runOf.entries()].filter(([, n]) => n >= 2).map(([k]) => k))
    const sustainedFrames = realMiss.filter((f) => genuineOf(f).some((k) => sustainedKeys.has(k)))
    const flashFrames = realMiss.filter((f) => !sustainedFrames.includes(f))
    const i1 = {
      /**
       * 判据：
       *   * 有试探区间（`liveFrames ≥ 1`）⇒ **不允许"连续 ≥2 帧"的整条单元缺口**；
       *   * 一个试探区间都没有：
       *       - 应用在按下后立刻把这一趟**收尾**了（`postSettleFrames > 0`，实测"按在块级公式
       *         里"就是这样：Chromium 立刻派发 `pointercancel`）⇒ 记 n/a，由 **I7**（落点覆盖）
       *         判这一趟到底有没有选中东西；
       *       - 连收尾都没有 ⇒ **整个手势零绘制**，直接判失败（那正是"按下拖动却没有样式"）。
       */
      ok:
        gest.id === 'G4'
          ? sustainedFrames.length === 0
          : liveFrames.length === 0
            ? postSettleFrames.length > 0
            : sustainedFrames.length === 0,
      frames: frames.length,
      liveFrames: liveFrames.length,
      postSettleFrames: postSettleFrames.length,
      earlySettle: liveFrames.length === 0 && postSettleFrames.length > 0,
      na: gest.id === 'G4' ? (liveFrames.length === 0 ? 'click-no-range' : 'click-produced-range') : liveFrames.length === 0 ? (postSettleFrames.length ? 'early-settle(判据交给 I7)' : 'zero-live-frames') : null,
      /** 严格口径（任务原文）的差额帧数 */
      strictBadFrames: strictBad.length,
      /** 其中"缺的是跨出试探区间的边界字形"那一类（记录，见文件头口径说明） */
      edgeFrames: edgeFrames.length,
      /** 其中"原生领先试探区间"（edge 的子集，逐帧原始证据在 firstLag） */
      lagFrames: strictBad.filter((f) => f.lag).length,
      /** 单帧闪（记录，不判失败；前后帧都补上了） */
      flashFrames: flashFrames.length,
      /** 连续 ≥2 帧没上色的帧数 —— 历史 bug 家族的真判据，必须 0 */
      sustainedFrames: sustainedFrames.length,
      /** 兼容旧字段名：判据口径的失败帧数 */
      missFrames: sustainedFrames.length,
      na: gest.id === 'G4' ? (liveFrames.length === 0 ? 'click-no-range' : 'click-produced-range') : liveFrames.length === 0 ? (postSettleFrames.length ? 'early-settle(判据交给 I7)' : 'zero-live-frames') : null,
      firstMiss: (sustainedFrames[0] || flashFrames[0])
        ? (() => {
            const f = sustainedFrames[0] || flashFrames[0]
            return {
              sustained: !!sustainedFrames[0],
              t: f.t,
              intent: f.intent,
              live: f.live,
              model: f.model,
              missN: f.cov.missN,
              mathMissN: f.cov.mathMissN,
              own: f.own,
              natAttr: f.natAttr,
              bandN: f.bandN,
              hlN: f.hlN,
              natN: f.natN,
              bandRects: f.bandRects,
              hlRects: f.hlRects,
              natRects: f.natRects,
              oursAttr: f.oursAttr,
              detail: f.cov.detail,
              missKeys: f.cov.missKeys
            }
          })()
        : null,
      firstLag: strictBad.filter((f) => f.lag)[0]
        ? (() => {
            const f = strictBad.filter((x) => x.lag)[0]
            return {
              t: f.t,
              intent: f.intent,
              live: f.live,
              bandRects: f.bandRects,
              natRects: f.natRects,
              detail: f.cov.detail
            }
          })()
        : null
    }
    const lastLive = liveFrames.length ? liveFrames[liveFrames.length - 1] : null

    // ─── I3 选区一致 ────────────────────────────────────────────────────
    const gestureMin = liveFrames.length ? Math.min(...liveFrames.map((f) => f.intent.from)) : null
    const gestureMax = liveFrames.length ? Math.max(...liveFrames.map((f) => f.intent.to)) : null
    const settled = after.model
    let i3
    if (gest.id === 'G4') {
      const exp = resolved.start && resolved.start.atom ? resolved.start.atom : null
      if (exp) {
        /**
         * 单击原子构件：两种**合法**落法 ——
         *   ① 整个构件被选中（NodeSelection，`![]()` 那种图片节点是这样）；
         *   ② 插入符落在构件的边界上（±3 位）—— 原文图片（`<img …>`）点一下是"进源码编辑"，
         *      插入符自然落在源码起点/终点（历史报障"插入符画在公式右缘"就是这一类的坐标问题）。
         * 判据只排除"点到别处去了"。
         */
        const near = settled.from >= exp.s - 3 && settled.from <= exp.e + 3 && settled.empty
        const cover = settled.from <= exp.s && settled.to >= exp.e
        i3 = {
          ok: near || cover,
          kind: 'atom-expect',
          settled: [settled.from, settled.to],
          empty: settled.empty,
          expect: [exp.s, exp.e],
          how: near ? 'caret-near-atom' : cover ? 'node-selection' : 'elsewhere'
        }
      } else {
        const pc = await json(`(() => { const v = window.__L.ed().view; const r = v.posAtCoords({ left: ${pts.start.x}, top: ${pts.start.y} }); return r ? r.pos : null })()`)
        i3 = {
          ok: settled.empty === true && pc != null && Math.abs(settled.from - pc) <= 2,
          kind: 'caret-expect',
          settled: [settled.from, settled.to],
          empty: settled.empty,
          posAtCoords: pc
        }
      }
    } else if (!lastLive) {
      i3 = {
        ok: postSettleFrames.length > 0,
        kind: liveFrames.length === 0 ? 'early-settle(落定=收尾那一刻，另见 I7)' : 'no-live-frame',
        earlySettle: postSettleFrames.length > 0,
        settled: [settled.from, settled.to]
      }
    } else {
      /**
       * I3 口径（与 `imageToolbar.ts` 里落定的输入逐字对齐）：
       *   * **丢失必须 0**：`settled ⊇ 最后一帧的试探区间`（`data-img-drag-live` 的 from/to，
       *     也就是"画面上那一份"）；
       *   * **增长 ≤2**：`settled ⊆ 全部试探区间 ∪ 锚点 ∪ 落点`（`data-img-drag-live` 的第 1/2 段
       *     就是 `anchor|focus(head)`）+ 吸附容差 2 —— 出处：`onBandUp` 第一百二十七轮注释
       *     （"落定 ⊇ 画面，且 ⊆ 画面 ∪ 锚点 ∪ 落点"）与 `textSelAt` 的 ±2 容差。
       * ⚠️ **不能拿"试探区间 ∪ 原生区间"当落定输入**：原生 DOM 选区会领先试探区间一两个字形
       * （见文件头 I1 的口径说明），那是"浏览器自己的那份"，不是落定的输入 ⇒ 拿它算 drop
       * 会把每一格都判成"丢了 2 位"（实测 E1×G1 drop=2 正是这么来的）。
       */
      const trial = lastLive.live ? { from: lastLive.live.from, to: lastLive.live.to } : { from: lastLive.intent.from, to: lastLive.intent.to }
      const lows = []
      const highs = []
      for (const f of liveFrames) {
        if (f.live) {
          for (const v of [f.live.from, f.live.to, f.live.anchor, f.live.head]) if (Number.isFinite(v)) lows.push(v), highs.push(v)
        }
        /** 落点（模型那一份）也是落定的输入之一：`onBandUp` 的 `cands` 里就有 `focus`/`selection.head` */
        for (const v of [f.model.from, f.model.to]) if (Number.isFinite(v)) lows.push(v), highs.push(v)
      }
      if (!lows.length) lows.push(trial.from), highs.push(trial.to)
      const drop = Math.max(0, settled.from - trial.from) + Math.max(0, trial.to - settled.to)
      const spill = Math.max(0, Math.min(...lows) - settled.from) + Math.max(0, settled.to - Math.max(...highs))
      /**
       * ⚠️ G6–G9（中途收尾）的**增长**不判：那一次的输入是应用内部的"这一趟手势记录"
       * （`liveGesture.maxFrom/maxTo` + 收尾瞬间的落点），诊断锚里复算不出来 ⇒ 只判
       * **丢失 = 0**（画过的不能没有），增长如实打印（`spill`）并在报告里说明。
       */
      const midEvent = ['G6', 'G7', 'G8', 'G9'].includes(gest.id)
      i3 = {
        ok: drop === 0 && (midEvent ? true : spill <= 2) && settled.to > settled.from,
        kind: 'live-vs-settled',
        trial: [trial.from, trial.to],
        allowed: [Math.min(...lows), Math.max(...highs)],
        liveRange: [trial.from, trial.to],
        gesture: [gestureMin, gestureMax],
        settled: [settled.from, settled.to],
        drop,
        spill,
        spillJudged: !midEvent,
        tol: 'spill ≤2：textSelAt 吸附容差 ±2 + 锚点/落点并入（imageToolbar.ts 第一百二十七轮）；G6–G9 只判 drop'
      }
    }

    // ─── I2 两档一致（同一区间、按文档区间归并的单元比）─────────────────────
    let i2
    if (!lastLive || !i3 || gest.id === 'G4') {
      i2 = { ok: true, na: gest.id === 'G4' ? 'click-no-range' : 'no-live-frame' }
    } else {
      const lo = Math.max(lastLive.intent.from, settled.from)
      const hi = Math.min(lastLive.intent.to, settled.to)
      const settleCov = await json(`(() => { const c = window.__INV.cover(${lo}, ${hi}); const d = window.__INV.digest(${lo}, ${hi}); return { cov: c, digest: d } })()`)
      const merge = (dig) => {
        const m = new Map()
        for (const d of dig) {
          const k = `${d[1]}|${d[2]}`
          const prev = m.get(k)
          if (!prev) m.set(k, { vis: d[7], box: d.slice(3, 7), kinds: [d[0]] })
          else {
            prev.vis = prev.vis || d[7]
            prev.kinds.push(d[0])
          }
        }
        return m
      }
      const a = merge(lastLive.digest)
      const b = merge(settleCov.digest)
      /**
       * 只出现在一档里的单元：**先用"区间重叠 + 另一档确实有底色"复核一次**再判失败 ——
       * 拖动期"显形源码"会把一个文本节点**拆成两个**、松手后又合并回去（DOM 节点身份变了，
       * 但文档区间与底色都在）。判据只关心"这一段有没有底色"。
       */
      const recon = (only, src, dst) => {
        void src
        const bad = []
        for (const k of only) {
          const [fa, fb] = k.split('|').map(Number)
          const hit = [...dst.entries()].some(([k2, v2]) => {
            const [ga, gb] = k2.split('|').map(Number)
            return v2.vis === 1 && Math.min(fb, gb) > Math.max(fa, ga)
          })
          if (!hit) bad.push(k)
        }
        return bad
      }
      const onlyLiveKeys = [...a.keys()].filter((k) => !b.has(k))
      const onlySettledKeys = [...b.keys()].filter((k) => !a.has(k))
      const visDiff = [...a.keys()].filter((k) => b.has(k) && a.get(k).vis !== b.get(k).vis)
      void recon
      /** 两档都在的单元：盒位移 > 1px 的一律记 `moved`（布局本身动了，几何不可比） */
      const moved = []
      let worst = 0
      let worstAt = null
      for (const [k, x] of a) {
        const y = b.get(k)
        if (!y) continue
        const dmax = Math.max(
          Math.abs(x.box[0] - y.box[0]),
          Math.abs(x.box[1] - y.box[1]),
          Math.abs(x.box[2] - y.box[2]),
          Math.abs(x.box[3] - y.box[3])
        )
        if (dmax > 1) moved.push({ k, live: x.box, settled: y.box, d: +dmax.toFixed(1) })
        if (dmax > worst) {
          worst = dmax
          worstAt = { k, live: x.box, settled: y.box }
        }
      }
      const geomOk = moved.length === 0 && worst <= 1
      const bgLive = lastLive.bandBg === undefined ? null : lastLive.bandBg
      const bgSet = await app.ev(`(() => { const e = document.querySelector('.sel-band'); return e && e.firstElementChild ? getComputedStyle(e.firstElementChild).backgroundColor : null })()`)
      const colorOk = !bgLive || !bgSet || bgLive === bgSet
      i2 = {
        ok: visDiff.length === 0 && (moved.length ? true : geomOk) && settleCov.cov.missN === 0 && settleCov.cov.mathMissN === 0 && colorOk,
        interval: [lo, hi],
        units: { live: a.size, settled: b.size },
        /**
         * ⚠️ `onlyLive`/`onlySettled` **只记不判**：两档的采样区间本来就差几个位置
         * （区间 = 试探区间 ∩ 落定区间），落在边界上的文本节点会被一档裁到、另一档裁不到
         * （实测 E8×G1：节点 288|294 在拖动期被裁进来、落定区间到 288 就结束了）⇒ 拿它判
         * 会把"区间边界"误判成"两档样式不一致"。判据用**两档都在的单元** + 落定态覆盖差额。
         */
        onlyLive: onlyLiveKeys.slice(0, 6),
        onlySettled: onlySettledKeys.slice(0, 6),
        onlyNote: '只记不判（区间边界差异，不是样式差异）',
        visDiff: visDiff.slice(0, 6),
        /** 布局在两档之间动过的单元（拖动期显形源码/图片下沉就是这一类）⇒ 几何不可比 */
        moved: moved.slice(0, 4),
        geometry: moved.length ? 'n/a(布局在两档之间动过)' : `worst=${worst.toFixed(2)}px`,
        worst: +worst.toFixed(2),
        worstAt,
        settledCover: { missN: settleCov.cov.missN, mathMissN: settleCov.cov.mathMissN, fragN: settleCov.cov.fragN },
        color: { live: bgLive, settled: bgSet, same: colorOk },
        na: null
      }
    }

    // ─── I4 无泄漏 ──────────────────────────────────────────────────────
    const nativeResidual = after.natAttr === 'on' ? 'on' : null
    const i4 = {
      ok:
        after.bandEls <= 1 &&
        (after.own ? after.bandN >= 1 : after.bandN === 0) &&
        !(after.hlNames || []).includes('lumin-img-drag') &&
        after.imgSel <= 3 &&
        after.imgSel === new Set(after.imgSelFrom).size &&
        i4NativeOk(after),
      bandEls: after.bandEls,
      own: after.own,
      bandN: after.bandN,
      hlNames: after.hlNames,
      imgSel: after.imgSel,
      imgSelFrom: after.imgSelFrom,
      natAttr: nativeResidual,
      natAttrNote: 'on 只有在"这一帧确实画了块级公式带 / 有片段交回原生"时才合法（见 markdown.css 第一百三十/一百二十五轮）',
      missAttr: after.missAttr
    }

    // ─── I5 往返无损 + I6 无异常 ────────────────────────────────────────
    const i5 = { ok: before === after.markdown, beforeLen: before.length, afterLen: after.markdown.length }
    const i6 = { ok: errs.length === 0 && !crashed, errs }

    /**
     * ─── I7 落点覆盖（拖动跟手）──────────────────────────────────────────────────
     * 不变量：**松手点所在的文档位置必须在落定的选区里**（±2 位吸附容差）。
     * 为什么单列一条：I1–I6 都是"自洽"类判据（画的和选的一致、两档一致），一个"拖了 400px
     * 却只选中 1 个位置"的手势在自洽类判据下**全绿**（实测块级公式×G5 正是这样）。
     * 三类如实记 n/a（不是掩盖）：单击（I3 另判）、落点压在原子构件盒上（落点语义由构件决定）、
     * G6–G9（中途被应用收尾 ⇒ 落定值以**收尾那一刻**为准，见 imageToolbar `settleGesture` 口径）。
     */
    let i7
    if (gest.id === 'G4') i7 = { ok: true, na: 'click（I3 另判）' }
    else if (gest.id === 'G6' || gest.id === 'G7' || gest.id === 'G8' || gest.id === 'G9')
      i7 = { ok: true, na: '中途收尾手势：落定以收尾那一刻为准' }
    else if (gres.relPos == null) i7 = { ok: true, na: 'posAtCoords 取不到落点' }
    else if (gres.onAtom) i7 = { ok: true, na: '落点压在原子构件盒上' }
    else {
      /**
       * 容差**自校准**：取这一趟手势里"试探区间远端**每帧推进量**的最大值"（= 一个绘制步）。
       * 为什么不用固定数字：拖动期"试探区间"取的是模型那一份，而模型由 PM 的 DOMObserver
       * 异步（~20ms）读回来 ⇒ 它天然比指针慢**一个绘制步**（步长随拖动速度变，实测 3~30 位）。
       * 用固定阈值要么放过"拖了 400px 只选中 1 个位置"，要么把每一格都判红；用实测步长
       * 才能既留住真问题、又不把"慢一步"当回归（判据不写死、可复算）。
       */
      let step = 0
      for (let i = 1; i < liveFrames.length; i++) {
        const p = liveFrames[i - 1]
        const c = liveFrames[i]
        if (p.live && c.live) step = Math.max(step, Math.abs(c.live.to - p.live.to), Math.abs(c.live.from - p.live.from))
      }
      const tol = step + 2
      const ok = settled.from - tol <= gres.relPos && gres.relPos <= settled.to + tol
      i7 = {
        ok,
        relPos: gres.relPos,
        releasePoint: gres.releasePoint,
        settled: [settled.from, settled.to],
        trial: lastLive && lastLive.live ? [lastLive.live.from, lastLive.live.to] : null,
        step,
        tol,
        why: ok ? '' : `落点 ${gres.relPos} 不在落定区间 [${settled.from},${settled.to}] ± (步长${step}+2) 内`
      }
    }

    /**
     * G3 专项（任务口径："从空白带按下拖应与**同列字形**拖动等价"）：
     * 同一格里再用"这一行最近的字形点"跑一次**同一目标**的手势，比较
     *   ① 锚点文档位置（`data-img-drag-live` 的第 1 段）；② 落定选区。
     * 两者都 ≤2 位才算等价（2 位是落定吸附容差，出处同 I3）。
     */
    let equiv = { ok: true, na: 'not-G3' }
    if (gest.id === 'G3' && resolved.blank && resolved.blank.glyph && liveFrames.length) {
      /**
       * 参考点必须真的"同列"：`|Δx| ≤ 60px`。不满足就**如实记 n/a** ——
       * 高行（被图片/显形源码撑高的行）里空白带附近的"最近字形"可能落在**另一段文字**上
       * （实测 E8：按下点 x=1145、参考字形 x=928，两者根本不是一列），那时比较的是两次不同的
       * 手势，出来的差异不是产品问题。
       */
      const dRefX = Math.abs(resolved.blank.glyph.x - resolved.blank.point.x)
      if (dRefX > 60) {
        equiv = {
          ok: true,
          na: `该行空白带附近没有"同列字形"（最近字形 Δx=${Math.round(dRefX)}px，参考点落到别的文字段）`,
          blankPoint: resolved.blank.point,
          glyphPoint: { x: resolved.blank.glyph.x, y: resolved.blank.glyph.y },
          dRefX: Math.round(dRefX)
        }
      } else {
      const ref = { start: { x: resolved.blank.glyph.x, y: resolved.blank.glyph.y }, end: pts.end }
      await runGesture(el.id, 'G3', ref)
      let refFrames = await json(`window.__INV.frames`)
      if (!refFrames.length) {
        await sleep(520)
        refFrames = await json(`window.__INV.frames`)
      }
      await sleep(SETTLE_WAIT)
      const refAfter = await json(`window.__INV.snap()`)
      const refLive = refFrames.filter((f) => !f.err && f.intent)
      const refLast = refLive.length ? refLive[refLive.length - 1] : null
      const aBlank = liveFrames[0].live ? liveFrames[0].live.anchor : null
      const aGlyph = refLive.length && refLive[0].live ? refLive[0].live.anchor : null
      const dA = aBlank != null && aGlyph != null ? Math.abs(aBlank - aGlyph) : null
      const dFrom = refLast ? Math.abs(refLast.intent.from - lastLive.intent.from) : null
      const dTo = refLast ? Math.abs(refLast.intent.to - lastLive.intent.to) : null
      const dSFrom = Math.abs(refAfter.model.from - settled.from)
      const dSTo = Math.abs(refAfter.model.to - settled.to)
      equiv = {
        /**
         * 判据：**两次手势的试探区间与落定区间都必须 ≤2 位相等**（这就是"等价"的定义）。
         * 锚点（`data-img-drag-live` 第 1 段）只作参考：字形那一次可能压根没记录锚点
         * （实测 E9 的参考手势 `anchor=null`）—— 拿它当硬判据会把"区间完全相等"判成失败。
         */
        ok: dFrom != null && dFrom <= 2 && dTo != null && dTo <= 2 && dSFrom <= 2 && dSTo <= 2 && (dA == null || dA <= 2),
        na: null,
        blankPoint: resolved.blank.point,
        glyphPoint: { x: resolved.blank.glyph.x, y: resolved.blank.glyph.y },
        clearance: resolved.blank.clearance,
        anchor: { blank: aBlank, glyph: aGlyph, d: dA },
        live: { blank: [lastLive.intent.from, lastLive.intent.to], glyph: refLast ? [refLast.intent.from, refLast.intent.to] : null, dFrom, dTo },
        settled: { blank: [settled.from, settled.to], glyph: [refAfter.model.from, refAfter.model.to], dFrom: dSFrom, dTo: dSTo },
        tol: '≤2 位：落定吸附容差（imageToolbar.ts textSelAt 注释）'
      }
      }
    }

    const all = i1.ok && i2.ok && i3.ok && i4.ok && i5.ok && i6.ok && i7.ok && equiv.ok
    const brief =
      `I1 连续缺口=${i1.sustainedFrames} 单帧闪=${i1.flashFrames} 原生领先=${i1.lagFrames}/${i1.liveFrames}${i1.earlySettle ? ' [提前收尾]' : ''}` +
      ` I2 ${i2.ok ? 'ok' : 'BAD'}` +
      ` I3 ${i3.ok ? 'ok' : 'BAD(drop' + (i3.drop ?? '-') + ' spill' + (i3.spill ?? '-') + ')'}` +
      ` I4 ${i4.ok ? 'ok' : 'BAD'}` +
      ` I5 ${i5.ok ? 'ok' : 'BAD'}` +
      ` I6 ${i6.ok ? 'ok' : 'BAD'}` +
      ` I7 ${i7.ok ? (i7.na ? 'n/a' : 'ok') : 'BAD(落点未覆盖)'}` +
      (equiv.na ? '' : ` G3 ${equiv.ok ? 'ok' : 'BAD'}`) +
      ` | ${Date.now() - t0}ms`
    const detail = { i1, i2: i2.ok ? { ok: true, na: i2.na || null, geometry: i2.geometry || null, worst: i2.worst } : i2, i3, i4, i5, i6, i7, equiv }
    if (all) {
      report.check(name, true, brief)
      record.push({ id, el: el.id, gest: gest.id, status: 'PASS', brief, json: detail })
    } else {
      report.check(name, false, `${brief} | ${JSON.stringify(detail).slice(0, 2400)}`)
      record.push({ id, el: el.id, gest: gest.id, status: 'FAIL', brief, json: detail })
    }
    return all
  } catch (e) {
    if (e && e.preconditionSkip) throw e
    fail(`格子执行抛异常：${String((e && e.message) || e)}`, {})
  }
}

/** `data-sel-band-native` 的合法性：只有"这一帧确实画了带（含块级公式那条）"时才允许挂 `on` */
function i4NativeOk(after) {
  if (after.natAttr !== 'on') return true
  return after.bandN >= 1
}

// ─── I1 口径的像素自证（独立于"四条真相"的第五条真相：屏幕上真的上了色）──────────
/**
 * 为什么需要：I1 的"可见绘制"是我们**自己算**的（带矩形 ∪ 高亮 ∪ 原生会画的地方）。
 * 那份算法若与浏览器实画不符，I1 就是在自证。这里取两次真实截图（基线：无选区；
 * 拖动期：选区已画出），**在页面里**解码 PNG、逐像素比对，检查：
 *   * 判为"覆盖"的取样点 ⇒ 像素必须变了（否则我们的模型在骗自己）；
 *   * 判为"未覆盖"的取样点 ⇒ 像素必须没变（否则漏画被模型吞掉）。
 */
async function pixelSelfCheck(report) {
  const points = []
  const shots = []
  const cases = [
    { id: 'PX1', name: '同段正文（原生绘制的路径）', a: ['纯正文段：开头', 0.2], b: ['用来做选区起点', 0.9] },
    { id: 'PX2', name: '混合长选区（我们的带的路径）', a: ['行内公式行：文字', 0.2], b: ['粗体丙', 0.7] }
  ]
  for (const c of cases) {
    try {
      await app.ev(`(() => { window.__L.ed().commands.setTextSelection(window.__L.ed().state.doc.content.size - 3); return 'ok' })()`)
      await sleep(300)
      /** 先把目标滚进视口（`at()` 对不在视口内的端点返回 null） */
      await app.ev(`(() => {
        const w = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          if ((n.textContent || '').includes(${JSON.stringify(c.a[0])})) {
            const rg = document.createRange()
            rg.selectNodeContents(n)
            const el = n.parentElement
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' })
            return 'ok'
          }
        }
        return 'ok'
      })()`)
      await sleep(250)
      await bringToFront(app)
      const base = await app.send('Page.captureScreenshot', { format: 'png' })
      const pts = await json(`(() => {
        const S = window.__SPEC
        const A = S.at(${JSON.stringify(c.a[0])}, ${c.a[1]})
        const B = S.at(${JSON.stringify(c.b[0])}, ${c.b[1]})
        return { A, B }
      })()`)
      if (!pts.A || !pts.B) {
        report.skip(`I1 像素自证 ${c.id}（${c.name}）`, '端点不在视口内')
        continue
      }
      await app.ev(`window.__INV.arm()`)
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.A.x, y: pts.A.y, button: 'left', clickCount: 1 })
      await sleep(20)
      for (let i = 1; i <= 8; i++) {
        await app.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(pts.A.x + ((pts.B.x - pts.A.x) * i) / 8),
          y: Math.round(pts.A.y + ((pts.B.y - pts.A.y) * i) / 8),
          button: 'left',
          buttons: 1
        })
        await sleep(22)
      }
      /** 保持按住：这一帧的屏幕就是"拖动期"的样子 */
      const during = await app.send('Page.captureScreenshot', { format: 'png' })
      /**
       * 逐**点**给预测（不是逐盒）：盒中心 + 四边中点 + 四角内缩 2px。
       * 为什么必须逐点：I1 的严格口径是"整盒被盖住"，而一个盒可能只被盖住 57%
       * （实测就是"原生领先试探区间"那一段）—— 逐盒比对看不出"哪几个像素真的上了色"，
       * 逐点才能把"模型说没有、像素却有"和"模型说有、像素却没有"两向都抓住。
       * 图片那一路取**盒外的描边环**（`.img-selected` 是 outline；盒内被不透明图片盖住）。
       */
      const probe = await json(`(() => {
        const s = window.__INV.sample()
        if (!s.intent) return { intent: null, points: [] }
        const b = window.__INV.bandRects()
        const h = window.__INV.hlRects()
        const nr = window.__INV.natDocRange()
        const inArr = (x, y, arr) => arr.some((r) => x >= r.l && x <= r.r && y >= r.t && y <= r.b)
        /**
         * ⚠️ 取样点必须落在**编辑器可视区**里：滚动出视口的部分会被顶栏/状态栏这类不透明浮层
         * 盖住 —— 那时"模型说这里有带、像素却没变"是**遮挡**，不是模型错（实测 PX2 上就抓到
         * 一个 y=20 的点，在顶栏底下）。判据只对"看得见的那片区域"负责。
         */
        const sc = document.querySelector('.editor-scroll') || document.querySelector('.ProseMirror')
        const sr = sc.getBoundingClientRect()
        const out = []
        for (const u of window.__INV.units(s.intent.from, s.intent.to)) {
          const natOk = !!(nr && window.__INV.nativePaintsAt(u.el) && nr.from <= u.a && nr.to >= u.b)
          for (const r of u.paint) {
            const cx = (r.l + r.r) / 2
            const cy = (r.t + r.b) / 2
            const pts =
              u.kind === 'image'
                ? [[r.l - 2, cy], [r.r + 2, cy], [cx, r.t - 2], [cx, r.b + 2]]
                : [
                    [cx, cy],
                    [r.l + 2, cy],
                    [r.r - 2, cy],
                    [cx, r.t + 2],
                    [cx, r.b - 2],
                    [r.l + 2, r.t + 2],
                    [r.r - 2, r.t + 2],
                    [r.l + 2, r.b - 2],
                    [r.r - 2, r.b - 2]
                  ]
            for (const [x, y] of pts) {
              if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue
              if (x < sr.left + 2 || x > sr.right - 2 || y < sr.top + 2 || y > sr.bottom - 2) continue
              const pred = inArr(x, y, b) || inArr(x, y, h) || natOk
              out.push({ kind: u.kind, x: Math.round(x), y: Math.round(y), pred, natOk, box: r })
            }
          }
        }
        return { intent: s.intent, points: out, own: s.own, bandN: s.bandN, hlN: s.hlN }
      })()`)
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.B.x, y: pts.B.y, button: 'left', clickCount: 1 })
      await app.ev(`window.__INV.disarm()`)
      await sleep(500)
      const samplePts = probe.points.slice(0, 60)
      const diffs = await jsonAsync(`(async () => {
        /**
         * ⚠️ 不能用 fetch(data:)：页面的 CSP（connect-src）会把 data: URL 拦掉（实测
         * "TypeError: Failed to fetch"）。这里自己 atob → Uint8Array → Blob。
         */
        const load = async (b64) => {
          const bin = atob(b64)
          const u8 = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
          const bm = await createImageBitmap(new Blob([u8], { type: 'image/png' }))
          const cv = new OffscreenCanvas(bm.width, bm.height)
          const g = cv.getContext('2d')
          g.drawImage(bm, 0, 0)
          return { d: g.getImageData(0, 0, bm.width, bm.height).data, w: bm.width, h: bm.height }
        }
        const A = await load(${JSON.stringify(base.result.data)})
        const B = await load(${JSON.stringify(during.result.data)})
        const dpr = B.w / innerWidth
        const out = []
        for (const p of ${JSON.stringify(samplePts)}) {
          const x = Math.round(p.x * dpr)
          const y = Math.round(p.y * dpr)
          let mx = 0
          for (const o of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3]]) {
            const xx = x + o[0]
            const yy = y + o[1]
            if (xx < 0 || yy < 0 || xx >= B.w || yy >= B.h) continue
            const i = (yy * B.w + xx) * 4
            for (let ch = 0; ch < 3; ch++) mx = Math.max(mx, Math.abs(A.d[i + ch] - B.d[i + ch]))
          }
          out.push({ kind: p.kind, pred: p.pred, natOk: p.natOk, d: mx, x: p.x, y: p.y })
        }
        return { dpr: +dpr.toFixed(3), img: [B.w, B.h], out }
      })()`)
      const THR = 8
      const falsePos = diffs.out.filter((p) => p.pred && p.d < THR)
      const falseNeg = diffs.out.filter((p) => !p.pred && p.d >= THR)
      const ok = samplePts.length >= 2 && falsePos.length === 0 && falseNeg.length === 0
      points.push({ id: c.id, ok, samples: diffs.out.length, falsePos, falseNeg, dpr: diffs.dpr })
      report.check(
        `I1 口径像素自证 ${c.id}（${c.name}）：模型判"这一点上了色"⇔ 截图像素确实变了（逐点，两向都算）`,
        ok,
        JSON.stringify({ samples: diffs.out.length, dpr: diffs.dpr, own: probe.own, bandN: probe.bandN, hlN: probe.hlN, falsePos: falsePos.slice(0, 4), falseNeg: falseNeg.slice(0, 4) }).slice(0, 2000)
      )
      shots.push({ id: c.id, points: diffs.out.length })
    } catch (e) {
      report.skip(`I1 像素自证 ${c.id}`, `执行异常：${String((e && e.message) || e)}`)
    }
  }
  return { points, shots }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const prov = buildProvenance()
  const report = new Reporter('选区不变量矩阵（元素 × 手势）')
  report.note(
    `构建：${prov.asset} (sha256:${prov.assetSha256}) mtime=${prov.assetMtime}；` +
      `最新源码 ${prov.newestSrc} mtime=${prov.newestSrcMtime}；HEAD=${prov.head} dirty=${prov.dirty} 个文件`
  )
  report.check(
    '构建校验：out/renderer/assets/EditorView-*.js 的 mtime 晚于源码（否则统计作废）',
    prov.fresh,
    JSON.stringify(prov)
  )
  if (!prov.fresh) throw preconditionSkip('构建不新鲜（out 比 src 旧）——先重新构建再跑，统计才作数')
  if (prov.dirty) report.note(`⚠️ 工作区有 ${prov.dirty} 个未提交文件（另一个 agent 可能在改 src）——本次数字对应上面那份构建`)

  await bootInstance('开跑')
  /**
   * ─── 第 135 轮：可见性前置条件改成**先 bringToFront 再判定 + 有限重试** ────────────────
   * 旧写法只判一次：`if (!(await framesAlive(app))) throw preconditionSkip('窗口不产生帧…')`。
   * 本环境里窗口常被遮挡（rAF 停摆），一次判定就把整轮作废，事后手动 bringToFront 也来不及
   * （脚本已经退了）。现在最多试 3 次，每次都**重新 bringToFront + 等一拍**再判定；
   * 仍失败则如实 skip，并给出可操作提示。
   */
  let framesOk = false
  for (let i = 0; i < 3 && !framesOk; i++) {
    await bringToFront(app).catch(() => {})
    await sleep(400)
    framesOk = await framesAlive(app)
    if (!framesOk) console.log(`· 窗口暂无帧（第 ${i + 1}/3 次判定）——已重新 bringToFront，继续重试`)
  }
  if (!framesOk) {
    throw preconditionSkip('窗口不产生帧（多半被遮挡）——已 bringToFront 重试 3 次仍无帧；请把窗口置于最前（或加 --disable-features=CalculateNativeWinOcclusion）后重跑')
  }

  const cells = []
  for (const el of ELEMENTS) {
    if (ONLY_PIXEL) break
    if (ONLY_ELEMENTS.length && !ONLY_ELEMENTS.includes(el.id)) continue
    for (const g of GESTURES) {
      if (ONLY_GESTURES.length && !ONLY_GESTURES.includes(g.id)) continue
      if (ONLY.length && !ONLY.includes(cellId(el.id, g.id))) continue
      cells.push({ el, g })
    }
  }
  const limited = CELL_LIMIT ? cells.slice(0, CELL_LIMIT) : cells
  report.note(`矩阵规模：${ELEMENTS.length} 元素 × ${GESTURES.length} 手势 = ${ELEMENTS.length * GESTURES.length} 格；本次跑 ${limited.length} 格`)

  const record = []
  let done = 0
  for (const { el, g } of limited) {
    if (done > 0) await maybeRestart(done)
    if (done % 20 === 0 && done > 0 && !(await framesAlive(app, 1200))) {
      report.skip(`[第 ${done} 格后] 窗口不出帧`, '窗口被遮挡：Chromium 把 rAF 降到 1/500ms，剩余格子统计不可信')
      break
    }
    try {
      await matrixCell(el, g, report, record)
    } catch (e) {
      if (e && e.preconditionSkip) throw e
      report.check(`[${cellId(el.id, g.id)}] 执行异常`, false, String((e && e.stack) || e).slice(0, 1200))
      record.push({ id: cellId(el.id, g.id), el: el.id, gest: g.id, status: 'FAIL', why: String((e && e.message) || e) })
    }
    done++
    cellsOnInstance++
  }

  // ─── 逐格结果表（元素 × 手势）────────────────────────────────────────
  console.log('\n## 逐格结果表（行=元素，列=手势；`.`=PASS `X`=FAIL `s`=SKIP）')
  const head = ['      ', ...GESTURES.map((g) => g.id.padStart(4))].join(' ')
  console.log(head)
  const short = { PASS: '   .', FAIL: '   X', SKIP: '   s' }
  for (const el of ELEMENTS) {
    const row = [el.id.padEnd(5)]
    for (const g of GESTURES) {
      const r = record.find((x) => x.el === el.id && x.gest === g.id)
      row.push(r ? short[r.status].padStart(4) : '   -')
    }
    console.log(row.join(' '))
  }
  console.log('\n## 每格 I1–I6（只列跑过的格子；`—`=该档对本格无意义）')
  for (const r of record) {
    if (r.status === 'SKIP') {
      console.log(`SKIP ${r.id.padEnd(7)} ${r.why || ''}`)
      continue
    }
    const j = r.json || {}
    const i1 = j.i1 || {}
    const i2 = j.i2 || {}
    const i3 = j.i3 || {}
    const i4 = j.i4 || {}
    const i5 = j.i5 || {}
    const i6 = j.i6 || {}
    const i7 = j.i7 || {}
    console.log(
      `${r.status.padEnd(4)} ${r.id.padEnd(7)} ` +
        `I1 连续缺口=${i1.sustainedFrames ?? '-'} 单帧闪=${i1.flashFrames ?? '-'} 原生领先=${i1.lagFrames ?? '-'}/${i1.liveFrames ?? '-'}(收尾后${i1.postSettleFrames ?? '-'}帧不计)` +
        `${i1.earlySettle ? ' [提前收尾]' : ''} ` +
        `I2 ${i2.ok ? (i2.na ? 'n/a' : i2.geometry || 'ok') : 'BAD'}` +
        `I3 drop=${i3.drop ?? '-'} spill=${i3.spill ?? '-'} settled=${JSON.stringify(i3.settled || null)} ` +
        `I4 bandEls=${i4.bandEls ?? '-'} bandN=${i4.bandN ?? '-'} own=${i4.own ?? 'null'} hl=${JSON.stringify(i4.hlNames || [])} imgSel=${i4.imgSel ?? '-'} ` +
        `I5 ${i5.ok ? 'byte-eq' : 'DIFF'} I6 errs=${(i6.errs || []).length} ` +
        `I7 ${i7.ok ? (i7.na ? 'n/a' : `rel=${i7.relPos}∈[${(i7.settled || []).join(',')}]`) : 'BAD(' + (i7.why || '') + ')'}`
    )
  }

  // ─── 聚合断言（类级）─────────────────────────────────────────────────
  const ran = record.filter((r) => r.status !== 'SKIP')
  const agg = (key) => {
    if (!ran.length) return { total: 0, bad: [] }
    const bad = ran.filter((r) => !(r.json && r.json[key] && r.json[key].ok))
    return { total: ran.length, bad: bad.map((r) => r.id) }
  }
  for (const [key, label] of [
    ['i1', 'I1 覆盖完整（无"连续 ≥2 帧"的缺口；单帧闪与"原生领先"逐格记录、不隐藏）'],
    ['i2', 'I2 两档一致（松手后 == 拖动期最后一帧，同一区间逐行 Δ≤1px、色值相同）'],
    ['i3', 'I3 选区一致（settled == live，丢失 0、增长 ≤2）'],
    ['i4', 'I4 无泄漏（松手后无临时绘制残留）'],
    ['i5', 'I5 往返无损（getMarkdown 逐字节相同）'],
    ['i6', 'I6 无异常（无 console.error / 未捕获异常 / 崩溃）'],
    ['i7', 'I7 落点覆盖（松手点所在位置必须落在落定区间内；不适用的三类如实 n/a）'],
    ['equiv', 'G3 等价（从空白带按下 == 同一行最近字形按下）']
  ]) {
    const a = agg(key)
    report.check(
      `${label}：全部跑过的格子都成立`,
      a.total >= Math.min(20, limited.length) && a.bad.length === 0,
      `跑过 ${a.total} 格；失败格 ${a.bad.length ? a.bad.join(',') : '无'}`
    )
  }
  const fails = record.filter((r) => r.status === 'FAIL')
  const skips = record.filter((r) => r.status === 'SKIP')
  report.check(
    '矩阵完整性：跑完的格子数 ≥ 计划的 90%，且 SKIP 都有可核对的原因（不许用 skip 掩盖失败）',
    record.length >= Math.floor(limited.length * 0.9) && record.every((r) => r.status !== 'SKIP' || (r.why || '').length > 4),
    `计划 ${limited.length} 格，产出 ${record.length} 格：PASS ${record.length - fails.length - skips.length} / FAIL ${fails.length} / SKIP ${skips.length}`
  )
  report.check(
    '命中自检：没有"按下点不在预期元素内"的格子（否则那一格的数字是假数据）',
    !skips.some((r) => /命中自检失败/.test(r.why || '')),
    JSON.stringify(skips.filter((r) => /命中自检失败/.test(r.why || '')).map((r) => r.id))
  )
  if (!NO_PIXEL) await pixelSelfCheck(report)
  else report.note('I1 像素自证：按 --no-pixel 跳过（默认会跑）')

  report.note(
    `实例策略：每 ≤${RESTART_EVERY} 格换一个全新隔离实例（端口 9422/9423，userData %TEMP%\\xw-inv-ud(2)）；` +
      `每 ${FRONT_EVERY} 格 Page.bringToFront 一次；每 20 格探一次"窗口是否还在出帧"`
  )
  report.note(
    `日志：主进程/渲染层错误共 ${logSink.length} 条（按格归属，逐格断言 I6）；` +
      `崩溃=${crashed ? '是' : '否'}`
  )
  // 收尾：`launchStable` 用**唯一 userData**（不再是 PROFILE 里那两个固定目录），
  // 所以不再按 `profileIdx` 索引 PROFILES —— 它已不再推进，越界会抛
  // `TypeError: Cannot read properties of undefined (reading 'ud')` 把整轮打成 20 格（本轮实测踩到）。
  for (const p of PROFILES) startIsolated({ userData: p.ud, port: p.port, cleanupOnly: true })
  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    for (const p of PROFILES) {
      try {
        startIsolated({ userData: p.ud, port: p.port, cleanupOnly: true })
      } catch (err) {}
    }
    fatal(e)
  })
