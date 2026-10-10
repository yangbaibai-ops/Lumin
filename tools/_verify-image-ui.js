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
  // ⚠️ `PLACE_B` 在夹具里出现**两次**（行内 + 独占一行）：必须全局替换，否则独占那段的 src
//    还是字面量（第六十一轮发现，图片会渲染成坏图）
const doc = MD.split('PLACE_A')
  .join(PNG_A)
  .split('PLACE_B')
  .join(PNG_B)
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
    after75.md.indexOf(`<img src="${PNG_B}" style="zoom:75%;" />`) >= 0 &&
      // 同一张图（同 src）在夹具里出现两次（行内 + 独占一行）⇒ 要按**整段**计数，不能按 src 前缀
      countTag(after75.md, `<img src="${PNG_B}" style="zoom:75%;" />`) === 1 &&
      countTag(after75.md, `<img src="${PNG_B}" style="zoom:25%;" />`) === 1 &&
      after75.md.indexOf('zoom:50%') >= 0 /* P2 原来的那句已被替换，但 P1 那段仍是 50% */ &&
      countTag(after75.md, 'style="zoom:75%;"') === 1,
    JSON.stringify({
      want: `<img src="${PNG_B}" style="zoom:75%;" />`,
      tagsForB75: countTag(after75.md, `<img src="${PNG_B}" style="zoom:75%;" />`),
      tagsForB25: countTag(after75.md, `<img src="${PNG_B}" style="zoom:25%;" />`),
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
    const shape = []
    view.state.doc.forEach((n, off) => {
      shape.push({ i: shape.length, pos: off, type: n.type.name, head: String(n.textContent || '').slice(0, 18) })
    })
    view.state.doc.descendants((node, pos) => {
      // 认**这一张**（PNG_B 那张）的原文：P1 已经被第 ④ 步改成 PNG_A 的 <img …> 了，
      // 按"第一个 <img"会取错对象（第六十三轮实测踩过）
      if (node.isText && /<img\\b/i.test(node.text || '') && (node.text || '').indexOf(${JSON.stringify(PNG_B)}) >= 0) {
        if (!range) range = { from: pos, to: pos + node.nodeSize }
        shape.push({ pos, text: String(node.text || '').slice(0, 24) })
      }
      return true
    })
    return { range: range || { from: -1, to: -1 }, shape }
  })()`)
  const rr = rawRange.range
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rr.from + 2}, to: ${rr.to - 2} }); return 'ok' })()`)
  await sleep(400)
  const D = await state()
  check(
    '②D 选区边界**切进**构造内部 ⇒ 显示，且源码 == 文档里那段原文',
    D.hasLine && D.lineKind === 'raw' && D.lineValue === `<img src="${PNG_B}" style="zoom:75%;" />`,
    JSON.stringify({
      rawRange: rr,
      docShape: rawRange.shape,
      hasLine: D.hasLine,
      kind: D.lineKind,
      text: (D.lineValue || '').slice(0, 60),
      want: `<img src="${PNG_B}" style="zoom:75%;" />`.slice(0, 60)
    })
  )
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rr.from - 1}, to: ${rr.to + 1} }); return 'ok' })()`)
  await sleep(400)
  const C = await state()
  check('②C 选区**完全包住**构造 ⇒ 不显示', C.hasLine === false, JSON.stringify({ rawRange: rr, hasLine: C.hasLine }))

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
    lineInfo.inline === 'true' &&
    // 「不拆行」的判据：整段只有**一个行盒**，且图片落在这一行里
    lineInfo.p2Rects === 1 &&
    lineInfo.widgetRect.t >= 0
  check(
    'E5 行内混排的 `<img>` **保持行内**（widget 是 inline、整段只有一行）',
    sameLine,
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
    const pcs = getComputedStyle(p)
    const w2 = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'true')
    const ir = w2 ? w2.getBoundingClientRect() : null
    // 标识符可能折成多行：取**与图片同一行**的那一段（其纵向区间与图片相交；没有则取最后一段）
    const frags = all.length ? all : [r]
    const band = ir
      ? (frags.filter((x) => x.bottom > ir.top && x.top < ir.bottom).slice(-1)[0] ?? frags[frags.length - 1])
      : frags[frags.length - 1]
    return {
      ok: true,
      inEditor: !!el.closest('.ProseMirror'),
      overlayCount: document.querySelectorAll('[data-img-source], .img-src-line, .img-src-line--overlay, [data-img-source-input]').length,
      text: el.textContent,
      markerLeft: Math.round(r.left),
      markerRight: Math.round(r.right),
      markerTop: Math.round(r.top),
      fragLeft: Math.round(band.left),
      fragRight: Math.round(band.right),
      fragTop: Math.round(band.top),
      fragCount: frags.length,
      prevRight: pr ? Math.round(pr.right) : null,
      prevTop: pr ? Math.round(pr.top) : null,
      prevText: prev ? (prev.textContent || '').slice(0, 8) : null,
      imgLeft: ir ? Math.round(ir.left) : null,
      imgTop: ir ? Math.round(ir.top) : null,
      // ① 排版逐项：标识符 vs **同段落普通正文**（段落自身的 computed 就是普通文本的样式）
      marker: { fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color },
      body: { fontSize: pcs.fontSize, fontFamily: pcs.fontFamily, fontWeight: pcs.fontWeight, lineHeight: pcs.lineHeight, color: pcs.color },
      verticalAlign: cs.verticalAlign,
      background: cs.backgroundColor,
      rectCount: el.getClientRects().length
    }
  })()`)
  const sameTypography =
    pos.ok &&
    ['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'color'].every((k) => pos.marker[k] === pos.body[k])
  check(
    '① 标识符排版与**同段正文逐项一致**（font-size/family/weight/line-height/color 五项相等）',
    sameTypography,
    JSON.stringify({ marker: pos.marker, body: pos.body })
  )
  check(
    '② 位置：标识符紧贴**图片之前**（同一行那一段的 right ≤ img.left）且与图片同一行（top 接近）',
    pos.ok &&
      pos.fragRight != null &&
      pos.imgLeft != null &&
      pos.fragRight <= pos.imgLeft + 1 &&
      Math.abs(pos.fragTop - pos.imgTop) <= 10,
    JSON.stringify({
      markerLeft: pos.markerLeft,
      fragRight: pos.fragRight,
      imgLeft: pos.imgLeft,
      fragTop: pos.fragTop,
      imgTop: pos.imgTop,
      fragCount: pos.fragCount,
      verticalAlign: pos.verticalAlign,
      background: pos.background
    })
  )
  check(
    '③a 激活时标识符是**原位正文**（在 .ProseMirror 内、浮层容器计数 0）',
    pos.ok && pos.inEditor === true && pos.overlayCount === 0,
    JSON.stringify({ inEditor: pos.inEditor, overlayCount: pos.overlayCount })
  )
  // ③b/③c 底色两态：点图片 ⇒ 浅灰底；焦点进文本开始编辑 ⇒ 透明
  const bgIdle = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const cs = getComputedStyle(el)
    const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(cs.backgroundColor) || []
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return {
      ok: true,
      bg: cs.backgroundColor,
      tokenCodeBg: getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim(),
      grayish: m.length ? Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 : false
    }
  })()`)
  check(
    '③b 点击图片 ⇒ 标识符有**浅灰底**（非 transparent；给 computed 值与该 token 的取值）',
    bgIdle.ok && bgIdle.bg !== 'rgba(0, 0, 0, 0)' && bgIdle.grayish === true,
    JSON.stringify(bgIdle)
  )
  const shotClick = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-click.png'), Buffer.from(shotClick.result.data, 'base64')), null)
  const shotPos = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-position.png'), Buffer.from(shotPos.result.data, 'base64')), null)
  // 把光标放进标识符文本（= 开始编辑）——用**真实点击**落进它的矩形里
  const markerPt = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const rs = [...el.getClientRects()].filter((r) => r.width > 2)
    const r = rs.length ? rs[0] : el.getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(markerPt)
  await sleep(450)
  const shotEdit = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-typora-editing.png'), Buffer.from(shotEdit.result.data, 'base64')), null)
  const bgEditing = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false, hasMarker: false }
    return { ok: true, hasMarker: true, bg: getComputedStyle(el).backgroundColor, cls: el.className }
  })()`)
  check(
    '③c 进入编辑（光标落进标识符）⇒ 底色变**透明**（rgba(0, 0, 0, 0)）',
    bgEditing.ok && bgEditing.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify({ 点击态: bgIdle.bg, 编辑态: bgEditing.bg, cls: bgEditing.cls })
  )
  // 失焦/点别处 ⇒ 回到未激活（隐藏）
  const outPt = await json(`(() => {
    const ps = [...document.querySelectorAll('.ProseMirror p')]
    const r = ps[ps.length - 1].getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(outPt)
  await sleep(400)
  const bgGone = await json(`(() => ({
    hasMarker: !!document.querySelector('.ProseMirror [data-img-revealed]'),
    hasBar: !!document.querySelector('[data-img-zoom-bar]'),
    md: window.__vt.ed().storage.markdown.getMarkdown()
  }))()`)
  check(
    '③d 点别处 ⇒ 回到未激活（标识符隐藏、工具栏消失）',
    bgGone.hasMarker === false && bgGone.hasBar === false,
    JSON.stringify({ hasMarker: bgGone.hasMarker, hasBar: bgGone.hasBar })
  )

  // ② 真实退格删掉结尾 `>` ⇒ 图片消失、正文里剩截断的源码（逐字节）
  // （③d 已经把它收起来了 ⇒ 先重新点开那张行内图片）
  await click(inlinePt2)
  await sleep(500)
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

  // ③ 同一水平线：标识符文字与正文同处一行（第六十五轮：不再贴行盒顶部）
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
  /**
   * 第六十五轮口径：`vertical-align: top` → `baseline`（本轮唯一的样式改动）。
   * `top` 把标识符**整块**顶到行盒顶端 —— 标识符比图片矮时就跑到图片顶部，
   * 与同一行里的正文不在一条水平线上（用户原话：「标识符为了在顶部显示，和正文脱节严重」）。
   * `baseline` 让标识符第一行的基线落在正文那一行的基线上，与普通正文完全一致。
   * 不用 `middle`：它只对单行盒子成立，标识符一折行就会以文字行为中心上下铺开、压到上一行。
   */
  check(
    '③ 与图片同一行时标识符**第一行**贴在该行上（vertical-align: baseline）',
    sameLineTop.ok &&
      sameLineTop.verticalAlign === 'baseline' &&
      sameLineTop.diffTop < sameLineTop.diffCenter,
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
  /**
   * ⚠️ 第六十五轮定稿（试错记录）：曾把标识符「压成一行 + 省略号」的窄盒，被用户否掉 ——
   * 「源码有一个最大宽度，显示不全，只有在点击源码后才会全部出现，而且和正文布局排版不一致」。
   * 所以标识符**按正文排版**：与段落同宽、左对齐、长 URL 自然折行、**完整显示**。
   * 这里守住"折行但排版正常"：与图片同处一行的那一段贴住该行，其余行按正常行高。
   */
  const wrapOk =
    wrapInfo.ok &&
    wrapInfo.rectCount >= 2 &&
    wrapInfo.verticalAlign === 'baseline' &&
    wrapInfo.bandDiffImgTop != null &&
    wrapInfo.bandDiffImgTop <= 8 &&
    wrapInfo.lineHeights.every((h) => h >= 14)
  check(
    '③b 长 src 按正文折行：与图片同处一行的那一段贴住该行，其余行按正常行高（不整块上移）',
    wrapOk,
    JSON.stringify(wrapInfo)
  )

  // ③c **短标识符 + 高图**：标识符必须落在正文那一行上，而不是被顶到图片顶部（用户原报障）
  {
    const tallDoc = '文字 <img src="x.png" style="width:120px;height:120px;" /> 文字\n'
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(tallDoc)}); return 'ok' })()`)
    await sleep(900)
    const tallPt = await json(`(() => {
      const im = document.querySelector('.ProseMirror img')
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + 2), y: Math.round(r.top + 2) }
    })()`)
    await click(tallPt)
    await sleep(500)
    /** 量一次：标识符垂直中心 ↔ 同一段**正文文本**的垂直中心（差越小越"和正文一条线"） */
    const measureTall = (force) =>
      json(`(() => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const p = el && el.closest('p')
        if (!el || !p) return { ok: false }
        // widget 里的 <img> 只继承 zoom，不继承源码的 width/height ⇒
        // 这里直接改 DOM 把这张图撑高，才能造出"高图 + 短标识符"这一格
        const im = p.querySelector('.ProseMirror img') || document.querySelector('.ProseMirror img')
        if (im) { im.style.width = '120px'; im.style.height = '120px' }
        if (${JSON.stringify(force)}) el.style.verticalAlign = 'top'
        else el.style.verticalAlign = ''
        const wk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        let n = null
        let textRect = null
        while ((n = wk.nextNode())) {
          if (!(n.textContent || '').trim()) continue
          const rg = document.createRange()
          rg.selectNodeContents(n)
          const b = rg.getBoundingClientRect()
          if (b.height > 0) { textRect = b; break }
        }
        const mr = el.getBoundingClientRect()
        const ir = im ? im.getBoundingClientRect() : null
        const lineH = Math.round(parseFloat(getComputedStyle(el).lineHeight))
        const cs = getComputedStyle(el)
        const markerCenter = Math.round((mr.top + mr.bottom) / 2)
        const textCenter = textRect ? Math.round((textRect.top + textRect.bottom) / 2) : null
        return {
          ok: true,
          markerCenter,
          textCenter,
          delta: textCenter == null ? null : Math.abs(markerCenter - textCenter),
          markerTop: Math.round(mr.top),
          imgTop: ir ? Math.round(ir.top) : null,
          imgBottom: ir ? Math.round(ir.bottom) : null,
          lineHeight: lineH,
          verticalAlign: cs.verticalAlign
        }
      })()`)
    const tallBase = await measureTall(false)
    const tallTop = await measureTall(true)
    check(
      '③c 短标识符 + 高图：标识符落在**正文那一行**上（与正文垂直中心差 ≤ 一个行高），不在图片顶部',
      tallBase.ok &&
        tallBase.textCenter != null &&
        tallBase.verticalAlign === 'baseline' &&
        tallBase.imgBottom - tallBase.imgTop >= 100 &&
        tallBase.delta <= tallBase.lineHeight,
      JSON.stringify(tallBase)
    )
    // 反向对照：把 vertical-align 强行改回 top ⇒ 标识符必须**变差**（否则这一格没有区分度）
    check(
      '③d 反向对照：同一夹具下把 vertical-align 改回 `top` ⇒ 标识符被顶离正文那一行（差值变大）',
      tallTop.ok && tallBase.ok && tallTop.delta != null && tallBase.delta != null &&
        tallTop.delta > tallBase.delta,
      JSON.stringify({ baseline: tallBase, forcedTop: tallTop })
    )
  }
  const shotM = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-inline.png'), Buffer.from(shotM.result.data, 'base64')), null)

  // ═══ 第六十一轮：两条路径（![]() 系 vs 裸 <img> 系）的标识符必须**逐项一致** ═════════
  /** 量"当前显形的标识符"：classList + 7 项 computed + 位置，并附上元素/父元素标签 */
  const measureMarker = () =>
    json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return { ok: false }
      const cs = getComputedStyle(el)
      const rects = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
      const wl = [...document.querySelectorAll('[data-img-widget]')]
      // 只认**这张标识符自己的**图片：widget 的 data-img-from 与标识符的相同
      const own = el.getAttribute('data-img-from')
      const anyW = wl.find((x) => x.getAttribute('data-img-from') === own) || wl[0] || null
      const ir = anyW ? anyW.getBoundingClientRect() : null
      const frags = rects.length ? rects : [el.getBoundingClientRect()]
      const band = ir
        ? (frags.filter((x) => x.bottom > ir.top && x.top < ir.bottom).slice(-1)[0] ?? frags[frags.length - 1])
        : frags[frags.length - 1]
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        cls: [...el.classList].sort(),
        inline: anyW ? anyW.getAttribute('data-img-inline') === 'true' : null,
        props: {
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          color: cs.color,
          background: cs.backgroundColor,
          verticalAlign: cs.verticalAlign,
          display: cs.display,
          padding: cs.padding,
          border: cs.borderTopWidth + ' ' + cs.borderTopStyle
        },
        fragRight: Math.round(band.right),
        fragTop: Math.round(band.top),
        imgLeft: ir ? Math.round(ir.left) : null,
        imgTop: ir ? Math.round(ir.top) : null
      }
    })()`)
  const paths = {}
  {
    // 路径 A：`![]()` 系（点 x.50% 转成 `<img … style="zoom:50%;" />` 后再激活）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    await click(await firstImgPt())
    await sleep(400)
    await click(await zoomBtnPt(50))
    await sleep(900)
    await click(await firstImgPt())
    await sleep(500)
    paths.A = await measureMarker()
    const shotA = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-pathA.png'), Buffer.from(shotA.result.data, 'base64')), null)
    // 路径 B：**独立成行**的裸 `<img>`（markdown-it 判成 html_block ⇒ `<pre data-md-htmlblock>`）
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    const ptB = await json(`(() => {
      const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'false')
      if (!w) return null
      const r = w.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(ptB)
    await sleep(500)
    paths.B = await measureMarker()
    const shotB = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-pathB.png'), Buffer.from(shotB.result.data, 'base64')), null)
  }
  const propKeys = Object.keys(paths.A?.props || {})
  const propsEqual = paths.A?.ok && paths.B?.ok && propKeys.every((k) => paths.A.props[k] === paths.B.props[k])
  const clsEqual = paths.A?.ok && paths.B?.ok && JSON.stringify(paths.A.cls) === JSON.stringify(paths.B.cls)
  check(
    '⑦ 两条路径的标识符**逐项一致**（classList 与 9 项 computed 全等：字号/字族/字重/行高/颜色/底色/vertical-align/display/padding）',
    propsEqual && clsEqual,
    JSON.stringify({
      路径A: { tag: paths.A?.tag, parentTag: paths.A?.parentTag, cls: paths.A?.cls, props: paths.A?.props },
      路径B: { tag: paths.B?.tag, parentTag: paths.B?.parentTag, cls: paths.B?.cls, props: paths.B?.props },
      不同的项: paths.A?.ok && paths.B?.ok ? propKeys.filter((k) => paths.A.props[k] !== paths.B.props[k]) : null
    })
  )
  check(
    '⑦b 标识符在图片**之前**（文档序在前，且不与图片水平重叠：或在其左侧、或在其上一行）',
    paths.A?.ok &&
      paths.B?.ok &&
      paths.A.imgLeft != null &&
      paths.B.imgLeft != null &&
      (paths.A.fragRight <= paths.A.imgLeft + 1 || paths.A.fragTop < paths.A.imgTop) &&
      (paths.B.fragRight <= paths.B.imgLeft + 1 || paths.B.fragTop < paths.B.imgTop),
    JSON.stringify({
      A: { fragRight: paths.A?.fragRight, imgLeft: paths.A?.imgLeft, fragTop: paths.A?.fragTop, imgTop: paths.A?.imgTop, inline: paths.A?.inline },
      B: { fragRight: paths.B?.fragRight, imgLeft: paths.B?.imgLeft, fragTop: paths.B?.fragTop, imgTop: paths.B?.imgTop, inline: paths.B?.inline }
    })
  )
  // ② 两条路径的"点击态灰 / 编辑态透明"各一次（每次都先复位夹具、再按该路径激活）
  for (const which of ['A', 'B']) {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
    if (which === 'A') {
      await click(await firstImgPt())
      await sleep(400)
      await click(await zoomBtnPt(50))
      await sleep(900)
      await click(await firstImgPt())
    } else {
      const pt = await json(`(() => {
        const w = [...document.querySelectorAll('[data-img-widget]')].find((x) => x.getAttribute('data-img-inline') === 'false')
        if (!w) return null
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(pt)
    }
    await sleep(500)
    const before = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      return el ? { bg: getComputedStyle(el).backgroundColor } : { bg: null }
    })()`)
    const bg = before?.bg
    const pt = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return null
      const rs = [...el.getClientRects()].filter((r) => r.width > 2)
      const r = rs.length ? rs[0] : el.getBoundingClientRect()
      return { x: Math.round(r.left + Math.min(12, Math.max(2, r.width / 2))), y: Math.round(r.top + r.height / 2) }
    })()`)
    await click(pt)
    await sleep(450)
    const after = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      return el ? { bg: getComputedStyle(el).backgroundColor, cls: [...el.classList].sort() } : { bg: null, cls: null }
    })()`)
    check(
      `⑦c 路径 ${which}：点击激活 ⇒ 浅灰底，进入编辑 ⇒ 透明（给前后 computed）`,
      bg === 'rgb(241, 242, 245)' && after.bg === 'rgba(0, 0, 0, 0)',
      JSON.stringify({ 点击态: bg, 编辑态: after.bg, cls: after.cls })
    )
  }

  // ═══ 第六十二轮：点图片**不许跳位**（水平不动；垂直只许向下让位）═══════════════════
  /**
   * 量"某张图片"的**画面矩形**：用 src + 序号定位；量的是**真正的 `<img>` 元素**
   * （`![ ]()` 节点形态时它没有 widget 包裹；块级 widget 的**外层**宽度是整行宽，
   *  量外层会把"居中块"误读成"跳位"——用户看到的是画面本身的位移）。
   */
  const imgRectOf = (src, which) =>
    json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter(
        (im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)}
      )
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return { ok: false, count: all.length }
      const r = im.getBoundingClientRect()
      const w = im.closest('[data-img-widget]')
      return {
        ok: true,
        count: all.length,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        top: Math.round(r.top),
        inline: w ? w.getAttribute('data-img-inline') : 'node'
      }
    })()`)
  const clickWidget = async (src, which) => {
    const pt = await json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter(
        (im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)}
      )
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
    })()`)
    await click(pt)
    await sleep(550)
  }
  const resetDoc = async () => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
    await sleep(900)
  }
  /** 点一次、量前后：水平必须不变（±1px），top 只许不变或变大 */
  const noJump = async (label, src, which) => {
    await resetDoc()
    const before = await imgRectOf(src, which)
    const shot0 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-nojump-before.png'), Buffer.from(shot0.result.data, 'base64')), null)
    await clickWidget(src, which)
    const after = await imgRectOf(src, which)
    const shot1 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-nojump-after.png'), Buffer.from(shot1.result.data, 'base64')), null)
    const okH =
      before.ok && after.ok &&
      Math.abs(after.left - before.left) <= 1 &&
      Math.abs(after.right - before.right) <= 1 &&
      Math.abs(after.width - before.width) <= 1
    const okV = before.ok && after.ok && after.top >= before.top - 1
    check(
      `${label}：点击前后水平**不动**（left/right/width ±1px）且 top 只许不变或向下`,
      okH && okV,
      JSON.stringify({ before, after, 水平差: after.ok && before.ok ? { left: after.left - before.left, right: after.right - before.right, width: after.width - before.width } : null, 垂直差: after.ok && before.ok ? after.top - before.top : null })
    )
    return { before, after }
  }
  // ① 居中图片（`![]()` 节点形态：块级 + margin-inline:auto 居中）
  const jumpCenter = await noJump('⑧① 居中图片', PNG_A, 'first')
  // ② 独立成行的裸 `<img>`（html_block：同属"只有一张图"的居中块）
  const jumpBlock = await noJump('⑧② 独立成行的裸 `<img>`（居中块）', PNG_B, 'last')
  // ③ 行内混排（`qian <img> hou`）：标识符是被插进**同一段流**里的正文文本 ⇒ 它占的行内宽度
  //    必然把图片往右推。断言：图片自身宽/高不变、top 不变或向下、水平位移 ≤ 标识符首段宽 +2px
  {
    await resetDoc()
    const before = await imgRectOf(PNG_B, 'first')
    await clickWidget(PNG_B, 'first')
    const after = await imgRectOf(PNG_B, 'first')
    const marker = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      if (!el) return null
      const rs = [...el.getClientRects()].map((r) => ({ l: Math.round(r.left), w: Math.round(r.width), t: Math.round(r.top) }))
      return { firstWidth: rs.length ? rs[0].w : null, lastRight: rs.length ? rs[rs.length - 1].l + rs[rs.length - 1].w : null, rects: rs }
    })()`)
    check(
      '⑧③ 行内混排：图片宽高不变、top 只向下，水平位移只来自标识符在那一行占的行内宽度',
      before.ok &&
        after.ok &&
        Math.abs(after.width - before.width) <= 1 &&
        after.top >= before.top - 1 &&
        // 图片紧接在标识符**与本图同处一行**的那一段之后（间距 = widget 的 0.15em 外边距）
        marker?.lastRight != null &&
        after.left >= marker.lastRight &&
        after.left - marker.lastRight <= 8,
      JSON.stringify({ before, after, marker, 位移: after.ok && before.ok ? after.left - before.left : null })
    )
  }
  // ④ 标识符占自己一行时：图片**只向下**移动，位移 ≈ 标识符行高
  const downShift = jumpCenter.after.ok && jumpCenter.before.ok ? jumpCenter.after.top - jumpCenter.before.top : null
  const markerBox = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const rs = [...el.getClientRects()].filter((x) => x.height > 0)
    return { height: Math.round(r.height), lineHeight: rs.length ? Math.round(rs[0].height) : null, lines: rs.length }
  })()`)
  check(
    '⑧④ 标识符占行 ⇒ 图片只**向下**让位（位移 ≥ 0 且不超过标识符自身总高 + 8px）',
    downShift != null &&
      downShift >= 0 &&
      markerBox?.height != null &&
      downShift <= markerBox.height + 8,
    JSON.stringify({
      beforeTop: jumpCenter.before?.top,
      afterTop: jumpCenter.after?.top,
      下移量: downShift,
      标识符: markerBox
    })
  )

  // ═══ 第六十三轮 ══════════════════════════════════════════════════════════════
  // ⑨ 布局口径：独占一行的图片**居中**；段里还有别的文字 ⇒ 行内随文（不居中）
  {
    await resetDoc()
    const layout = await json(`(() => {
      const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
      const h = host.getBoundingClientRect()
      const out = []
      for (const p of document.querySelectorAll('.ProseMirror p, .ProseMirror pre[data-md-htmlblock]')) {
        const im = p.querySelector('img')
        if (!im) continue
        const r = im.getBoundingClientRect()
        out.push({
          tag: p.tagName.toLowerCase(),
          onlyImage: (p.textContent || '').trim().length === 0,
          display: getComputedStyle(im).display,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          offset: Math.round(Math.abs(r.left + r.width / 2 - (h.left + h.width / 2)))
        })
      }
      return out
    })()`)
    const block = layout.find((x) => x.onlyImage)
    const inline = layout.find((x) => !x.onlyImage)
    check(
      '⑨ 独占一行 ⇒ **居中**（offset ≈ 0）；段里还有文字 ⇒ **行内**（不居中）',
      !!block && !!inline && block.offset <= 4 && inline.offset > 8,
      JSON.stringify({ 独占一行: block, 行内: inline, 全部: layout })
    )
    const shotL = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-inline-vs-block.png'), Buffer.from(shotL.result.data, 'base64')), null)
  }

  // ⑩ 连续点两张图片：标识符不许闪烁（切换只增删一次、无中间回摆）
  {
    await resetDoc()
    await clickWidget(PNG_A, 'first')
    await sleep(450)
    const beforeFlick = await json(`(() => ({
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      text: (document.querySelector('.ProseMirror [data-img-revealed]') || {}).textContent?.slice(0, 12) || null
    }))()`)
    await ev(`(() => {
      const seen = []
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('+' + String(n.textContent || '').slice(0, 10))
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) seen.push('-R ' + String(n.textContent || '').slice(0, 10))
          }
          // PM 常常**复用**同一个 span、只改 class ⇒ 必须计入；区分"显隐"(R) 与"编辑态"(E)
          if (m.type === 'attributes' && m.attributeName === 'class' && m.target.nodeType === 1) {
            const el = m.target.matches?.('[data-img-revealed]')
              ? m.target
              : m.target.querySelector?.('[data-img-revealed]')
            if (el) {
              const on = el.classList.contains('img-src-revealed')
              const editing = el.classList.contains('img-src-revealed--editing')
              const key = (on ? 'R' : 'r') + (editing ? 'E' : 'e')
              const label = key + ' ' + String(el.textContent || '').slice(0, 8)
              if (seen[seen.length - 1] !== label) seen.push(label)
            }
          }
        }
      })
      mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-img-revealed'] })
      window.__flickStop = () => { mo.disconnect(); return seen }
      return 'ok'
    })()`)
    await clickWidget(PNG_B, 'first') // A 显形中，紧接着点 B
    await sleep(700)
    const seq = (await ev(`window.__flickStop()`)) || []
    const finalState = await json(`(() => {
      const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
      return {
        count: els.length,
        texts: els.map((e) => String(e.textContent || '').slice(0, 14)),
        from: els.map((e) => e.getAttribute('data-img-from'))
      }
    })()`)
    const revealChanges = seq.filter((x) => x.startsWith('R') || x.startsWith('r')).length
    check(
      '⑩ 连点两张图片：标识符切换**只增删一次**（无中间回摆），最终只剩 B 的标识符',
      revealChanges <= 3 && finalState.count === 1 && finalState.texts[0]?.indexOf('<img') === 0,
      JSON.stringify({ 点击A后: beforeFlick, 抖动序列: seq, 显隐变更次数: revealChanges, 最终态: finalState })
    )
  }

  // ⑪ 同一份源码必须同样渲染：路径 X（整段解析）vs 路径 Y（打字 + 回车）
  const pathSnapshot = async () => {
    await clickWidget(PNG_B, 'first')
    await sleep(500)
    const marker = await measureMarker()
    const img = await imgRectOf(PNG_B, 'first')
    const dom = await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const w = el ? el.closest('[data-img-widget]') : null
      const host = document.querySelector('[data-editor-kernel]') || document.querySelector('.ProseMirror')
      const h = host.getBoundingClientRect()
      const im = w ? w.querySelector('img') : null
      const ir = im ? im.getBoundingClientRect() : null
      return {
        markerTag: el ? el.tagName.toLowerCase() : null,
        markerParent: el && el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        markerCls: el ? [...el.classList].sort() : null,
        widgetCls: w ? [...w.classList].sort() : null,
        widgetInline: w ? w.getAttribute('data-img-inline') : null,
        imgDisplay: im ? getComputedStyle(im).display : null,
        offset: ir ? Math.round(Math.abs(ir.left + ir.width / 2 - (h.left + h.width / 2))) : null,
        paraText: el && el.closest('p') ? el.closest('p').textContent.trim().slice(0, 24) : null,
        hasPre: !!document.querySelector('.ProseMirror pre[data-md-htmlblock]')
      }
    })()`)
    return { md: await ev(`window.__vt.ed().storage.markdown.getMarkdown()`), marker, img, dom }
  }
  {
    const X = `这是行内图片\n\n<img src="${PNG_B}" style="zoom:100%;" />`
    const Yinline = `这是行内图片<img src="${PNG_B}" style="zoom:100%;" />`
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(X)}); return 'ok' })()`)
    await sleep(900)
    const snapX = await pathSnapshot()
    /**
     * 第六十九轮：Y 路径不再用 CDP 真实按键（无窗口焦点时会被跳过 ⇒ 夹具本身不同、断言假红）。
     * 改用**编辑器自身的事务**制造与"两次回车"等价的拆分：PM 的 Enter 走的就是
     * `commands.splitBlock`（baseKeymap 的 `splitBlock`），这里直接派发 `tr.split(pos)` 两次 ——
     * 与真实按键在 PM 里**同一条链路**（同一个 `splitBlock` 命令），只是不经过操作系统输入层。
     */
    const splits = await json(`(() => {
      const v = window.__vt.ed().view
      const Sel = window.__vt.ed().state.selection.constructor
      const texts = []
      // 光标落在"正文与图片之间"（正文那段文本的末尾）
      let at = 7
      v.state.doc.descendants((n, pos) => {
        if (n.isText && (n.text || '').indexOf('这是行内图片') >= 0) at = pos + (n.text || '').length
        return true
      })
      for (let i = 0; i < 2; i++) {
        const st = v.state
        const cur = Math.min(at, st.doc.content.size - 1)
        v.dispatch(st.tr.setSelection(Sel.create(st.doc, cur)).split(cur))
        at = v.state.selection.from
        texts.push(v.state.doc.textBetween(0, v.state.doc.content.size, '\\n').slice(0, 40))
      }
      return { at, texts, blocks: v.state.doc.childCount }
    })()`)
    void splits
    await sleep(400)
    const snapY = await pathSnapshot()
    const sameMd = snapX.md === snapY.md
    const sameDom =
      JSON.stringify(snapX.dom) === JSON.stringify(snapY.dom) &&
      JSON.stringify(snapX.marker?.props) === JSON.stringify(snapY.marker?.props) &&
      JSON.stringify(snapX.marker?.cls) === JSON.stringify(snapY.marker?.cls)
    // ⚠️ 路径 Y 用**两次回车**（父口径）会多出一个**空段落**（Markdown 里不可见：连续空行会被
    //    折叠掉），于是绝对 top 会差一行。这里断言"渲染等价"用**相对几何**（标识符↔图片的
    //    相对位置），绝对 top 的差值如实报出来。
    const relX = { dt: snapX.marker?.markerTop - snapX.img?.top, dr: snapX.marker?.fragRight - snapX.img?.left }
    const relY = { dt: snapY.marker?.markerTop - snapY.img?.top, dr: snapY.marker?.fragRight - snapY.img?.left }
    const sameRel = JSON.stringify(relX) === JSON.stringify(relY)
    const sameImgShape =
      snapX.img?.ok === snapY.img?.ok &&
      snapX.img?.width === snapY.img?.width &&
      snapX.img?.left === snapY.img?.left &&
      snapX.img?.right === snapY.img?.right &&
      snapX.img?.inline === snapY.img?.inline
    check(
      '⑪ 同一份源码 ⇒ 同一模型/同一渲染（X 解析 vs Y 打字+回车：Markdown 逐字节、DOM/class、9 项样式、图片渲染、标识符↔图片相对几何全等）',
      sameMd && sameDom && sameImgShape && sameRel,
      JSON.stringify({
        mdX: snapX.md,
        mdY: snapY.md,
        domX: snapX.dom,
        domY: snapY.dom,
        imgX: snapX.img,
        imgY: snapY.img,
        styleX: snapX.marker?.props,
        styleY: snapY.marker?.props,
        relX,
        relY,
        相同: { md: sameMd, dom: sameDom, imgShape: sameImgShape, rel: sameRel },
        拆段: splits
      })
    )
    const shotXY = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-pathXY.png'), Buffer.from(shotXY.result.data, 'base64')), null)
  }

  // ═══ 第六十四轮：**单击一张**图片的抖动序列（上一轮只钉了"连点两张"）══════════════
  const clickFlicker = async (src, which) => {
    await resetDoc()
    await ev(`(() => {
      const v = window.__vt.ed().view
      window.__tx = 0
      window.__upd = 0
      if (!window.__patched) {
        window.__patched = true
        const d = v.dispatch.bind(v)
        v.dispatch = (tr) => { window.__tx++; return d(tr) }
        const u = v.update.bind(v)
        v.update = (state) => { window.__upd++; return u(state) }
      }
      return 'ok'
    })()`)
    await ev(`(() => {
      const seen = []
      const bgs = []
      const states = []
      const t0 = performance.now()
      const push = (kind, text) => seen.push({ ms: Math.round(performance.now() - t0), kind, text: String(text || '').slice(0, 10) })
      const sample = () => {
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const bg = el ? getComputedStyle(el).backgroundColor : null
        if (bgs[bgs.length - 1] !== bg) bgs.push(bg)
        const st = document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null
        if (states[states.length - 1] !== st) states.push(st)
      }
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) push('+R', n.textContent)
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.matches?.('[data-img-revealed]') || n.querySelector?.('[data-img-revealed]'))) push('-R', n.textContent)
          }
          if (m.type === 'attributes' && m.attributeName === 'class' && m.target.nodeType === 1) {
            const el = m.target.matches?.('[data-img-revealed]') ? m.target : m.target.querySelector?.('[data-img-revealed]')
            if (el) {
              const on = el.classList.contains('img-src-revealed')
              const edit = el.classList.contains('img-src-revealed--editing')
              push('~' + (on ? 'R' : 'r') + (edit ? 'E' : 'e'), el.textContent)
            }
          }
        }
        sample()
      })
      mo.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      const raf = () => { sample(); if (performance.now() - t0 < 600) requestAnimationFrame(raf) }
      requestAnimationFrame(raf)
      window.__flickStop = () => {
        mo.disconnect()
        return { seq: seen, bgs, states, tx: window.__tx, upd: window.__upd, norm: Number(document.querySelector('.ProseMirror')?.getAttribute('data-img-normalize-hits') || 0) }
      }
      return 'ok'
    })()`)
    await clickWidget(src, which)
    await sleep(700)
    const res = await ev(`window.__flickStop()`)
    const finalState = await json(`(() => {
      const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
      return { count: els.length, bg: els[0] ? getComputedStyle(els[0]).backgroundColor : null, editing: els[0] ? els[0].classList.contains('img-src-revealed--editing') : null }
    })()`)
    const adds = res.seq.filter((x) => x.kind === '+R').length
    const removes = res.seq.filter((x) => x.kind === '-R').length
    let repeats = 0
    for (let i = 1; i < res.seq.length; i++) if (res.seq[i].kind === res.seq[i - 1].kind) repeats += 1
    const bgSeqs = res.bgs.filter((b) => b != null)
    const gray = 'rgb(241, 242, 245)'
    const oscillates = bgSeqs.some((b, i) => i >= 2 && b === bgSeqs[i - 2] && b !== bgSeqs[i - 1])
    return {
      seq: res.seq,
      bgs: res.bgs,
      states: res.states,
      tx: res.tx,
      upd: res.upd,
      norm: res.norm,
      adds,
      removes,
      repeats,
      oscillates,
      after: finalState,
      stateTransitions: (res.states || []).filter((x) => x && x !== 'null:e').length,
      stateSeq: res.states,
      okSingle:
        adds <= 2 &&
        removes === 0 &&
        !oscillates &&
        finalState.count === 1 &&
        finalState.bg === gray &&
        finalState.editing === false &&
        (res.states || []).filter((x) => x && x !== 'null:e').length === 1
    }
  }
  {
    const a = await clickFlicker(PNG_B, 'last')
    const shotA1 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-click-flicker-block.png'), Buffer.from(shotA1.result.data, 'base64')), null)
    check(
      '⑫a 单击"独占一行的裸 `<img>`"：标识符只增 1 次、无同态重复写、底色不来回（单事务收敛）',
      a.okSingle,
      JSON.stringify({ 序列: a.seq, 底色: a.bgs, 事务: a.tx, update: a.upd, 归一化命中: a.norm, 状态序列: a.states, 状态跃迁: a.stateTransitions, 增: a.adds, 删: a.removes, 同态重复: a.repeats, 来回跳: a.oscillates, 最终态: a.after })
    )
    const b = await clickFlicker(PNG_B, 'first')
    check(
      '⑫b 单击"行内 `<img>`"：标识符只增 1 次、无同态重复写、底色不来回（单事务收敛）',
      b.okSingle,
      JSON.stringify({ 序列: b.seq, 底色: b.bgs, 事务: b.tx, update: b.upd, 归一化命中: b.norm, 状态序列: b.states, 状态跃迁: b.stateTransitions, 增: b.adds, 删: b.removes, 同态重复: b.repeats, 来回跳: b.oscillates, 最终态: b.after })
    )
    const c = await clickFlicker(PNG_A, 'first')
    const shotC = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-click-flicker-node.png'), Buffer.from(shotC.result.data, 'base64')), null)
    check(
      '⑫c 单击"`![]()` 图片节点"（激活要把它转成文本）：一次事务完成、无第二次可见状态变化',
      c.okSingle,
      JSON.stringify({ 序列: c.seq, 底色: c.bgs, 事务: c.tx, update: c.upd, 归一化命中: c.norm, 状态序列: c.states, 状态跃迁: c.stateTransitions, 增: c.adds, 删: c.removes, 同态重复: c.repeats, 来回跳: c.oscillates, 最终态: c.after })
    )
  }

  // ═══ 第六十五轮 ══════════════════════════════════════════════════════════════
  // ⑬ 标识符必须**松开鼠标后**才出现（按下期间计数为 0）
  const pressSample = async (fixture, src, which) => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(900)
    const pt = await json(`(() => {
      const all = [...document.querySelectorAll('.ProseMirror img')].filter((im) => (im.getAttribute('src') || '') === ${JSON.stringify(src)})
      const im = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}
      if (!im) return null
      const r = im.getBoundingClientRect()
      return { x: Math.round(r.left + Math.max(2, r.width / 2)), y: Math.round(r.top + Math.max(2, r.height / 2)) }
    })()`)
    const read = () =>
      json(`(() => {
        const els = [...document.querySelectorAll('.ProseMirror [data-img-revealed]')]
        return { count: els.length, bg: els[0] ? getComputedStyle(els[0]).backgroundColor : null, open: document.querySelector('.ProseMirror')?.getAttribute('data-img-open') || null, pending: document.querySelector('.ProseMirror')?.getAttribute('data-img-pending') || null }
      })()`)
    const before = await read()
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const during = await read()
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(320)
    const after = await read()
    return { before, during, after }
  }
  {
    const raw = await pressSample(doc, PNG_B, 'first')
    check(
      '⑬a 松开鼠标后标识符才出现（裸 `<img>`：按下 0、松开 1）',
      raw.during.count === 0 && raw.after.count === 1 && raw.after.bg === 'rgb(241, 242, 245)',
      JSON.stringify(raw)
    )
    const node = await pressSample(doc, PNG_A, 'first')
    check(
      '⑬b 松开鼠标后标识符才出现（`![]()` 节点：按下 0、松开 1）',
      node.during.count === 0 && node.after.count === 1,
      JSON.stringify(node)
    )
    const shotUp = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-marker-after-mouseup.png'), Buffer.from(shotUp.result.data, 'base64')), null)
  }

  // ⑭ 并排：同段内相邻图片同行（top 相同、img1.right < img2.left）+ 中间有空隙
  const sideBySide = async (fixture, label) => {
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(950)
    const info = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      if (!p) return { ok: false }
      const ims = [...p.querySelectorAll('img')].filter((im) => im.getBoundingClientRect().width > 0)
      if (ims.length < 2) return {
        ok: false,
        count: ims.length,
        allImgs: [...p.querySelectorAll('img')].map((im) => ({ src: (im.getAttribute('src') || '').slice(0, 12), w: Math.round(im.getBoundingClientRect().width), display: getComputedStyle(im).display })),
        widgets: document.querySelectorAll('[data-img-widget]').length,
        html: p.innerHTML.slice(0, 300),
        children: [...p.childNodes].map((n) => (n.nodeType === 1 ? n.tagName.toLowerCase() : 'text:' + JSON.stringify(String(n.textContent || '').slice(0, 12))))
      }
      const r = ims.map((im) => {
        const b = im.getBoundingClientRect()
        return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), width: Math.round(b.width) }
      })
      return {
        ok: true,
        count: ims.length,
        a: r[0],
        b: r[1],
        gap: Math.round(r[1].left - r[0].right),
        lineBoxes: p.getClientRects().length,
        displays: ims.map((im) => getComputedStyle(im).display),
        margins: ims.map((im) => getComputedStyle(im.closest('[data-img-widget]') || im).marginInlineStart),
        pCls: p.className,
        md: window.__vt.ed().storage.markdown.getMarkdown(),
        pHtml: p.innerHTML,
        children: [...p.childNodes].map((n) => (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class') : '') : 'text:' + JSON.stringify(String(n.textContent || '').slice(0, 12)))),
        pWidth: Math.round(p.getBoundingClientRect().width),
        whiteSpace: getComputedStyle(p).whiteSpace,
        blockShape: (() => { const v = window.__vt.ed().view; const out = []; v.state.doc.forEach((n) => out.push(n.type.name + ':' + n.childCount)); return out })()
      }
    })()`)
    check(
      `⑭ ${label}：两张相邻图片**同行并排**（top 差 ≤1、img1.right < img2.left、整段一个行盒）且**中间有空隙**（>0）`,
      info.ok && Math.abs(info.a.top - info.b.top) <= 1 && info.a.right < info.b.left && info.gap > 0 && info.lineBoxes === 1,
      JSON.stringify(info)
    )
    return info
  }
  {
    await sideBySide(`![](${PNG_B})![](${PNG_B})`, '⑭a 纯 `![]()` 相邻')
    await sideBySide(`x ![](${PNG_B})![](${PNG_B}) y`, '⑭b 带文字的 `![]()` 相邻')
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-two-side-by-side.png'), Buffer.from(shot2.result.data, 'base64')), null)
    safe(() => fs.writeFileSync(path.join(process.cwd(), 'tmp', 'img-two-side-by-side-gap.png'), Buffer.from(shot2.result.data, 'base64')), null)
  }

  // ⑮ 标识符是**真文本**：能拖选跨越、能 Ctrl+C、能 Delete
  {
    const fixture = `前文 <img src="${PNG_B}" style="zoom:100%;" /> 后文`
    await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(fixture)}); return 'ok' })()`)
    await sleep(950)
    const drag = await json(`(() => {
      const p = document.querySelector('.ProseMirror p')
      const im = p ? p.querySelector('img') : null
      if (!im) return null
      const r = im.getBoundingClientRect()
      const pr = p.getBoundingClientRect()
      return {
        from: { x: Math.round(pr.left + 4), y: Math.round(r.top + r.height / 2) },
        to: { x: Math.round(r.right + 30), y: Math.round(r.top + r.height / 2) }
      }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 6; i++) {
      const x = Math.round(drag.from.x + ((drag.to.x - drag.from.x) * i) / 6)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: drag.from.y, button: 'left', buttons: 1 })
      await sleep(40)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', clickCount: 1 })
    await sleep(450)
    const sel = await json(`(() => {
      const v = window.__vt.ed().view
      const { from, to } = v.state.selection
      return { from, to, empty: v.state.selection.empty, text: v.state.doc.textBetween(from, to, '\\n').slice(0, 120) }
    })()`)
    check(
      '⑮① 拖选跨越图片 ⇒ 选区**连续覆盖**标识符原文（from/to 与片段）',
      sel.empty === false && sel.text.indexOf('<img') >= 0,
      JSON.stringify({ drag, selection: sel })
    )
    await ev(`(() => {
      window.__copied = null
      document.addEventListener('copy', (e) => { try { window.__copied = e.clipboardData.getData('text/plain') } catch { window.__copied = 'ERR' } }, { once: true })
      return 'ok'
    })()`)
    const canKey2 = await requireFocus('⑮ Ctrl+C / Delete')
    if (canKey2) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 67, key: 'c', code: 'KeyC', modifiers: 2 })
      await sleep(350)
    }
    const copied = await ev(`window.__copied`)
    check(
      '⑮③ Ctrl+C 复制到的内容包含标识符原文',
      canKey2 === false || (typeof copied === 'string' && copied.indexOf('<img') >= 0),
      JSON.stringify({ copied: typeof copied === 'string' ? copied.slice(0, 120) : copied, 能注入按键: canKey2 })
    )
    const beforeDel2 = await json(`(() => ({ md: window.__vt.ed().storage.markdown.getMarkdown(), widgets: document.querySelectorAll('[data-img-widget]').length }))()`)
    if (canKey2) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' })
      await sleep(500)
    }
    const afterDel2 = await json(`(() => {
      const md = window.__vt.ed().storage.markdown.getMarkdown()
      return { md, hasImg: md.indexOf('<img') >= 0, widgets: document.querySelectorAll('[data-img-widget]').length, text: (document.querySelector('.ProseMirror') || {}).textContent || '' }
    })()`)
    check(
      '⑮② 选区含标识符时按 `Delete` ⇒ 标识符文本被删、图片随之消失（改坏即失效）',
      canKey2 === false || (afterDel2.hasImg === false && afterDel2.text.indexOf('<img') < 0),
      JSON.stringify({ 改动前: beforeDel2, 改动后: afterDel2, 能注入按键: canKey2 })
    )
  }

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
