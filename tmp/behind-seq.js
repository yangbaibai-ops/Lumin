'use strict'
/**
 * 第一百一十一轮 ① 的严格口径复核（Node 侧轮询，避开 rAF 节流）：
 *  在图片实体后面按下 → 向左拖到**图片左边的正文**里 → 松手
 *  期望：sel 严格跨过两张图（from < img.from && to > img.to），并给整段逐帧状态序列（查 A→B→A）
 * 用法：node tmp/behind-seq.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-behind-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  const click = async (x, y, s = 400) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
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
  const geo = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const v = window.__vt.ed().view
    const ranges = []
    v.state.doc.descendants((node, pos) => { if (!node.isText) return true
      const t = node.text || ''
      for (const m of t.matchAll(/<img\\b[^>]*\\/?>/gi)) { const at = m.index || 0; ranges.push({ from: pos + at, to: pos + at + m[0].length }) }
      return true })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    return { ranges, widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => R(w.getBoundingClientRect())), text: R(rg.getBoundingClientRect()) } })()`)
  const snap = () => json(`(() => { const s = window.__vt.ed().state.selection; const el = document.querySelector('.ProseMirror [data-img-revealed]'); const pm = document.querySelector('.ProseMirror')
    return { from: s.from, to: s.to, empty: s.empty, revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, open: pm.getAttribute('data-img-open'), cls: el ? String(el.className).replace('img-src-revealed--editing','RE').replace('img-src-revealed','R') : null, ov: document.querySelectorAll('.img-src-overlay > div').length } })()`)
  const w0 = geo.widgets[0]
  const w1 = geo.widgets[1]
  const textY = Math.round((geo.text.t + geo.text.b) / 2)
  const out = { tag: TAG, geo: { ranges: geo.ranges, widgets: geo.widgets, text: geo.text }, gestures: [] }
  const gesture = async (name, from, to, steps = 18) => {
    await click(away.x, away.y, 320)
    const pre = await snap()
    const frames = []
    await mouse('mousePressed', from.x, from.y)
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 })
      frames.push(await snap()); await sleep(10)
    }
    await mouse('mouseReleased', to.x, to.y)
    for (let i = 0; i < 30; i++) { frames.push(await snap()); await sleep(12) }
    const ded = []
    for (const f of frames) {
      const k = `${f.revealed ? 'R' + (f.cls && f.cls.includes('RE') ? 'E' : '') : '-'}|ov${f.ov}|open${f.open}|sel${f.from}-${f.to}${f.empty ? 'E' : ''}`
      if (!ded.length || ded[ded.length - 1].k !== k) ded.push({ k })
    }
    const after = await snap()
    const doc = await ev(`(() => { const s = window.__vt.ed().state.selection; return window.__vt.ed().view.state.doc.textBetween(s.from, s.to, '\\n').slice(0, 120) })()`)
    const g = { name, from, to, pre, after, frag: doc, seq: ded.map((d) => d.k), frames: frames.length }
    out.gestures.push(g)
    console.log(`== ${name} (${from.x},${from.y}) → (${to.x},${to.y})`)
    console.log(`   pre=${pre.from}-${pre.to}${pre.empty ? 'E' : ''} 松手后=${after.from}-${after.to}${after.empty ? 'E' : ''} 片段=${JSON.stringify(doc)}`)
    console.log('   序列 ' + JSON.stringify(g.seq))
    return g
  }
  await gesture('① 图后(右) → 向左拖到正文', { x: Math.round(w1.r + 40), y: Math.round((w1.t + w1.b) / 2) }, { x: Math.round(geo.text.l + 6), y: textY })
  // 截图：跨过图片之后的可见反馈（图片实体带 img-selected 选中观感 + 两侧文字被选）
  {
    const clip = await json(`(() => { const R = (x) => ({ l: x.left, t: x.top, r: x.right, b: x.bottom })
      const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
      const r = R(p.getBoundingClientRect())
      return { x: Math.max(0, Math.floor(r.l) - 30), y: Math.max(0, Math.floor(r.t) - 30), width: Math.min(1200, Math.ceil(r.r - r.l) + 60), height: Math.ceil(r.b - r.t) + 60 } })()`)
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync('tmp/img-behind-drag.png', Buffer.from(r.result.data, 'base64'))
    console.log('   截图 clip=' + JSON.stringify(clip) + ' imgSelected=' + (await ev(`document.querySelectorAll('.ProseMirror img.img-selected, .ProseMirror [data-img-widget].img-selected, .ProseMirror .img-selected').length`)))
  }
  await gesture('② 正文 → 向右拖过两张图', { x: Math.round(w0.l - 60), y: textY }, { x: Math.round(w1.r + 30), y: Math.round((w1.t + w1.b) / 2) })
  await gesture('⑤ 对照：图后 → 向左拖（停在图盒内）', { x: Math.round(w1.r + 40), y: Math.round((w1.t + w1.b) / 2) }, { x: Math.round(w0.l + 6), y: Math.round((w0.t + w0.b) / 2) })
  fs.writeFileSync(`tmp/behind-seq-${TAG}.json`, JSON.stringify(out, null, 1))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
