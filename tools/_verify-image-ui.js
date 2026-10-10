'use strict'
// ─── 验收（第五十三轮）：图片居中 / 源码标记四态 / 悬浮工具栏 / 缩放持久化 / 无占位图标 ──
//
// 只断言**本轮新增**的五件事：
//   ① 图片居中（img 的 rect 中心 ≈ 内容区中心，给数值）
//   ② 源码标记**四态**：点图片 ⇒ 上方源码行出现且内容 == 该图源码；点别处 ⇒ 消失；
//      选区**完全包住** ⇒ 不显示；选区边界**切进** ⇒ 显示
//   ③ 悬浮工具栏出现、档位齐全、与源码行 rect **不相交**
//   ④ 点 50% ⇒ 该段源码逐字节等于 `<img src="URL" style="zoom:50%;" />`、图片仍渲染、往返仍是这段 HTML；
//      已是 HTML 形式再点 75% ⇒ zoom **原地**更新且**只有一个 `<img>`**
//   ⑤ 未加载的远程图片**无占位节点**（无图标/文案），且未点击时**不发远程请求**（CDP Network 计数）
//
// 夹具（三种图片形态各一段，判据才互不干扰）：
//   P1 `![ ](data:…)`             —— 节点形式（① 居中 / ②A 点开 / ④ 50% 的**逐字节**形状）
//   P2 `前文 <img …> 后文`         —— **行内原文**形式（②C/②D 的选区边界能切进；④b 原地改 zoom）
//   P3 `![ ](https://example.com)` —— 远程（⑤ 无占位图标 + 不发请求）
//   P4 一段普通文字                —— ②B "点别处"
//
// 连接写法沿用 tools/_probe-imgcaret.js（裸 CDP，端口取 LUMIN_DEBUG_PORT，默认 9333）。
const fs = require('fs')
const path = require('path')
const PORT = process.env.LUMIN_DEBUG_PORT || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG_A =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 与 A 不同的一张（48×32 的浅蓝块：**有真实尺寸**，才能量"标记与图片同行时谁在顶部"） */
const PNG_B =
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'

