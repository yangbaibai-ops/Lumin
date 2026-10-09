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
/** 与 A 不同的一张（同样的 1×1，但字节不同 —— 用来区分"是哪一段的图片"） */
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const MD =
  `![](PLACE_A)\n\n` +
  `qian <img src="PLACE_B" style="zoom:50%;" /> hou\n\n` +
  `![remote](https://example.com/x.png)\n\n最后一段文字。\n`

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
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  const doc = MD.replace('PLACE_A', PNG_A).replace('PLACE_B', PNG_B)
  // 用源码面灌内容（走真实解析路径：`<img>` 行内原文 ↔ 独立成行时的 html_block 都是解析器定的）
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(doc)}); return 'ok' })()`)
  await sleep(1000)

  const state = () =>
    json(`(() => {
      const line = document.querySelector('[data-img-source]')
      const bar = document.querySelector('[data-img-zoom-bar]')
      return {
        hasLine: !!line,
        lineText: line ? line.textContent : null,
        lineKind: line ? line.getAttribute('data-img-kind') : null,
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
    '②A 点图片 ⇒ 上方出现源码行且内容 == 该图 markdown',
    A.hasLine && A.lineText === `![](${PNG_A})` && A.lineKind === 'node',
    JSON.stringify({ hasLine: A.hasLine, kind: A.lineKind, lineText: (A.lineText || '').slice(0, 30) })
  )
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'img-source-toolbar.png'), Buffer.from(shot1.result.data, 'base64')), null)

  // ── ③ 悬浮工具栏（此刻源码行开着）──
  const bar = await json(`(() => {
    const b = document.querySelector('[data-img-zoom-bar]')
    const line = document.querySelector('[data-img-source]')
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
      before: before75.lineText ? before75.lineText.slice(0, 24) : null
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
    D.hasLine && D.lineKind === 'raw' && D.lineText === `<img src="${PNG_B}" style="zoom:75%;" />`,
    JSON.stringify({ rawRange, hasLine: D.hasLine, kind: D.lineKind, text: (D.lineText || '').slice(0, 40) })
  )
  await ev(`(() => { window.__vt.ed().commands.setTextSelection({ from: ${rawRange.from - 1}, to: ${rawRange.to + 1} }); return 'ok' })()`)
  await sleep(400)
  const C = await state()
  check('②C 选区**完全包住**构造 ⇒ 不显示', C.hasLine === false, JSON.stringify({ rawRange, hasLine: C.hasLine }))

  // ── ⑤ 远程图片：无占位图标/文案；未点击不发请求 ──
  const guard = await json(`(() => {
    const els = [...document.querySelectorAll('.img-guard')]
    const first = els[0] || null
    const cs = first ? getComputedStyle(first, '::before') : null
    return {
      count: els.length,
      childNodes: first ? first.childNodes.length : -1,
      text: first ? first.textContent : null,
      labels: document.querySelectorAll('.img-guard__label').length,
      svgs: document.querySelectorAll('.img-guard svg, .img-guard img').length,
      hasSrc: first ? first.hasAttribute('src') : null,
      dataSrc: first ? first.getAttribute('data-src') : null,
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
  safe(() => fs.writeFileSync(path.join(process.cwd(), 'img-centered.png'), Buffer.from(shot2.result.data, 'base64')), null)

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
