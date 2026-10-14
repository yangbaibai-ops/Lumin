'use strict'
// 诊断：空白带按列落光标 —— 打印 caretRangeFromPoint / posAtDOM / posAtCoords（同一状态）
const fs = require('fs')
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
  const click = async (x, y, settle = 420) => {
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
  const diag = await json(`(() => {
    const v = window.__vt.ed().view
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2) })
    const frags = [...el.getClientRects()].map(R)
    const out = { frags, from: Number(el.getAttribute('data-img-from')), len: (el.textContent||'').length, probes: [] }
    for (let row = 0; row < frags.length; row++) {
      const f = frags[row]
      for (const kind of ['mid', 'left', 'right']) {
        const x = kind === 'mid' ? Math.round((f.l + f.r) / 2) : kind === 'left' ? Math.round(f.l + 1) : Math.round(f.r - 1)
        const midY = (f.t + f.b) / 2
        const rec = { row, kind, x, midY }
        try {
          const cr = document.caretRangeFromPoint(x, midY)
          rec.caret = cr ? { node: cr.startContainer.nodeName, txt: (cr.startContainer.textContent || '').slice(0, 12), off: cr.startOffset, parentCls: cr.startContainer.parentElement ? String(cr.startContainer.parentElement.className).slice(0, 40) : null, rect: R(cr.getBoundingClientRect()) } : null
          rec.inDom = cr ? v.dom.contains(cr.startContainer) : null
          if (cr) { try { rec.posAtDOM = v.posAtDOM(cr.startContainer, cr.startOffset) } catch (e) { rec.posAtDOM = 'THROW ' + e.message } }
        } catch (e) { rec.caretErr = String(e.message) }
        try { const at = v.posAtCoords({ left: x, top: midY }); rec.posAtCoords = at ? at.pos : null } catch (e) { rec.posAtCoords = 'THROW' }
        // 该点上的元素（命中测试）
        const hit = document.elementFromPoint(x, midY)
        rec.hit = hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : null
        out.probes.push(rec)
      }
    }
    return out
  })()`)
  fs.writeFileSync('tmp/band-diag.json', JSON.stringify(diag, null, 1))
  console.log(JSON.stringify(diag, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