const MD =
  `![](PLACE_A)\n\n` +
  `qian <img src="PLACE_B" style="zoom:50%;" /> hou\n\n` +
  `![remote](https://example.com/x.png)\n\n` +
  `<img src="PLACE_B" style="zoom:25%;" />\n\n最后一段文字。\n\n前 **粗体** 后\n\n前 **粗体** 后\n`

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra === undefined ? '' : ' | ' + extra}`)
}
function safe(fn, fallback) {
  try {
    return fn()
  } catch (e) {
    return fallback
  }
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面')
  let id = 0
  const pending = new Map()
  const events = []
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) events.push(m)
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC')
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const click = async (pt) => {
    if (!pt) return false
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(330)
    return true
  }

  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    if (!pinia) return 'NO_PINIA'
    window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  if (boot !== 'OK') throw new Error('bridge ' + boot)
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.ProseMirror[contenteditable=true]')`)) break
    await sleep(300)
  }
  await send('Network.enable')
  /**
   * 真实按键注入（只有 ②的退格用到）需要窗口在前台、编辑器有焦点 —— 否则事件不会落进编辑器。
   * 按清单 §10 P1 的口径：拿不到前置条件就 **SKIP**（`SKIP` 不算失败），不要 `throw`。
   */
  const requireFocus = async (label) => {
    await send('Page.bringToFront').catch(() => null)
    await sleep(150)
    const focused = await ev(
      `!!document.hasFocus() && !!document.activeElement && !!document.activeElement.closest?.('.ProseMirror')`
    )
    if (!focused) {
      console.log(`SKIP ${label}：真实按键需要窗口焦点（当前 window 未聚焦 / 编辑器未聚焦）`)
      return false
    }
    return true
  }
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  const doc = MD.replace('PLACE_A', PNG_A).replace('PLACE_B', PNG_B)
  // 用源码面灌内容（走真实解析路径：`<img>` 行内原文 ↔ 独立成行时的 html_block 都是解析器定的）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(1000)

  const state = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const bar = document.querySelector('[data-img-zoom-bar]')
      return {
        hasLine: !!el,
        lineText: el ? el.textContent : null,
        lineValue: el ? el.textContent : null,
        lineKind: el ? el.getAttribute('data-img-kind') : null,
        overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, .img-src-line--overlay, [data-img-source-input]').length,
        inEditor: el ? !!el.closest('.ProseMirror') : null,
        hasBar: !!bar,
        active: bar ? (bar.querySelector('[data-img-zoom].is-active') || {}).textContent || null : null,
        md: window.__vt.ed().storage.markdown.getMarkdown(),
        content: window.__vt.files().current.content,
        imgTags: (window.__vt.ed().storage.markdown.getMarkdown().match(/<img\\b/gi) || []).length,
        widgets: document.querySelectorAll('[data-img-widget] img').length
      }
    })()`)

  const firstImgPt = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror p img')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)

  // ── ① 居中 ──
  const center = await json(`(() => {
    const el = document.querySelector('.ProseMirror p img')
    const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
    if (!el) return { ok: false }
    const r = el.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    return {
      ok: true,
      imgCenter: Math.round(r.left + r.width / 2),
      areaCenter: Math.round(h.left + h.width / 2),
      offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2))),
      display: getComputedStyle(el).display,
      marginInline: getComputedStyle(el).marginInlineStart
    }
  })()`)
  check('① 图片居中：img 中心 ≈ 内容区中心（偏移 ≤ 4px）', center.ok && center.offset <= 4, JSON.stringify(center))

  // ── ②A 点图片 ⇒ 出现源码行 ──
  const p1 = await firstImgPt()
  await click(p1)
  const A = await state()
  check(
    '②A 点图片 ⇒ 标识符以**正文原位文本**出现、内容 == 该图 markdown（且 Markdown 逐字节不变）',
    A.hasLine && A.lineValue === `![](${PNG_A})` && A.lineKind === 'raw' && A.md.indexOf(`![](${PNG_A})`) >= 0,
    JSON.stringify({
      hasLine: A.hasLine,
      kind: A.lineKind,
      inEditor: A.inEditor,
      overlayCount: A.overlayCount,
      mdUnchanged: A.md.indexOf(`![](${PNG_A})`) >= 0
    })
  )
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-source-toolbar.png'), Buffer.from(shot1.result.data, 'base64')), null)

  // ── ③ 悬浮工具栏（此刻源码行开着）──
  const bar = await json(`(() => {
    const b = document.querySelector('[data-img-zoom-bar]')
    const line = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!b) return { has: false }
    const rb = b.getBoundingClientRect()
    const rl = line ? line.getBoundingClientRect() : null
    const inter = rl
      ? Math.max(0, Math.min(rb.bottom, rl.bottom) - Math.max(rb.top, rl.top)) *
        Math.max(0, Math.min(rb.right, rl.right) - Math.max(rb.left, rl.left))
      : -1
    return {
      has: true,
      steps: [...b.querySelectorAll('[data-img-zoom]')].map((x) => x.textContent),
      active: [...b.querySelectorAll('[data-img-zoom].is-active')].map((x) => x.textContent),
      bar: { t: Math.round(rb.top), l: Math.round(rb.left), w: Math.round(rb.width), h: Math.round(rb.height) },
      line: rl ? { t: Math.round(rl.top), l: Math.round(rl.left), w: Math.round(rl.width), h: Math.round(rl.height) } : null,
      intersectArea: Math.round(inter)
    }
  })()`)
  check(
    '③ 悬浮工具栏出现、档位 100/75/50/25 齐全、当前档有选中态',
    bar.has && JSON.stringify(bar.steps) === JSON.stringify(['100%', '75%', '50%', '25%']) && bar.active.length === 1,
    JSON.stringify({ has: bar.has, steps: bar.steps, active: bar.active })
  )
  check(
    '③ 工具栏与源码行矩形**不相交**（相交面积 == 0）',
    bar.has && bar.intersectArea === 0,
    JSON.stringify({ intersectArea: bar.intersectArea, bar: bar.bar, line: bar.line })
  )

  // ── ④ 点 50%：节点形式的图片 ⇒ 源码变成 `<img src="URL" style="zoom:50%;" />` ──
  const zoomBtnPt = async (pct) =>
    json(`(() => {
      const b = document.querySelector('[data-img-zoom="${pct}"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  await click(await zoomBtnPt(50))
  await sleep(1400)
  const after50 = await state()
  const want50 = `<img src="${PNG_A}" style="zoom:50%;" />`
  check(
    '④ 点 50% ⇒ 该段源码逐字节等于 `<img src="URL" style="zoom:50%;" />`（持久化进文档）',
    after50.md.indexOf(want50) >= 0 && after50.content.indexOf(want50) >= 0,
    JSON.stringify({
      want: want50,
      inMarkdown: after50.md.indexOf(want50) >= 0,
      inStore: after50.content.indexOf(want50) >= 0,
      storeHead: (after50.content || '').slice(0, 60),
      widgets: after50.widgets
    })
  )
  check(
    '④ 图片仍然渲染（有真 `<img>` 节点）',
    after50.widgets >= 2 && (await ev(`document.querySelectorAll('.ProseMirror p img').length`)) >= 2,
    JSON.stringify({ widgets: after50.widgets, imgTags: after50.imgTags })
  )
  // 往返：整篇重新解析 → 序列化，逐字节不变
  const roundTrip = await ev(`(() => {
    const ed = window.__vt.ed()
    const before = ed.storage.markdown.getMarkdown()
    ed.commands.setContent(before)
    return ed.storage.markdown.getMarkdown()
  })()`)
  check('④b 往返（解析 → 序列化）逐字节不变（`<img>` 仍是那段 HTML）', roundTrip === after50.md, JSON.stringify({ equal: roundTrip === after50.md }))

  // ── ④c 已是 HTML 形式（P2 的行内原文）再点 75% ⇒ 原地改 zoom，不新增 `<img>` ──
  const p2Pt = await json(`(() => {
    const el = document.querySelectorAll('[data-img-widget] img')[1] || document.querySelectorAll('[data-img-widget] img')[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(p2Pt)
  const before75 = await state()
  await click(await zoomBtnPt(75))
  await sleep(700)
  const after75 = await state()
  const countTag = (t, s) => (t.split(s).length - 1)
  check(
    '④c 已是 HTML 形式 ⇒ 点 75% **原地**更新 style 里的 zoom（同一段里只有一个 `<img>`）',
    after75.md.indexOf(`src="${PNG_B}" style="zoom:75%;"`) >= 0 &&
      countTag(after75.md, `<img src="${PNG_B}"`) === 1 &&
      after75.md.indexOf('zoom:50%') >= 0 /* P2 原来的那句已被替换，但 P1 那段仍是 50% */ &&
      countTag(after75.md, 'style="zoom:75%;"') === 1,
    JSON.stringify({
      want: `src="${PNG_B}" style="zoom:75%;"`,
      tagsForB: countTag(after75.md, `<img src="${PNG_B}"`),
      tagsForA: countTag(after75.md, `<img src="${PNG_A}"`),
      zoom50: countTag(after75.md, 'style="zoom:50%;"'),
      zoom75: countTag(after75.md, 'style="zoom:75%;"'),
      before: before75.lineValue ? before75.lineValue.slice(0, 24) : null
    })
  )

  // ── ②B 点别处 ⇒ 消失 ──
  const p4Pt = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const r = ps[ps.length - 1].getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(p4Pt)
  const B = await state()
  check('②B 点别处 ⇒ 源码行消失', B.hasLine === false && B.hasBar === false, JSON.stringify({ hasLine: B.hasLine, hasBar: B.hasBar }))

  // ── ②C / ②D：用 P2 的**行内原文**（选区边界能切进文本）──
  const rawRange = await json(`(() => {
    const view = window.__vt.ed().view
    let range = null
    view.state.doc.descendants((node, pos) => {
      if (node.isText && /^|^<img\\b/i.test(node.text || '') && /<img\\b/i.test(node.text || '')) range = { from: pos, to: pos + node.nodeSize }
      return true
    })
    return range || { from: -1, to: -1 }
  })()`)
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rawRange.from + 2}, to: ${rawRange.to - 2} }); return 'ok' })()`)
  await sleep(400)
  const D = await state()
  check(
    '②D 选区边界**切进**构造内部 ⇒ 显示，且源码 == 文档里那段原文',
    D.hasLine && D.lineKind === 'raw' && D.lineValue === `<img src="${PNG_B}" style="zoom:75%;" />`,
    JSON.stringify({ rawRange, hasLine: D.hasLine, kind: D.lineKind, text: (D.lineValue || '').slice(0, 40) })
  )
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rawRange.from - 1}, to: ${rawRange.to + 1} }); return 'ok' })()`)
  await sleep(400)
  const C = await state()
  check('②C 选区**完全包住**构造 ⇒ 不显示', C.hasLine === false, JSON.stringify({ rawRange, hasLine: C.hasLine }))

  // ── ⑤ 远程图片：无占位图标/文案；未点击不发请求 ──
  const guard = await json(`(() => {
    const els = [...document.querySelectorAll('[data-remote-src]')]
    const first = els[0] || null
    const cs = first ? getComputedStyle(first, '::before') : null
    return {
      count: els.length,
      childNodes: first ? first.childNodes.length : -1,
      text: first ? first.textContent : null,
      labels: document.querySelectorAll('.img-guard__label').length,
      svgs: document.querySelectorAll('[data-remote-src] svg, [data-remote-src] img').length,
      hasSrc: first ? first.hasAttribute('src') : null,
      dataSrc: first ? first.getAttribute('data-remote-src') : null,
      beforeContent: cs ? cs.content : null,
      border: first ? getComputedStyle(first).borderStyle : null,
      background: first ? getComputedStyle(first).backgroundColor : null
    }
  })()`)
  check(
    '⑤ 远程图片没有占位图标/文案节点（无 label/svg/img，且 ::before 无图标）',
    guard.count >= 1 &&
      guard.childNodes === 0 &&
      guard.text === '' &&
      guard.labels === 0 &&
      guard.svgs === 0 &&
      (guard.beforeContent === 'none' || guard.beforeContent === 'normal'),
    JSON.stringify(guard)
  )
  const remoteReqs = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  check(
    '⑤ 未点击时没有发起远程请求（CDP Network 计数 == 0；元素仍然没有 src）',
    remoteReqs === 0 && guard.hasSrc === false && String(guard.dataSrc).indexOf('example.com') >= 0,
    JSON.stringify({ remoteReqs, hasSrc: guard.hasSrc, dataSrc: guard.dataSrc })
  )
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-centered.png'), Buffer.from(shot2.result.data, 'base64')), null)

  // ═══ ② 行内混排的原始 HTML 图片不许拆行 ═══════════════════════════════════════
  // （前面几组已经把文档改过了 ⇒ 先复位成夹具，这一组要的是确定的那一段）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  const lineInfo = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const p2 = ps[1]
    const w = p2 ? p2.querySelector('[data-img-widget]') : null
    const txt = p2 ? [...p2.querySelectorAll('*')].filter((e) => e !== w && !e.contains(w) && (e.textContent || '').trim()) : []
    return {
      inline: w ? w.getAttribute('data-img-inline') : null,
      p2Rects: p2 ? p2.getClientRects().length : -1,
      p2Height: p2 ? Math.round(p2.getBoundingClientRect().height) : -1,
      textRects: txt.map((e) => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), txt: (e.textContent || '').trim().slice(0, 8) } }),
      widgetRect: w ? (() => { const r = w.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width) } })() : null
    }
  })()`)
  const sameLine =
    lineInfo.widgetRect &&
    lineInfo.textRects.filter((r) => r.b > r.t).length > 0 &&
    lineInfo.textRects
      .filter((r) => r.b > r.t) // 只看**可见**文本（被隐藏的标记文本 rect 是 0 高）
      .every((r) => r.b > lineInfo.widgetRect.t && r.t < lineInfo.widgetRect.b)
  check(
    'E5 行内混排的 `<img>` **保持行内**（widget 是 inline、与前后文字在同一行的纵向区间里）',
    lineInfo.inline === 'true' && sameLine,
    JSON.stringify(lineInfo)
  )
  const standalone = await json(`(() => {
    const all = [...document.querySelectorAll('[data-img-widget]')]
    const w = all.find((x) => x.getAttribute('data-img-inline') === 'false') || null
    if (!w) return { ok: false, widgets: all.map((x) => x.getAttribute('data-img-inline')) }
    const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
    const r = w.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    return {
      ok: true,
      inline: w.getAttribute('data-img-inline'),
      offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2))),
      display: getComputedStyle(w).display
    }
  })()`)
  check(
    'E6 独占一行的 `<img>` 仍是**块级居中**（offset ≈ 0）',
    standalone.ok && standalone.inline === 'false' && standalone.offset <= 4,
    JSON.stringify(standalone)
  )

  // ═══ ③ `.img-guard` 彻底消失（改判据 + 点击加载仍可用）═══════════════════════════
  const guardGone = await json(`(() => ({
    byClass: document.querySelectorAll('.img-guard').length,
    byLabel: document.querySelectorAll('.img-guard__label').length,
    byDataAttr: document.querySelectorAll('[data-remote-src]').length,
    childNodes: (document.querySelector('[data-remote-src]') || {}).childNodes ? document.querySelector('[data-remote-src]').childNodes.length : -1,
    hasSrc: (document.querySelector('[data-remote-src]') || { hasAttribute: () => null }).hasAttribute('src')
  }))()`)
  check(
    'E7 `.img-guard` 类名与文案节点计数均为 **0**（占位改用 `[data-remote-src]`）',
    guardGone.byClass === 0 && guardGone.byLabel === 0 && guardGone.byDataAttr >= 1 && guardGone.childNodes === 0,
    JSON.stringify(guardGone)
  )
  const reqsBeforeClick = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  const clickPt = await json(`(() => {
    // 明确点**那张远程图（example.com）**的占位：E3 之后 P1 也变成远程图了，不能取第一个
    const el = document.querySelector('[data-remote-src*="example.com"]') || document.querySelector('[data-remote-src]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
  })()`)
  await click(clickPt)
  await sleep(900)
  const reqsAfterClick = events.filter(
    (m) => m.method === 'Network.requestWillBeSent' && /example\.com/.test(m.params?.request?.url || '')
  ).length
  check(
    'E8 点击占位**仍然能加载**：点击前请求数 == 0、点击后 > 0（且占位已被换成真 `<img>`）',
    reqsBeforeClick === 0 && reqsAfterClick > 0,
    JSON.stringify({ reqsBeforeClick, reqsAfterClick })
  )

  // ═══ 第五十九轮：标识符 = 文档里的**正文原位文本**（可编辑），不再是浮层 ═══════════
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  const inlinePt2 = await json(`(() => {
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(inlinePt2)
  await sleep(500)
  // ① 位置：源码文本在 .ProseMirror **内部**、紧跟前面正文之后；且浮层容器计数 == 0
  const pos = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false, overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, [data-img-source-input]').length }
    // ⚠️ 标识符会**折行**：要量的是**第一段**的矩形（union rect 会跨到下一行的行首）
    const all = [...el.getClientRects()]
    const r = all.length ? all[0] : el.getBoundingClientRect()
    const p = el.closest('p')
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let prev = null
    let n
    while ((n = walker.nextNode())) {
      if (el.contains(n) || el === n.parentElement) break
      if ((n.textContent || '').trim()) prev = n
    }
    let pr = null
    if (prev) {
      const rg = document.createRange()
      rg.selectNodeContents(prev)
      const rects = [...rg.getClientRects()].filter((x) => x.width > 0)
      pr = rects.length ? rects[rects.length - 1] : null
    }
    const cs = getComputedStyle(el)
    return {
      ok: true,
      inEditor: !!el.closest('.ProseMirror'),
      overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, .img-src-line--overlay, [data-img-source-input]').length,
      text: el.textContent,
      markerLeft: Math.round(r.left),
      markerTop: Math.round(r.top),
      prevRight: pr ? Math.round(pr.right) : null,
      prevTop: pr ? Math.round(pr.top) : null,
      prevText: prev ? (prev.textContent || '').slice(0, 8) : null,
      fontSize: cs.fontSize,
      color: cs.color,
      verticalAlign: cs.verticalAlign,
      rectCount: el.getClientRects().length
    }
  })()`)
  const followsBody =
    pos.ok && pos.prevRight != null && pos.markerLeft >= pos.prevRight - 6 && Math.abs(pos.markerTop - pos.prevTop) <= 6
  check(
    '① 激活时源码是**正文里的原位文本**（在 .ProseMirror 内、紧跟前面正文之后，浮层容器计数 == 0）',
    pos.ok && pos.inEditor === true && pos.overlayCount === 0 && followsBody,
    JSON.stringify(pos)
  )

  // ② 真实退格删掉结尾 `>` ⇒ 图片消失、正文里剩截断的源码（逐字节）
  const beforeDel = await json(`(() => ({
    text: (document.querySelector('.ProseMirror [data-img-revealed]') || {}).textContent || null,
    widgetCount: document.querySelectorAll('[data-img-widget]').length,
    imgCount: document.querySelectorAll('.ProseMirror img').length
  }))()`)
  await ev(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const v = window.__vt.ed().view
    const at = v.posAtDOM(el, el.childNodes.length)
    const Sel = window.__vt.ed().state.selection.constructor
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, at)))
    return 'ok'
  })()`)
  await sleep(250)
  const canKey = await requireFocus('② 真实退格')
  if (canKey) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' })
  } else {
    // 拿不到焦点：退格走编辑器自己的键盘链路（`handleKeyDown` 的 Backspace 命令），
    // 语义相同、只是不经操作系统输入层；结果如实标注
    await ev(`(() => {
      const ed = window.__vt.ed()
      const evt = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true })
      ed.view.someProp('handleKeyDown', (f) => f(ed.view, evt))
      return 'ok'
    })()`)
  }
  await sleep(800)
  const afterDel = await json(`(() => {
    const raw = ${JSON.stringify(`<img src="${PNG_B}" style="zoom:50%;" />`)}
    const want = raw.slice(0, raw.length - 1)
    const md = window.__vt.ed().storage.markdown.getMarkdown()
    const txt = (document.querySelector('.ProseMirror') || {}).textContent || ''
    return {
      want,
      inMd: md.indexOf(want) >= 0,
      truncatedShown: txt.indexOf(want) >= 0,
      stillFull: md.indexOf(raw) >= 0,
      widgetCount: document.querySelectorAll('[data-img-widget]').length,
      imgCount: document.querySelectorAll('.ProseMirror img').length,
      mdHead: md.slice(0, 100)
    }
  })()`)
  check(
    '② 退格删掉结尾 `>` ⇒ 图片消失、正文里剩截断源码（逐字节 == 少了 `>` 的那串）',
    afterDel.inMd === true && afterDel.truncatedShown === true && afterDel.stillFull === false && afterDel.widgetCount === beforeDel.widgetCount - 1,
    JSON.stringify({
      改前: { text: (beforeDel.text || '').slice(-12), widgets: beforeDel.widgetCount, imgs: beforeDel.imgCount },
      改后: afterDel
    })
  )

  // ③ 贴顶：与图片同一行的那一行贴顶；折行时其余行按正常行高
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(900)
  await click(inlinePt2)
  await sleep(500)
  const sameLineTop = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!el || !w) return { ok: false }
    const ir = w.getBoundingClientRect()
    const rects = [...el.getClientRects()]
    const r0 = rects[0]
    return {
      ok: true,
      markerTop: Math.round(r0.top),
      markerBottom: Math.round(r0.bottom),
      imgTop: Math.round(ir.top),
      imgBottom: Math.round(ir.bottom),
      imgCenterY: Math.round((ir.top + ir.bottom) / 2),
      verticalAlign: getComputedStyle(el).verticalAlign,
      rectCount: rects.length,
      diffTop: Math.round(Math.abs(r0.top - ir.top)),
      diffCenter: Math.round(Math.abs(r0.top - (ir.top + ir.bottom) / 2))
    }
  })()`)
  check(
    '③ 与图片**同一行**时源码文本贴顶（|top-imgTop| < |top-imgCenterY|，vertical-align: top）',
    sameLineTop.ok && sameLineTop.verticalAlign === 'top' && sameLineTop.diffTop < sameLineTop.diffCenter,
    JSON.stringify(sameLineTop)
  )
  const wrapDoc = doc.replace(
    `qian <img src="${PNG_B}" style="zoom:50%;" /> hou`,
    `wrap <img src="${PNG_B}" style="zoom:50%;width:120px;height:64px;" /> tail`
  )
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(wrapDoc)}); return 'ok' })()`)
  await sleep(900)
  const wrapPt = await json(`(() => {
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(wrapPt)
  await sleep(500)
  const wrapInfo = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    if (!el || !w) return { ok: false }
    const ir = w.getBoundingClientRect()
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
    const band = rects.filter((r) => r.bottom > ir.top && r.top < ir.bottom)
    const others = rects.filter((r) => !(r.bottom > ir.top && r.top < ir.bottom))
    return {
      ok: true,
      rectCount: rects.length,
      verticalAlign: getComputedStyle(el).verticalAlign,
      rects: rects.map((r) => ({ t: Math.round(r.top), b: Math.round(r.bottom) })),
      imgTop: Math.round(ir.top),
      imgBottom: Math.round(ir.bottom),
      bandTop: band.length ? Math.round(band[0].top) : null,
      bandDiffImgTop: band.length ? Math.round(Math.abs(band[0].top - ir.top)) : null,
      othersTop: others.map((r) => Math.round(r.top)),
      lineHeights: rects.slice(1).map((r, i) => Math.round(r.top - rects[i].top))
    }
  })()`)
  const onlyBandTop =
    wrapInfo.ok &&
    wrapInfo.rectCount >= 2 &&
    wrapInfo.verticalAlign === 'top' &&
    wrapInfo.bandDiffImgTop != null &&
    wrapInfo.bandDiffImgTop <= 8 &&
    wrapInfo.lineHeights.every((h) => h >= 14)
  check(
    '③b 折行时**只有与图片同处一行的那一行**贴顶（其余行按正常行高，未整块上移）',
    onlyBandTop,
    JSON.stringify(wrapInfo)
  )
  const shotM = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-inline.png'), Buffer.from(shotM.result.data, 'base64')), null)

  const pass = results.filter((r) => r.ok).length
  console.log(`TOTAL ${results.length} PASS ${pass} FAIL ${results.length - pass}`)
  console.log(`--- ${pass}/${results.length} PASS`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.log('FATAL ' + (e && e.message))
  console.log(`TOTAL ${results.length} PASS ${results.filter((r) => r.ok).length} FAIL ${results.filter((r) => !r.ok).length}`)
  console.log('--- 0/1 PASS')
  process.exit(1)
})
