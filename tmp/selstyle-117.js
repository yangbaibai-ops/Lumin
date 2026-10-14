'use strict'
/**
 * 第一百一十七轮验收：S1（行内公式选中带与正文同高连续）、S2（拖动中 ≡ 松手后）
 * 手法：截图 + 像素逐列分析（`tmp/png.js`）—— 因为"松手后浏览器画的带"没有任何 DOM 矩形可读
 * 用法：node tmp/selstyle-117.js <port> <tag>
 */
const fs = require('fs')
const { decodePNG } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-selstyle-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 380) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
  const grab = async (clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    return decodePNG(Buffer.from(r.result.data, 'base64'))
  }
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  /** 逐列找"与基线不同的 y 区间" ⇒ 每列一条 [top,bottom]（相对 clip），再按区间分组 */
  const bandColumns = (base, cur) => {
    const { w, h } = { w: cur.width, h: cur.height }
    const cols = []
    for (let x = 0; x < w; x++) {
      let top = -1, bot = -1
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4
        const d = Math.abs(base.data[i] - cur.data[i]) + Math.abs(base.data[i + 1] - cur.data[i + 1]) + Math.abs(base.data[i + 2] - cur.data[i + 2])
        if (d > 24) { if (top < 0) top = y; bot = y }
      }
      cols.push(top < 0 ? null : { top, bottom: bot, height: bot - top + 1 })
    }
    // 分段：相邻列（±1px 容差）top/bottom 相同即同一段
    const segs = []
    let curSeg = null
    for (let x = 0; x < w; x++) {
      const c = cols[x]
      if (!c) { if (curSeg) { segs.push(curSeg); curSeg = null } continue }
      if (curSeg && Math.abs(c.top - curSeg.top) <= 1 && Math.abs(c.bottom - curSeg.bottom) <= 1) { curSeg.right = x; curSeg.bottom = Math.max(curSeg.bottom, c.bottom); curSeg.top = Math.min(curSeg.top, c.top) }
      else { if (curSeg) segs.push(curSeg); curSeg = { left: x, right: x, top: c.top, bottom: c.bottom } }
    }
    if (curSeg) segs.push(curSeg)
    return segs.filter((s) => s.right - s.left >= 2).map((s) => ({ ...s, height: s.bottom - s.top + 1 }))
  }

  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900); await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  const out = { tag: TAG }
  // 目标段落（含两段行内公式）
  const geo = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const math = [...p.querySelectorAll('[data-md-math-rendered]')].map((m) => R(m.getBoundingClientRect()))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    const line = R(rg.getBoundingClientRect())
    return { para: R(p.getBoundingClientRect()), math, line, lineHeight: getComputedStyle(p).lineHeight,
      widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())) }
  })()`)
  out.geo = geo
  // 行内公式覆盖的 x 段（公式本体）与正文段：用 clip 局部坐标
  const clip = { x: Math.max(0, Math.floor(geo.para.l) - 4), y: Math.max(0, Math.floor(geo.para.t) - 4), width: Math.min(1180, Math.ceil(geo.para.w) + 8), height: Math.min(300, Math.ceil(geo.para.h) + 8) }
  out.clip = clip
  const toLocal = (r) => ({ left: Math.round(r.l - clip.x), right: Math.round(r.r - clip.x), top: Math.round(r.t - clip.y), bottom: Math.round(r.b - clip.y) })
  out.inlineMathLocal = geo.math.map(toLocal)
  out.lineLocal = toLocal(geo.line)
  // 基线（无选区）
  await click(away.x, away.y, 300)
  const base = await grab(clip)
  // ① S1：程序化选中整行（118..153 覆盖两段行内公式 + 正文）
  const selRange = await ev(`(() => {
    const v = window.__vt.ed().view
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 118, 153)))
    return 'ok' })()`)
  await sleep(300)
  await shotFile(clip, 'tmp/math-select-band.png')
  const s1 = await grab(clip)
  const s1segs = bandColumns(base, s1)
  out.s1 = { segs: s1segs, selRange }
  // 文字盒高度（旧做法 = Highlight 的几何）对照
  out.textBox = await json(`(() => {
    const v = window.__vt.ed().view
    const a = v.domAtPos(118), b = v.domAtPos(153)
    const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset)
    return [...r.getClientRects()].map((x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) })) })()`)
  // ② S2：同一段选区的"拖动中"（未松手）vs "松手后"
  //    起点：正文左端；终点：正文右端（区间同为 [118,152]，与上面的 118..153 同排）
  const dragFrom = { x: Math.round(geo.line.l + 4), y: Math.round((geo.line.t + geo.line.b) / 2) }
  const dragTo = { x: Math.round(geo.line.r - 4), y: Math.round((geo.line.t + geo.line.b) / 2) }
  await click(away.x, away.y, 300)
  const base2 = await grab(clip)
  await mouse('mousePressed', dragFrom.x, dragFrom.y)
  await sleep(30)
  for (let k = 1; k <= 14; k++) { await mouse('mouseMoved', dragFrom.x + ((dragTo.x - dragFrom.x) * k) / 14, dragFrom.y, { buttons: 1 }); await sleep(16) }
  await sleep(60)
  const live = await grab(clip)
  await shotFile(clip, 'tmp/live-equals-settled.png')
  const liveSegs = bandColumns(base2, live)
  const liveDom = await json(`(() => [...document.querySelectorAll('.sel-band > div')].map((d) => { const r = d.getBoundingClientRect(); return { l: +r.left.toFixed(2), t: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), bg: getComputedStyle(d).backgroundColor } }))()`)
  const liveImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const cs = getComputedStyle(w); return { from: w.getAttribute('data-img-from'), bg: cs.backgroundColor, outline: cs.outlineWidth + ' ' + cs.outlineColor, cls: w.className } }))()`)
  await mouse('mouseReleased', dragTo.x, dragTo.y)
  await sleep(420)
  const settledPix = await grab(clip)
  const settledSegs = bandColumns(base2, settledPix)
  const settledImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const cs = getComputedStyle(w); return { from: w.getAttribute('data-img-from'), bg: cs.backgroundColor, outline: cs.outlineWidth + ' ' + cs.outlineColor, cls: w.className } }))()`)
  const settledSel = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)
  const liveSel = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)
  const leak = await json(`(() => ({ bandEl: !!document.querySelector('.sel-band'), children: document.querySelectorAll('.sel-band > div').length, hl: (() => { try { return CSS.highlights.get('lumin-img-drag') ? 1 : 0 } catch (e) { return -1 } })() }))()`)
  out.s2 = { dragFrom, dragTo, liveSel, settledSel, liveSegs, settledSegs, liveDom, liveImgs, settledImgs, leak }
  out.dragFrom = dragFrom
  out.dragTo = dragTo
  fs.writeFileSync(`tmp/selstyle117-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log('geo.line', JSON.stringify(out.lineLocal), 'lineHeight', geo.lineHeight, 'inlineMath', JSON.stringify(out.inlineMathLocal))
  console.log('旧做法(文字盒) rects', JSON.stringify(out.textBox))
  console.log('S1 程序化 [118,153] 像素分段', JSON.stringify(s1segs))
  console.log('S2 拖动中 像素分段', JSON.stringify(liveSegs))
  console.log('S2 拖动中 DOM 带', JSON.stringify(liveDom))
  console.log('S2 松手后 像素分段', JSON.stringify(settledSegs))
  console.log('S2 拖动中 img', JSON.stringify(liveImgs), '| 松手后 img', JSON.stringify(settledImgs))
  console.log('S2 sel', liveSel, '->', settledSel, '泄漏', JSON.stringify(leak))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
