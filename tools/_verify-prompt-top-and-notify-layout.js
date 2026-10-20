'use strict'
// ─── 验收：① 三类提示（未保存 / 比磁盘新 / 关窗保存）的**呈现与交互**──────
//            ② 通知中心（「文件以什么编码打开」这类）的**内部布局** ────────
//
// 用户口径（原话）：
//   ① 「将提示（未保存或者比磁盘文件更新，并非应用内通知）组件的样式优化下，使其不是现在这样
//      （弹出窗口，并模糊后面的主应用内容），而是和浏览器以及主流编辑器的 alert 提示一样，
//      在应用的上方出现，此时聚焦在提示上，不能对其他内容进行修改，但是不影响其他实例。」
//   ② 「优化下应用内通知（文件以什么编码打开等）的样式，使其通知内布局更合理（按钮、通知内容等）。」
//   ③ **第二轮细化（用户看了效果之后）**：
//      * 「现在这个新的提示上边框会有黑边框，请取消。」→ 卡片四个方向都不许有边框（靠阴影立起来）；
//      * 「优化这个新提示的位置，使其出现在**中上方**的位置，并且动效是该组件**从上方滑出**，
//        且**取消这个提示上面的带有花哨图案的图标**，显示标题、描述和操作按钮即可。」
//        → 位置 = 0.10~0.25 × 视口高；入场 = `translateY(-N)` 自上而下（不是缩放/淡入为主）；
//        卡片内 `svg` 数 = 0，且标题/描述/按钮仍在；
//      * 「出现这个新提示后，后面的内容会**稍稍变得暗一点**，而且**不可点击其他地方取消这个提示**，
//        只能通过按上面的按钮操作。」→ 那一层从"完全透明"改成"很轻的压暗"
//        （`color-mix(--scrim X%, transparent)`：alpha > 0 且 < `--scrim` 全量），
//        并且**取消**「点提示之外 = 取消」这条路径（这是**用户口径变更**，见 CHANGELOG / 附录 §4.89）。
//
// 本套件守的是**呈现层契约**（行为语义由 `_verify-close-save-prompt.js` / `_verify-draft-banner.js`
// 继续守着，两条都必须在改样式之后照旧全绿）：
//
//   A. 顶部提示条：无模糊 / 卡片无边框无图标 / 位于中上方且水平居中 / 焦点在提示内 /
//      Tab 被限制在提示内 / 提示下面的正文**点到也不动光标**（真的用 CDP 发一次鼠标点击，
//      并用「点击真的送到了那一层」的 capture 计数器当**投递凭证**：没投递到就红，不会假绿）。
//      ⚠️ 关于「背景 inert」：那层**压暗过**的 `fixed inset-0` 仍是命中目标（hit target）——
//      所以"点正文"根本打不到编辑器上，而且背景连滚动都不通（与浏览器 alert / 主流编辑器一致）。
//      `prompt-backdrop-covers-viewport` / `prompt-covers-the-editor-under-the-pointer` 两条
//      量的就是这个结构性事实（elementFromPoint）。
//      ⚠️ **点提示之外不再取消**（第二轮口径变更）：改前那条断言是 `prompt-outside-click-still-cancels`，
//      现在是 `prompt-outside-click-no-longer-cancels`，而且**更强**：点击被送达 + 提示仍在 +
//      两个 Promise 仍 pending。Esc 保留，且必须与可见的「取消」按钮**返回同一个值**
//      （`*-escape-equals-the-cancel-button` 三条：二选一 / 三选一 / 输入框）。
//
//   B. 通知布局：按钮矩形必须整个落在通知矩形内、且与正文矩形不相交；200 字符的**不可折行**长
//      文件名与长路径下正文不许横向溢出（scrollWidth <= clientWidth + 1）且必须真的换行；
//      三语（zh-CN / en-US / ru-RU）切换后按钮与正文仍不溢出；关键元素仍有可访问名；
//      点的触达区域 >= 24x24；长正文就地滚动且吞掉滚轮链式滚动。
//
//   C. 不影响其他实例：A 窗口的提示开着时，B 窗口**没有**提示 DOM、B 的正文照样能点（光标真的动）、
//      B 的内容能改，而 A 的提示不会被 B 的操作关掉。
//
// 跑法：node tools/run-suites.js --suite=_verify-prompt-top-and-notify-layout.js
// （或对已有隔离实例：node tools/_verify-prompt-top-and-notify-layout.js）
const {
  connect,
  settle,
  sleep,
  openDocWith,
  waitEditor,
  ensureFocus,
  listTargets,
  isAppPage,
  attach,
  clickAt,
  Reporter,
  fatal
} = require('./lib/harness')

/**
 * 页面侧：量「顶部提示条」。
 *
 * 参数是**根选择器**（ModalHost 用 `[data-top-prompt]`，草稿提示用 `.draft-modal`）——
 * 两个提示共用同一套 CSS（`.lm-prompt` / `.lm-prompt__card`），所以量法也只有一份。
 *
 * 第二轮（用户细化）后这里多量四件事：
 *   * **卡片的边框**（用户："这个新的提示上边框会有黑边框，请取消"）—— 四个方向都要是 0；
 *   * **卡片里有没有图标**（用户："取消这个提示上面的带有花哨图案的图标"）—— `svg` 数必须是 0，
 *     同时标题 / 描述 / 按钮仍在；
 *   * **背景压暗有多重**：这一层是 `color-mix(--scrim X%, transparent)`，所以把它的 alpha 与
 *     `--scrim` **全量**的 alpha 一起量出来比大小（"稍稍变暗" = 0 < alpha < 全量；Chromium 把
 *     color-mix 序列化成 `color(srgb …)`，所以 alpha 解析两种语法都认）；
 *   * **卡片位置**（中上方：0.10~0.25 × 视口高）与窄窗下按钮是否还在视口内。
 *
 * ⚠️ 整段是模板字符串：里面不许出现反引号，正则里的 `\s` 要写成 `\\s`。
 */
