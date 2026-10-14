'use strict'
// 诊断 2：点空白带后读 data-img-band / data-img-band-pos + 选区
const PORT = process.argv[2] || '9351'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-band-fixture.md'
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
  const click = async (x, y, settle = 450) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(settle)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
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
  await sleep(800)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][1]; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await click(pt.x, pt.y)
  const read = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const pm = document.querySelector('.ProseMirror')
    const s = window.__vt.ed().state.selection
    return { revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, sel: { from: s.from, to: s.to }, band: pm.getAttribute('data-img-band'), bandPos: pm.getAttribute('data-img-band-pos'), done: pm.getAttribute('data-img-band-done'), after: pm.getAttribute('data-img-band-after'), editing: el ? el.classList.contains('img-src-revealed--editing') : null, ov: document.querySelectorAll('.img-src-overlay > div').length }
  })()`)
  const bands = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) }); return { frags: [...el.getClientRects()].map(R), ov: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())) } })()`)
  console.log('frags', JSON.stringify(bands.frags), 'ov', JSON.stringify(bands.ov))
  console.log('before', JSON.stringify(await read()))
  const f0 = bands.frags[0]
  const o0 = bands.ov[0]
  const f1 = bands.frags[1]
  const o1 = bands.ov[1]
  const pts = [
    { k: 'row0-band', x: Math.round((f0.l + f0.r) / 2), y: Math.round((f0.b + o0.b) / 2) },
    { k: 'row0-glyph', x: Math.round((f0.l + f0.r) / 2), y: Math.round((f0.t + f0.b) / 2) },
    { k: 'row0-band2', x: Math.round((f0.l + f0.r) / 2), y: Math.round((f0.b + o0.b) / 2) },
    { k: 'row1-band', x: Math.round((f1.l + f1.r) / 2), y: Math.round((f1.b + o1.b) / 2) },
    { k: 'row1-band2', x: Math.round((f1.l + f1.r) / 2), y: Math.round((f1.b + o1.b) / 2) }
  ]
  for (const p of pts) {
    await click(p.x, p.y)
    console.log(p.k, `(${p.x},${p.y})`, JSON.stringify(await read()))
    if ((await read()).revealed === 0) await click(pt.x, pt.y)
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
