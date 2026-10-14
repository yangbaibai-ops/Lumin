'use strict'
// 在失败配置下截图（第 2 段源码显形 / innerWidth 1408）
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const W = Number(process.argv[3] || 1424)
const TAG = process.argv[4] || 'fail'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-rowfix-fixture.md'
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
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(450)
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
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(1400)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(${W}, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  await click(away.x, away.y)
  for (const i of [0, 1]) {
    const pt = await json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${i}]; if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
    if (!pt) continue
    await click(pt.x, pt.y)
    const geo = await json(`(() => {
      const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2), w: +x.width.toFixed(2) })
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const ps = [...document.querySelectorAll('.ProseMirror p')].map((p) => ({ txt: (p.textContent||'').slice(0,14), rect: R(p.getBoundingClientRect()) }))
      return { revealedFrom: el ? Number(el.getAttribute('data-img-from')) : null, elRects: el ? [...el.getClientRects()].map(R) : [], overlays: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())), ps }
    })()`)
    const clip = { x: 300, y: 300, width: 1100, height: 300 }
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(`tmp/row-${TAG}-widget${i}.png`, Buffer.from(r.result.data, 'base64'))
    console.log(`widget#${i} revealedFrom=${geo.revealedFrom} elRects=${JSON.stringify(geo.elRects)} overlays=${JSON.stringify(geo.overlays)}`)
    console.log('   ps=' + JSON.stringify(geo.ps.slice(0, 4)))
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