const PROMPT = (sel) => `(() => {
  const root = document.querySelector(${JSON.stringify(sel)})
  if (!root) return JSON.stringify({ open: false })
  const card = root.querySelector('.lm-prompt__card')
  const rr = root.getBoundingClientRect()
  const cr = card ? card.getBoundingClientRect() : null
  const cs = getComputedStyle(root)
  const blurs = []
  for (const el of [root].concat(Array.from(root.querySelectorAll('*')))) {
    const s = getComputedStyle(el)
    const cls = typeof el.className === 'string' ? el.className.split(/\\s+/)[0] : el.tagName
    if (s.backdropFilter && s.backdropFilter !== 'none') blurs.push(cls + ':' + s.backdropFilter)
    if (s.filter && s.filter !== 'none' && s.filter.indexOf('blur') >= 0) blurs.push(cls + ':filter=' + s.filter)
  }
  /** 颜色 alpha：rgba()/rgb() 与 color(srgb …) 两种序列化都认（color-mix 会走后者） */
  const alphaOf = (v) => {
    const s = String(v).trim()
    if (s.indexOf('rgba(') === 0 || s.indexOf('rgb(') === 0) {
      const parts = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(/[,\\/]/).map((x) => x.trim()).filter(Boolean)
      if (parts.length < 4) return 1
      return parts[3].indexOf('%') >= 0 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
    }
    if (s.indexOf('color(') === 0) {
      const body = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'))
      if (body.indexOf('/') < 0) return 1
      const a = body.split('/')[1].trim()
      return a.indexOf('%') >= 0 ? parseFloat(a) / 100 : parseFloat(a)
    }
    return 1
  }
  // --scrim 全量的 alpha：造一个探针元素取它的计算值（不把 0.32 这类数字抄进断言）
  const probe = document.createElement('div')
  probe.style.background = 'var(--scrim)'
  document.body.appendChild(probe)
  const scrimAlpha = alphaOf(getComputedStyle(probe).backgroundColor)
  probe.remove()
  const ccs = card ? getComputedStyle(card) : null
  const active = document.activeElement
  return JSON.stringify({
    open: true,
    root: {
      l: Math.round(rr.left), t: Math.round(rr.top), r: Math.round(rr.right), b: Math.round(rr.bottom),
      backdropFilter: cs.backdropFilter, background: cs.backgroundColor, position: cs.position,
      zIndex: cs.zIndex
    },
    bgAlpha: alphaOf(cs.backgroundColor),
    scrimAlpha,
    card: cr ? { t: Math.round(cr.top), b: Math.round(cr.bottom), l: Math.round(cr.left), w: Math.round(cr.width), center: Math.round(cr.left + cr.width / 2) } : null,
    cardBorder: ccs ? {
      top: ccs.borderTopWidth, right: ccs.borderRightWidth, bottom: ccs.borderBottomWidth, left: ccs.borderLeftWidth,
      color: ccs.borderTopColor, shadow: ccs.boxShadow
    } : null,
    cardSvgs: card ? card.querySelectorAll('svg').length : null,
    cardText: card ? {
      title: card.querySelector('h3') ? card.querySelector('h3').textContent.trim() : null,
      body: card.querySelector('p') ? card.querySelector('p').textContent.trim() : null,
      buttons: card.querySelectorAll('button').length
    } : null,
    cardFits: cr ? { insideVp: cr.bottom <= window.innerHeight + 0.5 && cr.left >= -0.5 && cr.right <= window.innerWidth + 0.5 } : null,
    buttonsInside: card ? Array.from(card.querySelectorAll('button')).every((b) => {
      const br = b.getBoundingClientRect()
      return br.top >= -0.5 && br.bottom <= window.innerHeight + 0.5 && br.left >= -0.5 && br.right <= window.innerWidth + 0.5
    }) : null,
    blurs,
    activeInside: !!active && root.contains(active),
    activeLabel: active ? (active.tagName + (active.getAttribute('data-triple-confirm') !== null ? '#confirm' : '') + (active.className && typeof active.className === 'string' ? '.' + active.className.split(/\\s+/)[0] : '')) : null,
    viewport: { w: window.innerWidth, h: window.innerHeight }
  })
})()`

/**
 * 页面侧：读入场动效那条 CSS 规则本身（`lm-prompt-drop-enter-from`）。
 *
 * 用户口径：「动效是该组件**从上方滑出**」—— 判据是 `transform: translateY(-Npx)`（自上而下）
 * 且**不是** `scale(...)`；顺带要求过渡只动 `transform`（不以淡入/缩放为主）。
 */
const DROP_MOTION = `(() => {
  const all = []
  const collect = (sheet) => {
    let rules = []
    try { rules = Array.from(sheet.cssRules || []) } catch (e) { return }
    for (const r of rules) {
      if (r.styleSheet) collect(r.styleSheet)
      else if (r.selectorText) all.push(r)
    }
  }
  for (const s of Array.from(document.styleSheets)) collect(s)
  const norm = (s) => String(s).replace(/\\s+/g, '')
  const from = all.find((r) => norm(r.selectorText).indexOf('.lm-prompt-drop-enter-from') >= 0)
  const active = all.find((r) => norm(r.selectorText).indexOf('.lm-prompt-drop-enter-active') >= 0)
  return JSON.stringify({
    fromFound: !!from,
    fromTransform: from ? from.style.getPropertyValue('transform') : null,
    fromOpacity: from ? from.style.getPropertyValue('opacity') : null,
    prop: active ? active.style.getPropertyValue('transition-property') : null,
    dur: active ? active.style.getPropertyValue('transition-duration') : null
  })
})()`

/** 页面侧：从当前焦点出发，连发 N 次 Tab（合成 keydown，走的是组件真实的 keydown 处理器） */
const TAB_TRAP = (sel, shift, times) => `(() => {
  const root = document.querySelector(${JSON.stringify(sel)})
  if (!root) return JSON.stringify({ open: false })
  const idOf = (el) => el ? (el.tagName + (el.className && typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/)[0] : '') + '|' + (el.textContent || '').trim().slice(0, 10)) : 'none'
  const seen = []
  for (let i = 0; i < ${times}; i++) {
    const from = document.activeElement
    if (!from) break
    from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: ${shift}, bubbles: true, cancelable: true }))
    const now = document.activeElement
    seen.push({ from: idOf(from), to: idOf(now), inside: !!now && root.contains(now) })
  }
  return JSON.stringify({ open: true, seen })
})()`

/**
 * 页面侧：找正文里一个「点在正文上」的探针坐标 + 该点的命中栈。
 *
 * 两个用途：
 *   * `topIsPrompt` —— 这一点最上面那层是不是提示（= 背景是命中目标，点击打不到编辑器）；
 *   * `proseUnderPoint` —— 提示掀掉之后这一点**确实压在 ProseMirror 上**（否则"点了不动光标"
 *     会退化成"点到了空白处"的假绿）。
 * 坐标避开卡片本身（卡片贴在顶部，正文中段通常在它下面）。
 */
const PROBE_POINT = `(() => {
  const root = document.querySelector('[data-top-prompt]')
  if (!root) return JSON.stringify({ missing: 'no-prompt' })
  const card = root.querySelector('.lm-prompt__card')
  const prose = document.querySelector('.ProseMirror') || document.querySelector('textarea.source-editor')
  if (!prose) return JSON.stringify({ missing: 'no-editor' })
  const pr = prose.getBoundingClientRect()
  const cr = card ? card.getBoundingClientRect() : { bottom: 0 }
  let x = Math.round(pr.left + Math.min(140, pr.width / 2))
  let y = Math.round(pr.top + Math.max(60, pr.height / 2))
  if (y < cr.bottom + 24) y = Math.round(cr.bottom + 40)
  if (y > pr.bottom - 12) y = Math.round(pr.bottom - 12)
  const stack = document.elementsFromPoint(x, y)
  const top = stack[0]
  return JSON.stringify({
    x, y,
    insideEditorRect: x > pr.left && x < pr.right && y > pr.top && y < pr.bottom,
    topIsPrompt: !!top && root.contains(top),
    proseUnderPoint: stack.some((el) => el === prose || prose.contains(el)),
    stack: stack.slice(0, 4).map((el) => (typeof el.className === 'string' && el.className ? el.className.split(/\\s+/)[0] : el.tagName))
  })
})()`

