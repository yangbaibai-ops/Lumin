'use strict'
// 诊断：公式右侧 (608,424) 一点上，各种映射各给出什么
const PORT = process.argv[2] || '9351'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-tail-fixture.md'
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
  const ev = async (expr, ap = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await sleep(200); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900); await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  const r = await json(`(() => {
    const v = window.__vt.ed().view
    const probe = (x, y) => {
      const el = document.elementFromPoint(x, y)
      let cr = null
      try { const rr = document.caretRangeFromPoint(x, y); if (rr && v.dom.contains(rr.startContainer)) cr = v.posAtDOM(rr.startContainer, rr.startOffset) } catch (e) {}
      const at = v.posAtCoords({ left: x, top: y })
      return { x, y, el: el ? el.tagName + '.' + String(el.className).slice(0, 30) : null,
        caretRange: cr, posAtCoords: at ? at.pos : null }
    }
    const math = [...document.querySelectorAll('.ProseMirror [data-md-math-rendered],[data-md-math-block]')].map((m) => { const r = m.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), tag: m.tagName, cls: String(m.className).slice(0, 24) } })
    const imgs = [...document.querySelectorAll('.ProseMirror [data-img-widget]')].map((w) => { const r = w.getBoundingClientRect(); return { from: w.getAttribute('data-img-from'), l: +r.left.toFixed(1), r: +r.right.toFixed(1) } })
    return { math, imgs, probes: [probe(560, 424), probe(584, 424), probe(600, 424), probe(608, 424), probe(612, 424), probe(622, 424), probe(700, 424)] }
  })()`)
  console.log('math', JSON.stringify(r.math))
  console.log('imgs', JSON.stringify(r.imgs))
  for (const p of r.probes) console.log(`  (${p.x},${p.y}) el=${p.el} caretRange=${p.caretRange} posAtCoords=${p.posAtCoords}`)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
