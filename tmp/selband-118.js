'use strict'
/**
 * 第一百一十八轮验收（**纯数值**，不用像素通道）：
 *  S1：含行内公式的行 ⇒ band 分段（公式段/正文段）的 top/bottom/height 与"块 line-height 行盒"逐项 Δ≤1，且无缝
 *  S2：拖动中 band 矩形集 vs 松手后用**同一几何函数+同一输入**算出的矩形集 ⇒ Δ≤1（正文/图片/行内公式/块级公式）
 * 手法：每个目标做一次"横越小拖"（按下→移动→读 data-sel-band-live→松开→读 data-sel-band-settled）
 * 用法：node tmp/selband-118.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\' + 'xw-selband-fixture.md'
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
  const click = async (x, y, s = 360) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
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
  const out = { tag: TAG, lines: [], targets: [] }
  /** 每个"行"的几何：块的 line-height + 该行内公式的 x 段 + 文本行的 x 范围 */
  out.lines = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const v = window.__vt.ed().view
    // 找出所有"含行内公式的块"里的行：用块内每个文本节点的 Range 逐行 rect 归组
    const res = []
    const blocks = [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]
    for (const b of blocks) {
      const maths = [...b.querySelectorAll('[data-md-math-rendered]')].map((m) => ({ ...R(m.getBoundingClientRect()), text: (m.textContent||'').slice(0,8) }))
      if (!maths.length) continue
      const lh = parseFloat(getComputedStyle(b).lineHeight)
      // 收集本块的文本 rect（按行归组）
      const rects = []
      const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walk.nextNode())) {
        if (!n.length) continue
        const rg = document.createRange(); rg.selectNodeContents(n)
        for (const r of rg.getClientRects()) if (r.width > 0.5) rects.push(R(r))
      }
      // 用行内公式的 x 判断"公式在行首/行中/行尾"
      for (const m of maths) {
        const rowRects = rects.filter((r) => m.t >= r.t - 20 && m.b <= r.b + 20)
        if (!rowRects.length) continue
        const left = Math.min(...rowRects.map((r) => r.l)), right = Math.max(...rowRects.map((r) => r.r))
        const rel = (m.l - left) / Math.max(1, right - left)
        res.push({ block: b.tagName, lineHeight: lh, formula: m, lineLeft: left, lineRight: right, lineTop: Math.min(...rowRects.map((r) => r.t)), lineBottom: Math.max(...rowRects.map((r) => r.b)), pos: rel < 0.15 ? 'start' : rel > 0.75 ? 'end' : 'mid', textRectHeights: rowRects.map((r) => +(r.b - r.t).toFixed(2)) })
      }
    }
    return res })()`)
  const parseBands = (s) => (s || '').split(';').filter(Boolean).map((t) => { const [l, tp, r, b] = t.split(',').map(Number); return { l, t: tp, r, b, h: +(b - tp).toFixed(2) } })
  /** 小拖：横跨某行文本（可选起点/终点） */
  const sweep = async (name, x0, y0, x1, y1, kind) => {
    await click(away.x, away.y, 260)
    await mouse('mousePressed', x0, y0)
    await sleep(30)
    const steps = 10
    for (let k = 1; k <= steps; k++) { await mouse('mouseMoved', x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, { buttons: 1 }); await sleep(16) }
    await sleep(40)
    const live = parseBands(await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-live')`))
    const liveImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const r = w.getBoundingClientRect(); const cs = getComputedStyle(w); return { from: w.getAttribute('data-img-from'), l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2), bg: cs.backgroundColor, outline: cs.outlineWidth } }))()`)
    const liveSel = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)
    await mouse('mouseReleased', x1, y1)
    await sleep(420)
    const settled = parseBands(await ev(`document.querySelector('.ProseMirror').getAttribute('data-sel-band-settled')`))
    const settledImgs = await json(`(() => [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => { const r = w.getBoundingClientRect(); const cs = getComputedStyle(w); return { from: w.getAttribute('data-img-from'), l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2), bg: cs.backgroundColor, outline: cs.outlineWidth } }))()`)
    const settledSel = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)
    const leak = await json(`(() => ({ bandEl: !!document.querySelector('.sel-band'), bandKids: document.querySelectorAll('.sel-band > div').length, cls: document.querySelectorAll('.ProseMirror .img-selected').length }))()`)
    // Δ（逐项配对：按顺序比）
    const deltas = []
    const n = Math.max(live.length, settled.length)
    for (let i = 0; i < n; i++) {
      const a = live[i], b = settled[i]
      if (!a || !b) { deltas.push({ i, missing: a ? 'settled' : 'live' }); continue }
      deltas.push({ i, dl: +Math.abs(a.l - b.l).toFixed(2), dt: +Math.abs(a.t - b.t).toFixed(2), dr: +Math.abs(a.r - b.r).toFixed(2), db: +Math.abs(a.b - b.b).toFixed(2), dh: +Math.abs(a.h - b.h).toFixed(2) })
    }
    const g = { name, kind, liveSel, settledSel, live, settled, deltas, liveImgs, settledImgs, leak }
    out.targets.push(g)
    console.log(`\n== ${name} (${kind}) liveSel=${liveSel} settledSel=${settledSel}`)
    console.log('   live   ' + JSON.stringify(live))
    console.log('   settled' + JSON.stringify(settled))
    console.log('   Δ      ' + JSON.stringify(deltas))
    console.log('   img live/ settled ' + JSON.stringify(liveImgs) + ' / ' + JSON.stringify(settledImgs) + ' 泄漏=' + JSON.stringify(leak))
    return g
  }
  const imgBlock = out.lines.find((l) => true)
  // 行的 x 范围来自文本 rect 的并（取该行的第一个/最后一个 rect）
  const lineOf = (pred) => {
    const cands = out.lines.filter(pred)
    return cands[0]
  }
  const startLine = lineOf((l) => l.pos === 'start')
  const midLine = lineOf((l) => l.pos === 'mid')
  const endLine = lineOf((l) => l.pos === 'end')
  out.picked = { startLine, midLine, endLine }
  const sweepLine = async (name, L) => {
    if (!L) { console.log('!! 缺行 ' + name); return null }
    const y = Math.round((L.formula.t + L.formula.b) / 2)
    return sweep(`${name} (公式${L.pos})`, Math.round(L.lineLeft + 3), y, Math.round(L.lineRight - 3), y, 'text+formula')
  }
  await sweepLine('S1-行首公式', startLine)
  await sweepLine('S1-行中公式', midLine)
  await sweepLine('S1-行尾公式', endLine)
  // 块级公式：拖过块级公式所在块的一行
  const blockMath = await json(`(() => { const m = document.querySelector('.ProseMirror [data-md-math-block]'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2) } })()`)
  out.blockMath = blockMath
  if (blockMath) {
    const y = Math.round((blockMath.t + blockMath.b) / 2)
    await sweep('S2-块级公式', Math.round(blockMath.l + 6), y, Math.round(Math.min(blockMath.r - 6, blockMath.l + 300)), y, 'block-math')
  }
  // 图片：从图片后往左拖（同一手势的 live vs settled + img-selected 盒）
  const geo = await json(`(() => { const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) }); const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const ws = [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())); const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent||'').trim().length > 3); const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length)); return { widgets: ws, text: R(rg.getBoundingClientRect()) } })()`)
  await sweep('S2-图片(图后往左拖)', Math.round(geo.widgets[1].r + 40), Math.round((geo.widgets[1].t + geo.widgets[1].b) / 2), Math.round(geo.text.l + 6), Math.round((geo.text.t + geo.text.b) / 2), 'image')
  // 红值：旧做法（文字盒）在同一行的几何
  out.textBoxRed = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent||'').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, tn.length)
    return { lineHeight: getComputedStyle(p).lineHeight, rects: [...rg.getClientRects()].map(R) } })()`)
  try { await shotFile({ x: Math.max(0, Math.floor(geo.text.l) - 30), y: Math.max(0, Math.floor(geo.text.t) - 24), width: 900, height: 120 }, 'tmp/math-select-band.png') } catch (e) { /* 可选 */ }
  fs.writeFileSync(`tmp/selband118-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log('\n红值（旧做法 = 文字盒）: lineHeight=' + out.textBoxRed.lineHeight + ' rects=' + JSON.stringify(out.textBoxRed.rects.map((r) => ({ x: [Math.round(r.l), Math.round(r.r)], h: r.h }))))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