/** 页面侧：正文光标（ProseMirror 选区 + DOM 选区 + 正文内容）快照 */
const CARET = `(() => {
  const ed = window.__L.ed()
  const s = ed ? ed.state.selection : null
  const dom = window.getSelection()
  return JSON.stringify({
    from: s ? s.from : null,
    to: s ? s.to : null,
    domType: dom ? dom.type : null,
    domText: dom ? String(dom) : null,
    active: document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.className || '') : null,
    activeIsEditor: !!document.activeElement && document.activeElement.classList.contains('ProseMirror'),
    content: window.__L.files().current ? window.__L.files().current.content : null
  })
})()`

/** 页面侧：通知带内部布局（矩形关系 + 溢出 + 可访问名 + 触达区域） */
const NTF = `(() => {
  const item = document.querySelector('.ntf-item')
  if (!item) return JSON.stringify({ items: 0 })
  const strip = item.closest('.ntf-strip')
  const row = item.querySelector('.ntf-row')
  const content = item.querySelector('.ntf-content')
  const title = item.querySelector('.ntf-title')
  const body = item.querySelector('.ntf-body')
  const meta = item.querySelector('[data-ntf-meta]')
  const actions = item.querySelector('.ntf-actions')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight }
  }
  const itemR = rect(item)
  const overlap = (a, c) => !!a && !!c && a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b
  const buttons = Array.from(item.querySelectorAll('button')).map((b) => {
    const r = rect(b)
    return {
      name: (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 24),
      rect: r,
      inMeta: !!meta && meta.contains(b),
      inActions: !!actions && actions.contains(b),
      outsideItem: r.l < itemR.l || r.r > itemR.r || r.t < itemR.t || r.b > itemR.b,
      overflow: b.scrollWidth > b.clientWidth + 1
    }
  })
  return JSON.stringify({
    items: document.querySelectorAll('.ntf-item').length,
    itemRect: itemR,
    stripRect: rect(strip),
    rowDisplay: row ? getComputedStyle(row).display : null,
    rowCols: row ? getComputedStyle(row).gridTemplateColumns.split(' ').length : null,
    rowColGap: row ? parseFloat(getComputedStyle(row).columnGap) : null,
    titleRect: rect(title),
    titleLineHeight: title ? parseFloat(getComputedStyle(title).lineHeight) : null,
    titleWrap: title ? getComputedStyle(title).overflowWrap : null,
    titleText: title ? title.textContent.trim().slice(0, 60) : null,
    bodyRect: rect(body),
    bodyOverscrollY: body ? getComputedStyle(body).overscrollBehaviorY : null,
    bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
    metaRect: rect(meta),
    metaText: meta ? meta.textContent.trim() : '',
    actionsRect: rect(actions),
    contentRect: rect(content),
    firstParagraph: item.querySelector('p') ? item.querySelector('p').textContent.trim().slice(0, 60) : null,
    icons: item.querySelectorAll('svg').length,
    buttons,
    actionsOverlapContent: overlap(rect(actions), rect(content)),
    overflows: {
      item: item.scrollWidth > item.clientWidth + 1,
      title: title ? title.scrollWidth > title.clientWidth + 1 : null,
      body: body ? body.scrollWidth > body.clientWidth + 1 : null,
      meta: meta ? meta.scrollWidth > meta.clientWidth + 1 : null
    }
  })
})()`

/** 页面侧：通知带里所有按钮的矩形是否都落在通知矩形内（三语切换后重复量这个） */
const NTF_FITS = `(() => {
  const item = document.querySelector('.ntf-item')
  if (!item) return JSON.stringify({ items: 0 })
  const r = item.getBoundingClientRect()
  const body = item.querySelector('.ntf-body')
  const buttons = Array.from(item.querySelectorAll('button')).map((b) => {
    const br = b.getBoundingClientRect()
    return {
      name: (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim(),
      outside: br.left < r.left - 1 || br.right > r.right + 1 || br.top < r.top - 1 || br.bottom > r.bottom + 1,
      small: Math.round(br.width) < 24 || Math.round(br.height) < 24
    }
  })
  return JSON.stringify({
    items: document.querySelectorAll('.ntf-item').length,
    buttons,
    overflows: {
      title: (() => { const t = item.querySelector('.ntf-title'); return t ? t.scrollWidth > t.clientWidth + 1 : null })(),
      body: body ? body.scrollWidth > body.clientWidth + 1 : null,
      meta: (() => { const m = item.querySelector('[data-ntf-meta]'); return m ? m.scrollWidth > m.clientWidth + 1 : null })()
    },
    closeName: (() => {
      const m = item.querySelector('[data-ntf-meta]')
      const bs = m ? Array.from(m.querySelectorAll('button')) : []
      const last = bs[bs.length - 1]
      return last ? (last.getAttribute('aria-label') || last.getAttribute('title') || '').trim() : null
    })(),
    actionNames: Array.from(item.querySelectorAll('.ntf-actions button')).map((b) => b.textContent.trim())
  })
})()`

