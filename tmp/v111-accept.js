'use strict'
/**
 * 第一百一十一轮验收：图片实体周边拖选（源码未显形）
 * 用法：node tmp/v111-accept.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-behind-fixture.md'
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
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, settle = 400) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(settle) }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
  const startSampler = async (ms = 1400) => {
    await ev(`window.__frames = (async () => {
      const o = []; const t0 = performance.now()
      const snap = () => {
        const s = window.__vt.ed().state.selection
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        return { t: +(performance.now()-t0).toFixed(1), from: s.from, to: s.to, empty: s.empty,
          ov: document.querySelectorAll('.img-src-overlay > div').length,
          revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
          cls: el ? String(el.className).replace('img-src-revealed--editing','RE').replace('img-src-revealed','R') : null }
      }
      let done = false
      const finish = (res) => { if (done) return; done = true; res(o) }
      return await new Promise((res) => {
        const step = () => { if (done) return; o.push(snap()); if (performance.now()-t0 > ${ms}) finish(res); else requestAnimationFrame(step) }
        requestAnimationFrame(step)
        setTimeout(() => { if (!done) { o.push(snap()); finish(res) } }, ${ms} + 500)
      }) })(); 'started'`, false)
  }
  const readSampler = () => ev(`window.__frames.then((r) => JSON.stringify(r))`).then((s) => JSON.parse(s))
  const dedupe = (frames) => {
    const out = []
    for (const f of frames) {
      const k = `${f.from}-${f.to}-${f.empty ? 'E' : '-'}|ov${f.ov}|${f.cls || '-'}`
      if (!out.length || out[out.length - 1].k !== k) out.push({ k, t: f.t })
    }
    return out.map((x) => `${x.t}ms ${x.k}`)
  }
  const selOf = () => json(`(() => {
    const s = window.__vt.ed().state.selection
    const v = window.__vt.ed().view
    return { from: s.from, to: s.to, empty: s.empty, anchor: s.anchor, head: s.head,
      frag: s.empty ? '' : v.state.doc.textBetween(s.from, s.to, '\\n').slice(0, 140) }
  })()`)

  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  log('setup done')
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  const out = { tag: TAG, innerWidth: await ev(`innerWidth`) }
  const sha = () => ev(`(async () => { const md = window.__vt.ed().storage.markdown.getMarkdown(); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('') })()`)
  out.shaBefore = await sha()
  out.boxes = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const v = window.__vt.ed().view
    const ranges = []
    v.state.doc.descendants((node, pos) => {
      if (!node.isText) return true
      const t = node.text || ''
      for (const m of t.matchAll(/<img\\b[^>]*\\/?>/gi)) { const at = m.index || 0; ranges.push({ from: pos + at, to: pos + at + m[0].length }) }
      return true
    })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    return { ranges, widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => ({ from: Number(w.getAttribute('data-img-from')), inline: w.getAttribute('data-img-inline'), ...R(w.getBoundingClientRect()) })), text: R(rg.getBoundingClientRect()), para: R(p.getBoundingClientRect()), state0: { revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length } }
  })()`)
  const W = out.boxes.widgets
  const w0 = W[0]
  const w1 = W[1]
  const midY0 = Math.round((w0.t + w0.b) / 2)
  const midY1 = Math.round((w1.t + w1.b) / 2)
  const textY = Math.round((out.boxes.text.t + out.boxes.text.b) / 2)
  out.deadzone = await json(`(() => {
    const v = window.__vt.ed().view
    const at = (x, y) => { const p = v.posAtCoords({ left: x, top: y }); return p ? p.pos : null }
    const w = document.querySelector('.ProseMirror [data-img-widget]')
    const r = w.getBoundingClientRect()
    const y = Math.round((r.top + r.bottom) / 2)
    return [0.05, 0.25, 0.5, 0.75, 0.95].map((f) => ({ x: Math.round(r.left + r.width * f), pos: at(Math.round(r.left + r.width * f), y) }))
  })()`)
  log('boxes done')

  const gesture = async (name, from, to, steps = 16) => {
    const pre = await selOf()
    await startSampler(1500)
    await sleep(50)
    await mouse('mousePressed', from.x, from.y)
    await sleep(45)
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 })
      await sleep(22)
    }
    await sleep(60)
    const beforeUp = await selOf()
    await mouse('mouseReleased', to.x, to.y)
    await sleep(520)
    const afterUp = await selOf()
    const frames = await readSampler()
    const g = { name, from, to, pre, beforeUp, afterUp, seq: dedupe(frames), frames: frames.length }
    log(`${name}: after=${afterUp.from}-${afterUp.to}-${afterUp.empty ? 'E' : '-'}`)
    return g
  }

  out.gestures = []
  out.gestures.push(await gesture('① 图后(右) → 向左拖', { x: Math.round(w1.r + 40), y: midY1 }, { x: Math.round(w0.l + 6), y: midY0 }))
  out.gestures.push(await gesture('② 文字 → 向右拖过图', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w1.r + 30), y: midY1 }))
  out.gestures.push(await gesture('③a 图下方 → 向左拖', { x: Math.round((w0.l + w0.r) / 2), y: Math.round(w0.b - 3) }, { x: Math.round(w0.l + 4), y: midY0 }))
  out.gestures.push(await gesture('③b 图上方 → 向左拖', { x: Math.round((w0.l + w0.r) / 2), y: Math.round(w0.t + 3) }, { x: Math.round(w0.l + 4), y: midY0 }))
  out.gestures.push(await gesture('④a 松在图盒左半', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w0.l + w0.w * 0.25), y: midY0 }))
  out.gestures.push(await gesture('④b 松在图盒右半', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w0.l + w0.w * 0.75), y: midY0 }))
  const clip = { x: Math.max(0, Math.floor(out.boxes.para.l) - 20), y: Math.max(0, Math.floor(out.boxes.para.t) - 20), width: Math.min(1200, Math.ceil(out.boxes.para.w) + 40), height: Math.ceil(out.boxes.para.h) + 40 }
  await shotFile(clip, 'tmp/img-behind-drag.png')
  out.clip = clip
  log('gestures done')

  const resetRevealed = async () => {
    await click(away.x, away.y, 320)
    let from = null
    for (let i = 0; i < 3; i++) {
      const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      if (!pt) break
      await click(pt.x, pt.y, 750)
      from = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)
      if (from === 254) break
      await click(away.x, away.y, 300)
    }
    await ev(`(() => { const v = window.__vt.ed().view; const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return 'no'; const f = Number(el.getAttribute('data-img-from')); const to = f + (el.textContent||'').length; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, to))); return 'ok' })()`)
    await sleep(400)
    return json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
      const s = window.__vt.ed().state.selection
      return { revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, from: el ? Number(el.getAttribute('data-img-from')) : null, cls: el ? String(el.className) : null, bg: el ? getComputedStyle(el).backgroundColor : null, ov: document.querySelectorAll('.img-src-overlay > div').length, sel: { from: s.from, to: s.to }, frags: el ? [...el.getClientRects()].map(R) : [], ovRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())) }
    })()`)
  }
  out.keep = {}
  const st = await resetRevealed()
  out.keep.revealed = st
  log('revealed state: ov=' + st.ov + ' from=' + st.from)
  if (st.ov > 0) {
    const f0 = st.frags[0]
    const bandY = Math.round((f0.b + st.ovRects[0].b) / 2)
    const midX = Math.round((f0.l + f0.r) / 2)
    const glyphY = Math.round((f0.t + f0.b) / 2)
    await click(midX, bandY)
    out.keep.bandClick = await selOf()
    out.keep.bandClickRevealed = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
    const dragPath = async (x0, y0, x1, y1) => {
      await mouse('mousePressed', x0, y0); await sleep(40)
      for (let i = 1; i <= 14; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 14, y0 + ((y1 - y0) * i) / 14, { buttons: 1 }); await sleep(18) }
      await sleep(40); await mouse('mouseReleased', x1, y1); await sleep(300)
      return selOf()
    }
    await resetRevealed()
    const bandDrag = await dragPath(midX, bandY, Math.round(f0.l + 380), glyphY)
    await resetRevealed()
    const glyphDrag = await dragPath(midX, glyphY, Math.round(f0.l + 380), glyphY)
    out.keep.bandDrag = bandDrag
    out.keep.glyphDrag = glyphDrag
    out.keep.bandDragDelta = { dFrom: Math.abs(bandDrag.from - glyphDrag.from), dTo: Math.abs(bandDrag.to - glyphDrag.to) }
    await resetRevealed()
    out.keep.glyphDragOnly = await dragPath(Math.round(f0.l + 20), glyphY, Math.round(f0.l + 200), glyphY)
  }
  await click(away.x, away.y)
  out.keep.elsewhere = { revealed: await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`) }
  await resetRevealed()
  await click(away.x, away.y, 300)
  const wpt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await startSampler(700)
  await sleep(40)
  await mouse('mousePressed', wpt.x, wpt.y)
  await sleep(150)
  out.keep.press = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  await mouse('mouseReleased', wpt.x, wpt.y)
  await sleep(420)
  out.keep.release = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  out.keep.releaseBg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)
  out.keep.revealSeq = dedupe(await readSampler())
  await resetRevealed()
  out.keep.hit = await json(`(() => {
    const j = (el) => ({ tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 34) : null, overlay: !!(el && el.closest && el.closest('.img-src-overlay')) })
    const ov = document.querySelector('.img-src-overlay > div')
    const o = ov ? ov.getBoundingClientRect() : { left: 0, top: 0, right: 1, bottom: 1 }
    return { mid: j(document.elementFromPoint(Math.round((o.left + o.right) / 2), Math.round((o.top + o.bottom) / 2))) }
  })()`)
  const measure = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight }
  })()`)
  out.keep.layoutOn = await measure()
  await ev(`(() => { const s = document.createElement('style'); s.id='xw-off'; s.textContent='.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
  await sleep(300)
  out.keep.layoutOff = await measure()
  await ev(`document.getElementById('xw-off')?.remove()`)
  await sleep(250)
  out.keep.layoutSame = ['para', 'imgs', 'h2', 'scrollH'].every((k) => JSON.stringify(out.keep.layoutOn[k]) === JSON.stringify(out.keep.layoutOff[k]))
  await resetRevealed()
  const tp = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); const a = Math.min(20, Math.max(0, tn.length - 3)); const rg = document.createRange(); rg.setStart(tn, a); rg.setEnd(tn, Math.min(a+3, tn.length)); const r = rg.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  for (let k = 0; k < 2; k++) { await click(tp.x, tp.y, 600); if (await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? el.classList.contains('img-src-revealed--editing') : false })()`)) break }
  out.keep.editing = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return { cls: el ? String(el.className) : null, bg: el ? getComputedStyle(el).backgroundColor : null, ov: document.querySelectorAll('.img-src-overlay > div').length, ovEl: !!document.querySelector('.img-src-overlay') } })()`)
  await click(away.x, away.y)
  out.keep.hidden = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, ovEl: !!document.querySelector('.img-src-overlay') }))()`)
  out.shaAfter = await sha()
  out.mdRoundtripSame = out.shaBefore === out.shaAfter
  out.keep.modal = await ev(`document.querySelectorAll('.lm-prompt__card').length`)
  fs.writeFileSync(`tmp/v111-${TAG}.json`, JSON.stringify(out, null, 1))
  const txt = require('./v111-sum')(out)
  fs.writeFileSync(`tmp/v111-${TAG}.txt`, txt)
  console.log(txt)
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
