'use strict'
/**
 * 第一百二十三轮 · **最小探针**（替代跑不动的 `tmp/tail-114.js`）：
 * 丢尾巴三项（逐帧远端不回缩 / 可见并集不回缩 / 终态非空且无泄漏）+ 三条手势无回摆 + A/C/D 逐字值。
 * 手势与 tail-114 一致（夹具 `%TEMP%\xw-tail-fixture.md`）：
 *   A 图片后→左拖  C 公式后→左拖  D 公式后→右拖  E1/E2 图片后→左拖(源码显形)  F 正文起手→右拖过图
 * 用法：node tmp/acd-123.js <port> <tag>
 */
const fs = require('fs')
const path = require('path')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-tail-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (t, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type: t, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }

  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(1000)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  const geo = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const math = [...p.querySelectorAll('[data-md-math-rendered],[data-md-math-block]')].map((m) => R(m.getBoundingClientRect()))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    return { widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())), math, text: R(rg.getBoundingClientRect()), para: R(p.getBoundingClientRect()) } })()`)
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent || '').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) } })()`)

  const snap = () => json(`(() => {
    const s = window.__vt.ed().state.selection
    const pm = document.querySelector('.ProseMirror')
    const live = pm.getAttribute('data-img-drag-live') || ''
    const parts = live ? live.split('|').map(Number) : []
    const rects = (rs) => { let x0 = null, x1 = null; for (const c of rs) { x0 = x0 == null ? c.left : Math.min(x0, c.left); x1 = x1 == null ? c.right : Math.max(x1, c.right) } return x0 == null ? null : [x0, x1] }
    let domX = null, domLen = 0
    try { const q2 = window.getSelection(); if (q2 && q2.rangeCount) { const r = q2.getRangeAt(0); domLen = (r.toString() || '').length; domX = rects(r.getClientRects()) } } catch (e) {}
    let hlX = null, hlN = 0
    try { const h = CSS.highlights.get('lumin-img-drag'); if (h) { const acc = []; for (const r of h) { hlN++; for (const c of r.getClientRects()) acc.push(c) } hlX = rects(acc) } } catch (e) {}
    const band = [...document.querySelectorAll('.sel-band > div')].map((d) => { const r = d.getBoundingClientRect(); return [+r.left.toFixed(1), +r.top.toFixed(1), +r.right.toFixed(1), +r.bottom.toFixed(1)] })
    const bandX = band.length ? [Math.min(...band.map((b) => b[0])), Math.max(...band.map((b) => b[2]))] : null
    const u = (a, b) => (a == null ? b : b == null ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])])
    const uX = u(u(domX, hlX), bandX)
    return { anchor: parts[0] ?? null, head: parts[1] ?? null, pFrom: parts[2] ?? null, pTo: parts[3] ?? null,
      sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), own: pm.getAttribute('data-sel-own'),
      imgSel: document.querySelectorAll('.ProseMirror .img-selected').length, hlN, domLen,
      uX: uX == null ? null : [Math.round(uX[0]), Math.round(uX[1])] } })()`)

  const drag = async (name, from, to, frames = 26, opts = {}) => {
    for (let k = 0; k < 3; k++) { if (!(await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`))) break; await click(away.x, away.y, 300) }
    await click(away.x, away.y, 260)
    if (opts.reveal) { for (let k = 0; k < 3; k++) { await click(Math.round(geo.widgets[1].r + 40), Math.round((geo.widgets[1].t + geo.widgets[1].b) / 2), 620); if (await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)) break } }
    const fs2 = []
    await mouse('mousePressed', from.x, from.y); await sleep(25)
    fs2.push({ i: -1, ...(await snap()) })
    for (let k = 1; k <= frames; k++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / frames, from.y + ((to.y - from.y) * k) / frames, { buttons: 1 })
      fs2.push({ i: k, ...(await snap()) })
      await sleep(11)
    }
    const pre = await snap()
    await mouse('mouseReleased', to.x, to.y)
    await sleep(430)
    const post = await json(`(() => { const s = window.__vt.ed().state.selection; return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), text: window.__vt.ed().state.doc.textBetween(s.from, s.to, '\\n').slice(0, 60), marked: document.querySelectorAll('.ProseMirror .img-selected').length, band: document.querySelectorAll('.sel-band > div').length, own: document.querySelector('.ProseMirror').getAttribute('data-sel-own'), hlNow: (() => { try { return CSS.highlights.get('lumin-img-drag') ? 1 : 0 } catch (e) { return -1 } })(), md: window.__vt.ed().storage.markdown.getMarkdown().slice(0, 40) } })()`)
    const shrink = []
    const shrinkU = []
    for (let k = 1; k < fs2.length; k++) {
      const a = fs2[k - 1], b = fs2[k]
      if (a.pFrom != null && b.pFrom != null && a.anchor != null) {
        // 远端 = 离锚点更远的那一端（向左拖时远端是 pFrom）
        const far = (f) => (Math.abs(f.pFrom - f.anchor) >= Math.abs(f.pTo - f.anchor) ? f.pFrom : f.pTo)
        const fa = Math.abs(far(a) - a.anchor), fb = Math.abs(far(b) - b.anchor)
        if (fb < fa) shrink.push({ i: b.i, prev: far(a), now: far(b), anchor: a.anchor })
      }
      if (a.uX && b.uX) {
        const dir = b.uX[0] > a.uX[0] + 1 ? 'left' : b.uX[1] < a.uX[1] - 1 ? 'right' : null
        if (dir) shrinkU.push({ i: b.i, dir, prevX: a.uX, nowX: b.uX, sel: b.sel, pFrom: b.pFrom, pTo: b.pTo })
      }
    }
    const seq = fs2.map((f) => `${f.pFrom}-${f.pTo}(a${f.anchor},sel${f.sel},img${f.imgSel},uX${JSON.stringify(f.uX)})`)
    const dedup = seq.filter((s, i, a) => i === 0 || s !== a[i - 1])
    log(`\n== ${name}  (${from.x},${from.y}) → (${to.x},${to.y})`)
    log(`   回缩帧=${shrink.length} 并集回缩帧=${shrinkU.length}${shrink.length ? ' ' + JSON.stringify(shrink) : ''}${shrinkU.length ? ' ' + JSON.stringify(shrinkU) : ''}`)
    log(`   松手前 paint=${pre.pFrom}-${pre.pTo} imgSel=${pre.imgSel} uX=${JSON.stringify(pre.uX)} | 松手后 ${JSON.stringify(post)}`)
    log(`   去重序列(${dedup.length}/${seq.length}) ${JSON.stringify(dedup.slice(0, 10))}`)
    return { name, from, to, shrink, shrinkU, pre, post, dedup, frames: fs2 }
  }

  const w0 = geo.widgets[0]
  const w1 = geo.widgets[1]
  const textY = Math.round((geo.text.t + geo.text.b) / 2)
  const imgMidY = Math.round((w1.t + w1.b) / 2)
  const m0 = geo.math[0]
  const m1 = geo.math[geo.math.length - 1]
  const mathY = m0 ? Math.round((m0.t + m0.b) / 2) : textY
  log(`# 夹具几何：图0=${JSON.stringify(w0)} 图1=${JSON.stringify(w1)} 公式[0]=${JSON.stringify(m0)} 公式[last]=${JSON.stringify(m1)} 文本=${JSON.stringify(geo.text)} 段=${JSON.stringify(geo.para)}`)
  const out = { tag: TAG, geo, gestures: [] }
  out.gestures.push(await drag('A 图片后→左拖(未显形)', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 30))
  out.gestures.push(await drag('C 公式后→左拖(未显形)', { x: Math.round((m1 ? m1.r : w0.l) + 6), y: mathY }, { x: Math.round(geo.text.l + 6), y: textY }, 26))
  out.gestures.push(await drag('D 公式后→右拖(未显形)', { x: Math.round((m0 ? m0.r : 500) + 10), y: mathY }, { x: Math.round(geo.para.r - 8), y: textY }, 24))
  out.gestures.push(await drag('E1 图片后→左拖(显形)', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 26, { reveal: true }))
  out.gestures.push(await drag('E2 图片后→左拖(显形)', { x: Math.round(w1.r + 40), y: imgMidY }, { x: Math.round(geo.text.l + 6), y: textY }, 26, { reveal: true }))
  out.gestures.push(await drag('F 正文起手→右拖过两图(未显形)', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w1.r + 30), y: imgMidY }, 26))
  // 不破坏项（最小集）
  const broken = {}
  try {
    await click(away.x, away.y, 300)
    const bandClick = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = p.querySelector('[data-img-widget]'); const r = w.getBoundingClientRect(); return { x: Math.round(r.right + 40), y: Math.round((r.top + r.bottom) / 2) } })()`)
    await click(bandClick.x, bandClick.y, 500)
    broken.blankClick = await json(`(() => { const s = window.__vt.ed().state.selection; return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length } })()`)
    await click(away.x, away.y, 300)
    const rt = await json(`(() => { const md = window.__vt.ed().storage.markdown.getMarkdown(); window.__rtMd = md; window.__vt.ed().commands.setContent(md); return { len: md.length } })()`)
    await sleep(700)
    broken.roundTrip = await json(`(() => { const md = window.__vt.ed().storage.markdown.getMarkdown(); return { len: md.length, byteEqual: md === window.__rtMd } })()`)
    broken.rt = rt
  } catch (e) {
    broken.error = String(e && e.message)
  }
  out.broken = broken
  log(`\n# 不破坏项：空白带单击=${JSON.stringify(broken.blankClick)} 往返=${JSON.stringify(broken.roundTrip)}`)
  fs.writeFileSync(path.join(__dirname, `shots-121`, `acd123-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`# 证据：tmp/shots-121/acd123-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