const LONG_TOKEN = 'A'.repeat(200)
const LONG_NAME = 'LONGMARK-' + LONG_TOKEN + '.md'

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('顶部提示条（alert 式）与通知内部布局')
  // ⚠️ Reporter 的方法内部用 `this.lines`：解构出来直接调用会丢 this（第一版就是这么红的）
  const check = report.check.bind(report)
  const skip = report.skip.bind(report)
  const note = report.note.bind(report)

  // ── 准备：打开一份真文档（有 ProseMirror 才有"光标动不动"可量）──────────────
  await openDocWith(app, '# 顶部提示\n\n第一段正文，用来量光标。\n\n第二段正文。\n', 'prompt-top.md')
  if (!(await waitEditor(ev))) throw new Error('编辑器没挂上')
  await sleep(400)
  const focused = await ensureFocus(app)
  note('被测窗口拿到 OS 焦点 = ' + focused)

  // ═══ A. 顶部提示条（ModalHost 的确认框）═══════════════════════════════════
  // 先在正文里放一个**明确的**光标位置：等下那次真实点击若真打到了正文，它一定会被挪走。
  await ev(`(() => { const ed = window.__L.ed(); ed.commands.setTextSelection(6); return 'ok' })()`)
  await sleep(200)
  // 打开时把 Promise 的**结果**记进 window（返回值语义是数据安全路径，必须逐条钉住）
  await ev(`(() => {
    window.__PROBE_CONFIRM = 'pending'
    window.__L.ui().confirm({ title: '顶部提示探针', body: '这是一条用于量取顶部提示条形态的临时确认框。' }).then((v) => { window.__PROBE_CONFIRM = String(v) })
    return 'ok'
  })()`)
  await sleep(500)

  let p = JSON.parse(await ev(PROMPT('[data-top-prompt]')))
  note('prompt ' + JSON.stringify(p))
  check('prompt-renders', p.open === true && !!p.card, JSON.stringify(p).slice(0, 120))
  // 第二轮口径：**不再透明**，但只"稍稍"压暗 —— alpha 必须 > 0 且 < --scrim 全量；模糊一律不许有
  check(
    'prompt-dim-is-light-and-blurless',
    p.open === true &&
      p.blurs.length === 0 &&
      p.root.backdropFilter === 'none' &&
      p.bgAlpha > 0 &&
      p.scrimAlpha > 0 &&
      p.bgAlpha < p.scrimAlpha,
    JSON.stringify({ blurs: p.blurs, backdropFilter: p.root && p.root.backdropFilter, bg: p.root && p.root.background, bgAlpha: p.bgAlpha, scrimAlpha: p.scrimAlpha })
  )
  // 第二轮口径（用户原话）："这个新的提示上边框会有黑边框，请取消" —— 四个方向都必须是 0
  check(
    'prompt-card-has-no-border',
    !!p.cardBorder && p.cardBorder.top === '0px' && p.cardBorder.right === '0px' && p.cardBorder.bottom === '0px' && p.cardBorder.left === '0px',
    JSON.stringify(p.cardBorder)
  )
  // 第二轮口径："取消这个提示上面的带有花哨图案的图标" —— 卡片里一个 svg 都不许有，标题/描述/按钮仍在
  check(
    'prompt-card-has-no-icon-but-keeps-text-and-actions',
    p.cardSvgs === 0 && !!p.cardText && !!p.cardText.title && !!p.cardText.body && p.cardText.buttons >= 2,
    JSON.stringify({ svgs: p.cardSvgs, text: p.cardText })
  )
  // 第二轮口径："出现在**中上方**的位置" —— 判据是 0.10~0.25 × 视口高（不是贴顶、也不是居中）
  check(
    'prompt-card-in-the-upper-middle',
    !!p.card && p.card.t >= 0.1 * p.viewport.h && p.card.t <= 0.25 * p.viewport.h,
    'card.top=' + (p.card && p.card.t) + 'px / 视口高 ' + p.viewport.h + '（判据 0.10~0.25×高 = ' + Math.round(0.1 * p.viewport.h) + '~' + Math.round(0.25 * p.viewport.h) + 'px）'
  )
  check(
    'prompt-card-centered',
    !!p.card && Math.abs(p.card.center - p.viewport.w / 2) <= 2,
    JSON.stringify({ center: p.card && p.card.center, half: p.viewport && p.viewport.w / 2 })
  )
  check('prompt-focus-inside', p.activeInside === true, 'activeElement=' + p.activeLabel)
  check(
    'prompt-backdrop-covers-viewport',
    !!p.root && p.root.position === 'fixed' && p.root.l === 0 && p.root.t === 0 && p.root.r === p.viewport.w && p.root.b === p.viewport.h,
    JSON.stringify({ root: p.root, viewport: p.viewport }) + ' —— 轻微压暗但仍是命中目标：背景连滚动都不通（与浏览器 alert 一致）'
  )
  // 第二轮口径："动效是该组件**从上方滑出**" —— 读入场规则本身：translateY(-N) 且不是 scale，
  // 过渡只动 transform（不以淡入为主）
  const motion = JSON.parse(await ev(DROP_MOTION))
  note('drop-motion ' + JSON.stringify(motion))
  check(
    'prompt-entry-slides-down-from-above',
    motion.fromFound === true &&
      /translateY\(-\s*[\d.]+px\)/.test(String(motion.fromTransform)) &&
      !/scale/.test(String(motion.fromTransform)) &&
      String(motion.prop).replace(/\s+/g, '') === 'transform',
    JSON.stringify(motion)
  )

  // Tab 序被限制在提示内：连发 8 次 Tab（含 Shift+Tab）都不许跑出去，且必须真的在动
  const trap = JSON.parse(await ev(TAB_TRAP('[data-top-prompt]', false, 8)))
  const trapShift = JSON.parse(await ev(TAB_TRAP('[data-top-prompt]', true, 8)))
  const trapAll = [...(trap.seen || []), ...(trapShift.seen || [])]
  check(
    'prompt-tab-trapped',
    trap.open === true && trapAll.length >= 8 && trapAll.every((s) => s.inside === true),
    JSON.stringify(trapAll.filter((s) => !s.inside))
  )
  check(
    'prompt-tab-moves-focus',
    new Set(trapAll.map((s) => s.to)).size >= 2,
    JSON.stringify([...new Set(trapAll.map((s) => s.to))])
  )
  // 焦点仍要在提示里（Tab 段跑完不能把它留在外面）
  p = JSON.parse(await ev(PROMPT('[data-top-prompt]')))
  check('prompt-focus-still-inside-after-tab', p.activeInside === true, 'activeElement=' + p.activeLabel)

  // ── 「不许改行为语义」：回车 / Esc 与改前完全一致 ──────────────────────────
  // 焦点落在**容器**上（不是某个按钮）就是为了这条：改前焦点不在提示里，回车什么也不做；
  // 落在按钮上会让回车"顺手"激活它（三选一里第一个按钮是「取消」、关窗场景里可能是「保存」）。
  await ev(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(250)
  check(
    'prompt-enter-does-not-answer',
    (await ev(`!!window.__L.ui().confirmState`)) === true && (await ev(`window.__PROBE_CONFIRM`)) === 'pending',
    '回车不许替用户作答：confirmState=' + JSON.stringify(await ev(`!!window.__L.ui().confirmState`)) + ' result=' + JSON.stringify(await ev(`window.__PROBE_CONFIRM`))
  )
  // Esc = 取消（返回值 false），与改前一致
  await ev(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  const escConfirm = await ev(`window.__PROBE_CONFIRM`)
  check(
    'prompt-escape-cancels-with-false',
    escConfirm === 'false',
    'Esc 的返回值 = ' + JSON.stringify(escConfirm) + '（必须仍是 false）'
  )
  // ★ 第二轮口径：**Esc 必须与可见的「取消」按钮返回完全相同的值**（键盘可达性的最低要求：
  //   焦点被困在提示里时，键盘用户至少要有一条出路）。这里真的点一次那个按钮去对答案。
  await ev(`(() => {
    window.__PROBE_CONFIRM_BTN = 'pending'
    window.__L.ui().confirm({ title: '顶部提示-取消按钮对照', body: '用来比对 Esc 与「取消」的返回值。' }).then((v) => { window.__PROBE_CONFIRM_BTN = String(v) })
    return 'ok'
  })()`)
  await sleep(400)
  await ev(`(() => {
    const card = document.querySelector('[data-top-prompt] .lm-prompt__card')
    const btns = Array.from(card.querySelectorAll('button'))
    const cancel = btns.find((b) => b.getAttribute('data-triple-cancel') !== null) || btns[0]
    cancel.click()
    return 'ok'
  })()`)
  await sleep(300)
  const btnConfirm = await ev(`window.__PROBE_CONFIRM_BTN`)
  check(
    'prompt-escape-equals-the-cancel-button',
    escConfirm === 'false' && btnConfirm === escConfirm,
    'Esc=' + JSON.stringify(escConfirm) + ' vs 「取消」按钮=' + JSON.stringify(btnConfirm)
  )

  // ── 点正文：背景 inert（真的发一次鼠标点击）──────────────────────────────
  // ⚠️ 顺序：先**开**提示，再挂 capture 计数器 —— 反过来的话上一段刚关掉的提示已经不在 DOM 里，
  //    `querySelector` 会 null（第一版就是这么红的：ERROR Cannot read properties of null）。
  await ev(`(() => {
    window.__PROBE_CONFIRM2 = 'pending'
    window.__L.ui().confirm({ title: '顶部提示探针 2', body: '用来验"点正文不改光标 + 点别处不取消"。' }).then((v) => { window.__PROBE_CONFIRM2 = String(v) })
    return 'ok'
  })()`)
  await sleep(400)
  const counterAttached = await ev(`(() => {
    window.__OUTSIDE_CLICKS = 0
    const root = document.querySelector('[data-top-prompt]')
    if (!root) return 'no-root'
    root.addEventListener('click', () => { window.__OUTSIDE_CLICKS += 1 }, { capture: true })
    return 'ok'
  })()`)
  check('prompt-outside-click-counter-attached', counterAttached === 'ok', String(counterAttached))
  const pt = JSON.parse(await ev(PROBE_POINT))
  note('probe-point ' + JSON.stringify(pt))
  check(
    'prompt-covers-the-editor-under-the-pointer',
    !pt.missing && pt.insideEditorRect === true && pt.proseUnderPoint === true && pt.topIsPrompt === true,
    JSON.stringify(pt)
  )
  const before = JSON.parse(await ev(CARET))
  if (!pt.missing) await clickAt(app.send, pt.x, pt.y)
  await sleep(400)
  const after = JSON.parse(await ev(CARET))
  check(
    'prompt-click-does-not-move-the-caret',
    before.from !== null && before.from === after.from && before.to === after.to && before.domText === after.domText,
    JSON.stringify({ before: { from: before.from, to: before.to, dom: before.domText }, after: { from: after.from, to: after.to, dom: after.domText } })
  )
  check(
    'prompt-click-does-not-edit-content',
    before.content === after.content,
    JSON.stringify({ same: before.content === after.content })
  )
  // ★ 第二轮口径变更（用户原话：**不可点击其他地方取消这个提示，只能通过按上面的按钮操作**）：
  //   以前这一条是 `prompt-outside-click-still-cancels`（点别处 = 取消）。现在反过来，而且断言
  //   **更强**：① 那次点击真的送到了提示层（capture 计数器 = 1，投递凭证）；② 提示仍在、
  //   两个 Promise 仍是 pending（没有任何"静默取消"）；③ DOM 里那层还在。
  const outsideClicks = await ev(`window.__OUTSIDE_CLICKS`)
  const stillOpen = await ev(`!!window.__L.ui().confirmState && !!document.querySelector('[data-top-prompt]')`)
  const stillPending = await ev(`window.__PROBE_CONFIRM2 === 'pending'`)
  check(
    'prompt-outside-click-no-longer-cancels',
    outsideClicks === 1 && stillOpen === true && stillPending === true,
    JSON.stringify({ deliveredClicks: outsideClicks, stillOpen, stillPending, result: await ev(`window.__PROBE_CONFIRM2`) })
  )

  // 收尾：这次探针的提示只能由**显式动作**关掉（点别处已经不帮我们关了）
  await ev(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  check(
    'prompt-closed-only-by-explicit-action',
    (await ev(`window.__PROBE_CONFIRM2`)) === 'false' && (await ev(`!!window.__L.ui().confirmState`)) === false,
    '点别处之后提示仍在，只有 Esc / 按钮能收掉它：result=' + JSON.stringify(await ev(`window.__PROBE_CONFIRM2`))
  )

  // ── 三选一（**关窗「保存 / 不保存 / 取消」**那条路径）也是同一套顶部形态 ──────
  // 三条路径共用一个组件，所以关窗这条必须一起量：Esc 的返回值仍然是 'cancel'
  //（数据安全：关窗场景里唯一安全的默认是"不关窗"）。
  await ev(`(() => {
    window.__PROBE_TRIPLE = 'pending'
    window.__L.ui().confirmTriple({ title: '是否保存更改？', body: '如果不保存，您的更改将会丢失。', confirmLabel: '保存', altLabel: '不保存' }).then((v) => { window.__PROBE_TRIPLE = String(v) })
    return 'ok'
  })()`)
  await sleep(500)
  const t3 = JSON.parse(await ev(PROMPT('[data-triple="true"]')))
  const t3btns = JSON.parse(await ev(`(() => JSON.stringify({
    confirm: !!document.querySelector('[data-triple-confirm]'),
    alt: !!document.querySelector('[data-triple-alt]'),
    cancel: !!document.querySelector('[data-triple-cancel]')
  }))()`))
  note('triple ' + JSON.stringify(t3).slice(0, 200))
  check(
    'triple-prompt-shares-the-top-shape',
    t3.open === true &&
      t3.blurs.length === 0 &&
      t3.root.backdropFilter === 'none' &&
      t3.bgAlpha > 0 &&
      t3.bgAlpha < t3.scrimAlpha &&
      !!t3.cardBorder &&
      t3.cardBorder.top === '0px' &&
      t3.cardBorder.left === '0px' &&
      t3.cardSvgs === 0 &&
      !!t3.card &&
      t3.card.t >= 0.1 * t3.viewport.h &&
      t3.card.t <= 0.25 * t3.viewport.h &&
      t3.activeInside === true,
    JSON.stringify({ card: t3.card, blurs: t3.blurs, active: t3.activeLabel, bgAlpha: t3.bgAlpha, scrimAlpha: t3.scrimAlpha, border: t3.cardBorder && t3.cardBorder.top, svgs: t3.cardSvgs })
  )
  check(
    'triple-prompt-keeps-its-three-buttons',
    t3btns.confirm === true && t3btns.alt === true && t3btns.cancel === true,
    JSON.stringify(t3btns)
  )
  await ev(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  const escTriple = await ev(`window.__PROBE_TRIPLE`)
  check(
    'triple-escape-still-means-cancel',
    escTriple === 'cancel',
    'Esc 的返回值 = ' + JSON.stringify(escTriple) + '（关窗场景必须是 cancel = 不关窗）'
  )
  // ★ 第二轮口径：Esc 与可见的「取消」按钮必须**返回值完全相同**（这条在关窗路径上逐字量）
  await ev(`(() => {
    window.__PROBE_TRIPLE_BTN = 'pending'
    window.__L.ui().confirmTriple({ title: '是否保存更改？', body: '对照「取消」按钮。', confirmLabel: '保存', altLabel: '不保存' }).then((v) => { window.__PROBE_TRIPLE_BTN = String(v) })
    return 'ok'
  })()`)
  await sleep(400)
  await ev(`(() => { document.querySelector('[data-triple-cancel]').click(); return 'ok' })()`)
  await sleep(300)
  const btnTriple = await ev(`window.__PROBE_TRIPLE_BTN`)
  check(
    'triple-escape-equals-the-cancel-button',
    escTriple === 'cancel' && btnTriple === escTriple,
    'Esc=' + JSON.stringify(escTriple) + ' vs 「取消」按钮=' + JSON.stringify(btnTriple)
  )

  // ── 输入框那一路（同一个组件、同一条顶部提示条）：焦点在输入框、回车仍提交、Esc 仍返回 null ──
  await ev(`(() => {
    window.__PROBE_PROMPT = 'pending'
    window.__L.ui().prompt('顶部提示-输入探针', '占位', 'init').then((v) => { window.__PROBE_PROMPT = String(v) })
    return 'ok'
  })()`)
  await sleep(500)
  const pi = JSON.parse(await ev(PROMPT('[data-top-prompt]')))
  check(
    'input-prompt-shares-the-top-shape',
    pi.open === true &&
      pi.blurs.length === 0 &&
      pi.bgAlpha > 0 &&
      pi.bgAlpha < pi.scrimAlpha &&
      !!pi.cardBorder &&
      pi.cardBorder.top === '0px' &&
      pi.cardSvgs === 0 &&
      !!pi.card &&
      pi.card.t >= 0.1 * pi.viewport.h &&
      pi.card.t <= 0.25 * pi.viewport.h &&
      pi.activeInside === true,
    JSON.stringify({ card: pi.card, bgAlpha: pi.bgAlpha, scrimAlpha: pi.scrimAlpha, border: pi.cardBorder && pi.cardBorder.top, svgs: pi.cardSvgs, active: pi.activeLabel })
  )
  check(
    'input-prompt-focuses-the-input',
    (await ev(`document.activeElement === document.querySelector('[data-prompt-input]')`)) === true,
    'activeElement=' + (await ev(`document.activeElement && document.activeElement.tagName`))
  )
  // v-model 要真的走一遍（合成 input 事件），再按回车 → 返回值必须是 trim 过的 'hello'
  await ev(`(() => {
    const el = document.querySelector('[data-prompt-input]')
    el.value = '  hello  '
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  await sleep(300)
  check(
    'input-prompt-enter-still-submits-trimmed',
    (await ev(`window.__PROBE_PROMPT`)) === 'hello',
    '回车的返回值 = ' + JSON.stringify(await ev(`window.__PROBE_PROMPT`)) + '（必须仍是 trim 后的值）'
  )
  await ev(`(() => {
    window.__PROBE_PROMPT2 = 'pending'
    window.__L.ui().prompt('顶部提示-输入探针 2', '占位').then((v) => { window.__PROBE_PROMPT2 = String(v) })
    return 'ok'
  })()`)
  await sleep(400)
  await ev(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  const escPrompt = await ev(`window.__PROBE_PROMPT2`)
  check(
    'input-prompt-escape-still-returns-null',
    escPrompt === 'null',
    'Esc 的返回值 = ' + JSON.stringify(escPrompt) + '（必须仍是 null）'
  )
  // ★ 第二轮口径：Esc 与可见的「取消」按钮返回值相同（输入框那一路也逐字量）
  await ev(`(() => {
    window.__PROBE_PROMPT3 = 'pending'
    window.__L.ui().prompt('顶部提示-输入探针 3', '占位').then((v) => { window.__PROBE_PROMPT3 = String(v) })
    return 'ok'
  })()`)
  await sleep(400)
  await ev(`(() => {
    const card = document.querySelector('[data-top-prompt] .lm-prompt__card')
    card.querySelectorAll('button')[0].click()
    return 'ok'
  })()`)
  await sleep(300)
  const btnPrompt = await ev(`window.__PROBE_PROMPT3`)
  check(
    'input-prompt-escape-equals-the-cancel-button',
    escPrompt === 'null' && btnPrompt === escPrompt,
    'Esc=' + JSON.stringify(escPrompt) + ' vs 「取消」按钮=' + JSON.stringify(btnPrompt)
  )

  // ── 草稿提示（「比磁盘新」那条路径）改用同一套顶部形态 ─────────────────────
  await ev(`(() => { window.__L.files().draftRestore = { key: 'verify-top-prompt-probe', path: null, content: 'x', mtimeMs: Date.now() }; return 'ok' })()`)
  await sleep(600)
  let d = JSON.parse(await ev(PROMPT('.draft-modal')))
  note('draft ' + JSON.stringify(d))
  check('draft-prompt-renders', d.open === true && !!d.card, JSON.stringify(d).slice(0, 120))
  check(
    'draft-prompt-dim-is-light-and-blurless',
    d.open === true && d.blurs.length === 0 && d.root.backdropFilter === 'none' && d.bgAlpha > 0 && d.bgAlpha < d.scrimAlpha,
    JSON.stringify({ blurs: d.blurs, backdropFilter: d.root && d.root.backdropFilter, bg: d.root && d.root.background, bgAlpha: d.bgAlpha, scrimAlpha: d.scrimAlpha })
  )
  check(
    'draft-prompt-card-has-no-border-and-no-icon',
    !!d.cardBorder && d.cardBorder.top === '0px' && d.cardBorder.right === '0px' && d.cardBorder.bottom === '0px' && d.cardBorder.left === '0px' && d.cardSvgs === 0 &&
      !!d.cardText && !!d.cardText.title && !!d.cardText.body && d.cardText.buttons >= 2,
    JSON.stringify({ border: d.cardBorder, svgs: d.cardSvgs, text: d.cardText })
  )
  check(
    'draft-prompt-card-in-the-upper-middle',
    !!d.card && d.card.t >= 0.1 * d.viewport.h && d.card.t <= 0.25 * d.viewport.h,
    'card.top=' + (d.card && d.card.t) + 'px / 视口高 ' + d.viewport.h
  )
  check('draft-prompt-focus-inside', d.activeInside === true, 'activeElement=' + d.activeLabel)
  const dTrap = JSON.parse(await ev(TAB_TRAP('.draft-modal', false, 6)))
  check(
    'draft-prompt-tab-trapped',
    dTrap.open === true && (dTrap.seen || []).length >= 6 && dTrap.seen.every((s) => s.inside === true) && new Set(dTrap.seen.map((s) => s.to)).size >= 2,
    JSON.stringify(dTrap.seen)
  )
  // ★ 第二轮口径的边界（**故意保留**）：草稿提示的 Esc 仍然被吞掉（既有断言 `modal-esc-does-not-close`
  //   在 `_verify-draft-banner.js` 里守着）。理由：它那两个出口是「恢复 / 丢弃」，**没有**一个
  //   语义等于"取消"（Esc 无法与任何按钮返回同一个值），而且这里必须明确选一个。
  //   键盘用户的出路仍在：Tab 到按钮 + 回车/空格（见上面那条 Tab 环断言）。
  await ev(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  check(
    'draft-prompt-escape-still-does-not-choose',
    (await ev(`!!document.querySelector('.draft-modal')`)) === true && (await ev(`!!window.__L.files().draftRestore`)) === true,
    '草稿提示的 Esc 不许替用户选（它没有与 Esc 同值的按钮）'
  )
  // 两个提示都要能被**同一个**语义锚点找到（`data-top-prompt`），否则套件早晚各写一套选择器
  check(
    'both-prompts-share-the-semantic-anchor',
    (await ev(`!!document.querySelector('[data-top-prompt].draft-modal')`)) === true,
    '草稿提示的根也要带 data-top-prompt'
  )
  await ev(`(async () => { await window.__L.files().applyDraftRestore(false); return 'ok' })()`)
  await sleep(500)

  // ── 窄窗（760×520，= 本仓库的最小窗口）：中上方的位置与卡片/按钮都还落得下 ────
  await app.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  await ev(`(() => {
    window.__PROBE_NARROW = 'pending'
    window.__L.ui().confirm({ title: '窄窗探针', body: '760×520 下量位置与按钮是否还在视口里。' }).then((v) => { window.__PROBE_NARROW = String(v) })
    return 'ok'
  })()`)
  await sleep(500)
  const narrow = JSON.parse(await ev(PROMPT('[data-top-prompt]')))
  note('narrow ' + JSON.stringify({ vp: narrow.viewport, card: narrow.card, fits: narrow.cardFits, inside: narrow.buttonsInside }))
  check(
    'narrow-760x520-card-in-the-upper-middle-and-fits',
    narrow.open === true &&
      narrow.viewport.w === 760 &&
      narrow.viewport.h === 520 &&
      !!narrow.card &&
      narrow.card.t >= 0.1 * narrow.viewport.h &&
      narrow.card.t <= 0.25 * narrow.viewport.h &&
      !!narrow.cardFits &&
      narrow.cardFits.insideVp === true &&
      narrow.buttonsInside === true,
    JSON.stringify({ vp: narrow.viewport, card: narrow.card, fits: narrow.cardFits, buttonsInside: narrow.buttonsInside })
  )
  await ev(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'ok' })()`)
  await sleep(300)
  await app.send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)

  // ═══ B. 通知内部布局 ═════════════════════════════════════════════════════
  // 两条通知：一条普通、一条**超长不可折行文件名 + 长路径**（最坏情况），并带一个操作按钮。
  await ev(`(async () => {
    const n = window.__L.notifications()
    await n.notify({ level: 'info', title: '普通通知', body: '用来占一条，顺带让步进器出现。' })
    await n.notify({
      level: 'warning',
      title: ${JSON.stringify(LONG_NAME)},
      body: 'C:\\\\' + ${JSON.stringify('verylongsegment\\\\'.repeat(12))} + ${JSON.stringify(LONG_TOKEN)},
      actions: [{ id: 'undo', label: '撤销', tone: 'primary' }]
    })
    return 'ok'
  })()`)
  await sleep(900)

  let ntf = JSON.parse(await ev(NTF))
  note('ntf ' + JSON.stringify(ntf))
  check('ntf-renders-with-long-title', ntf.items === 1 && !!ntf.itemRect, 'items=' + ntf.items)
  check(
    'ntf-first-paragraph-is-still-the-title',
    typeof ntf.firstParagraph === 'string' && ntf.firstParagraph.indexOf('LONGMARK-') === 0,
    '第一条 p = ' + ntf.firstParagraph + '（套件锚点：标题必须是通知里的第一个 p）'
  )
  check(
    'ntf-time-still-leads-the-meta',
    /^\d{1,2}:\d{2}/.test(String(ntf.metaText)),
    'meta=' + ntf.metaText
  )
  check(
    'ntf-long-title-wraps-instead-of-overflowing',
    !!ntf.overflows &&
      ntf.overflows.title === false &&
      !!ntf.titleRect &&
      ntf.titleRect.sh > ntf.titleLineHeight + 1 &&
      ntf.titleWrap === 'anywhere',
    JSON.stringify({ overflow: ntf.overflows && ntf.overflows.title, scrollH: ntf.titleRect && ntf.titleRect.sh, lineHeight: ntf.titleLineHeight, overflowWrap: ntf.titleWrap })
  )
  check(
    'ntf-long-body-and-meta-do-not-overflow',
    !!ntf.overflows && ntf.overflows.body === false && ntf.overflows.meta === false && ntf.overflows.item === false,
    JSON.stringify(ntf.overflows)
  )
  check(
    'ntf-buttons-inside-the-item',
    Array.isArray(ntf.buttons) && ntf.buttons.length >= 2 && ntf.buttons.every((b) => b.outsideItem === false && b.overflow === false),
    JSON.stringify((ntf.buttons || []).map((b) => ({ n: b.name, out: b.outsideItem, ov: b.overflow })))
  )
  check(
    'ntf-buttons-do-not-overlap-the-text',
    ntf.actionsOverlapContent === false,
    JSON.stringify({ actions: ntf.actionsRect, content: ntf.contentRect })
  )
  check(
    'ntf-buttons-are-big-enough',
    Array.isArray(ntf.buttons) && ntf.buttons.length >= 2 && ntf.buttons.every((b) => b.rect.w >= 24 && b.rect.h >= 24),
    JSON.stringify((ntf.buttons || []).map((b) => b.name + '=' + b.rect.w + 'x' + b.rect.h))
  )
  check(
    'ntf-action-column-is-grouped-right',
    !!ntf.actionsRect && !!ntf.contentRect && ntf.actionsRect.l >= ntf.contentRect.r - 1 && ntf.rowCols === 2 && ntf.rowColGap >= 16,
    JSON.stringify({ actionsLeft: ntf.actionsRect && ntf.actionsRect.l, contentRight: ntf.contentRect && ntf.contentRect.r, cols: ntf.rowCols, gap: ntf.rowColGap })
  )
  check(
    'ntf-buttons-carry-accessible-names',
    Array.isArray(ntf.buttons) && ntf.buttons.length >= 2 && ntf.buttons.every((b) => b.name.length > 0),
    JSON.stringify((ntf.buttons || []).map((b) => b.name))
  )
  check(
    'ntf-long-body-scrolls-in-place',
    ntf.bodyOverflowY === 'auto' && ntf.bodyOverscrollY === 'contain',
    JSON.stringify({ overflowY: ntf.bodyOverflowY, overscrollBehaviorY: ntf.bodyOverscrollY })
  )

  // 三语：切过去等可访问名真的变了，再量一回（按钮/正文都不许溢出）
  const langs = ['en-US', 'ru-RU', 'zh-CN']
  for (const lang of langs) {
    const before = await ev(`(() => { const m = document.querySelector('[data-ntf-meta]'); const bs = m ? Array.from(m.querySelectorAll('button')) : []; const last = bs[bs.length - 1]; return last ? (last.getAttribute('aria-label') || '') : null })()`)
    await ev(`window.__L.settings().set('language', ${JSON.stringify(lang)})`)
    let after = before
    for (let i = 0; i < 40 && after === before; i++) {
      await sleep(150)
      after = await ev(`(() => { const m = document.querySelector('[data-ntf-meta]'); const bs = m ? Array.from(m.querySelectorAll('button')) : []; const last = bs[bs.length - 1]; return last ? (last.getAttribute('aria-label') || '') : null })()`)
    }
    const fits = JSON.parse(await ev(NTF_FITS))
    note(lang + ' ' + JSON.stringify(fits))
    check(
      'ntf-i18n-' + lang + '-no-overflow',
      fits.items === 1 && !!fits.overflows && fits.overflows.title === false && fits.overflows.body === false && fits.overflows.meta === false,
      JSON.stringify({ overflows: fits.overflows, close: fits.closeName })
    )
    check(
      'ntf-i18n-' + lang + '-buttons-fit-and-named',
      Array.isArray(fits.buttons) && fits.buttons.length >= 2 && fits.buttons.every((b) => b.outside === false && b.small === false && b.name.length > 0) && !!fits.closeName,
      JSON.stringify({ buttons: (fits.buttons || []).map((b) => b.name), close: fits.closeName })
    )
  }

  // 复原：把探针通知关掉，别把带子留给后面的段
  await ev(`(async () => { await window.__L.notifications().closeAll(); return 'ok' })()`)
  await sleep(600)

  // ═══ C. 不影响其他实例（窗口 A 的提示不阻塞窗口 B）══════════════════════════
  const seen = new Set((await listTargets()).filter(isAppPage).map((t) => t.id))
  await ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  let bApp = null
  for (let i = 0; i < 80 && !bApp; i++) {
    await sleep(300)
    const fresh = (await listTargets()).filter(isAppPage).find((t) => !seen.has(t.id))
    if (fresh) {
      bApp = await attach(fresh)
      if (!(await settle(bApp.ev))) {
        bApp.close()
        bApp = null
        throw new Error('B 窗口没进入就绪状态')
      }
    }
  }
  if (!bApp) {
    check('multi-window-B-available', false, '新窗口没出现（luminAPI.app.newWindow 没生效？）')
  } else {
    check('multi-window-B-available', true, 'B 窗口已就绪')
    await openDocWith({ ev: bApp.ev }, '# B 窗口\n\nB 的正文一段。\n', 'b-window.md')
    await sleep(600)
    // B 里先放一个明确的光标位置
    await bApp.ev(`(() => { const ed = window.__L.ed(); ed.commands.setTextSelection(4); return 'ok' })()`)
    // A 打开提示
    await ev(`(() => { window.__L.ui().confirm({ title: 'A 窗口的提示', body: 'A 的提示不该影响 B。' }); return 'ok' })()`)
    await sleep(500)
    const aState = JSON.parse(await ev(PROMPT('[data-top-prompt]')))
    const bDom = JSON.parse(await bApp.ev(`(() => JSON.stringify({
      promptDom: !!document.querySelector('[data-top-prompt], .lm-prompt, .draft-modal'),
      confirmState: !!window.__L.ui().confirmState,
      editable: !!window.__L.ed() && window.__L.ed().isEditable === true
    }))()`))
    note('A ' + JSON.stringify(aState.card) + ' / B ' + JSON.stringify(bDom))
    check('multi-window-A-has-the-prompt', aState.open === true, JSON.stringify(aState.card))
    check(
      'multi-window-B-has-no-prompt',
      bDom.promptDom === false && bDom.confirmState === false,
      JSON.stringify(bDom)
    )
    check('multi-window-B-editor-still-editable', bDom.editable === true, JSON.stringify(bDom))

    // B 的真实鼠标点击：光标必须真的动（B 的正文没被 A 的提示挡住）
    await ensureFocus(bApp)
    const bPt = JSON.parse(await bApp.ev(`(() => {
      const prose = document.querySelector('.ProseMirror') || document.querySelector('textarea.source-editor')
      if (!prose) return JSON.stringify({ missing: 'no-editor' })
      const r = prose.getBoundingClientRect()
      const x = Math.round(r.left + Math.min(160, r.width / 2))
      const y = Math.round(r.top + Math.max(60, r.height / 2))
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, topIsEditor: !!top && (top === prose || prose.contains(top)) })
    })()`))
    const bBefore = JSON.parse(await bApp.ev(CARET))
    if (!bPt.missing) await clickAt(bApp.send, bPt.x, bPt.y)
    await sleep(400)
    const bAfter = JSON.parse(await bApp.ev(CARET))
    check(
      'multi-window-B-pointer-not-blocked',
      !bPt.missing &&
        bPt.topIsEditor === true &&
        bAfter.activeIsEditor === true &&
        (bBefore.from !== bAfter.from || bBefore.active !== bAfter.active),
      JSON.stringify({ pt: bPt, from: [bBefore.from, bAfter.from], active: [bBefore.active, bAfter.active] })
    )
    // A 的提示不许被 B 的操作关掉
    check(
      'multi-window-A-prompt-untouched-by-B',
      (await ev(`!!window.__L.ui().confirmState`)) === true && (await ev(`!!document.querySelector('[data-top-prompt]')`)) === true,
      'B 操作之后 A 的 confirmState 仍在'
    )
    // B 还能打字（真实按键/输入）：送不进去就如实 SKIP（这是环境，不是缺陷）
    await bApp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Z', code: 'KeyZ', text: 'Z', windowsVirtualKeyCode: 90 })
    await bApp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
    await sleep(400)
    const bTyped = await bApp.ev(`(window.__L.files().current ? window.__L.files().current.content : '').indexOf('Z') >= 0`)
    if (bTyped === true) {
      check('multi-window-B-can-be-edited', true, 'B 的正文收到了真实按键')
    } else {
      skip('multi-window-B-can-be-edited', '真实按键没能送达 B（窗口不在 OS 前台时 CDP 输入会丢）—— 环境问题，不是缺陷')
    }
    // A 的正文仍是原样（A 的提示拦住了输入）
    const aContent = await ev(`window.__L.files().current ? window.__L.files().current.content : ''`)
    check('multi-window-A-content-untouched', aContent.indexOf('Z') < 0, JSON.stringify(aContent.slice(0, 40)))
    await ev(`(() => { const ui = window.__L.ui(); if (ui.confirmState) ui.resolveConfirm(false); return 'ok' })()`)
    await sleep(300)
    await bApp.send('Page.close').catch(() => {})
    bApp.close()
    await sleep(800)
  }

  // 收尾：把语言与设置还原（隔离实例用完即弃，但别让同一实例里的后续断言踩到）
  await ev(`window.__L.settings().set('language', 'zh-CN')`)
  app.close()
  return report.finish()
}
main()
  .then((code) => process.exit(code))
  .catch(fatal)
