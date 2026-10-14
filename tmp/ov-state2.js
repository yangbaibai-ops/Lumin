'use strict'
// 状态诊断：文档内容/图片/显形元素/草稿弹窗
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-overlay-fixture.md'
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
    if (r.result && r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(2000)
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /丢弃|放弃|Discard/i.test(x.textContent || ''))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(700)
    }
  }
  await dismiss()
  await sleep(500)
  const snap = async (label) => {
    const s = await json(`(() => {
      const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2), w: +x.width.toFixed(2) })
      return {
        label: ${JSON.stringify(label)},
        modal: !!document.querySelector('[role=dialog]'),
        docText: window.__vt.ed().state.doc.textBetween(0, Math.min(220, window.__vt.ed().state.doc.content.size), '\\n'),
        mdLen: window.__vt.ed().storage.markdown.getMarkdown().length,
        revealed: [...document.querySelectorAll('.ProseMirror [data-img-revealed]')].map((el) => ({ cls: el.className, from: el.getAttribute('data-img-from'), rects: [...el.getClientRects()].map(R) })),
        widgets: [...document.querySelectorAll('.ProseMirror [data-img-widget]')].map((w) => ({ from: w.getAttribute('data-img-from'), cls: w.className, rect: R(w.getBoundingClientRect()) })),
        imgs: [...document.querySelectorAll('.ProseMirror img')].map((im) => ({ nw: im.naturalWidth, rect: R(im.getBoundingClientRect()) })),
        overlays: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
        paras: [...document.querySelectorAll('.ProseMirror p')].map((p) => ({ t: (p.textContent || '').slice(0, 26), rect: R(p.getBoundingClientRect()) })).slice(0, 6),
        sel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to, empty: s.empty } })(),
        scrollH: document.querySelector('.editor-scroll').scrollHeight
      }
    })()`)
    return s
  }
  const out = { afterOpen: await snap('afterOpen') }
  await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-widget] img'); if (!el) return 'none'; const r = el.getBoundingClientRect(); window.__pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; return 'ok' })()`)
  const pt = await json(`window.__pt`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 })
  await sleep(500)
  out.afterClick = await snap('afterClick')
  for (const t of [1500, 3000, 5000]) {
    await sleep(t === 1500 ? 1000 : 1000)
    out['t' + t] = await snap('t' + t)
  }
  console.log(JSON.stringify(out, null, 1))
  fs.writeFileSync('tmp/ov-state2.json', JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
