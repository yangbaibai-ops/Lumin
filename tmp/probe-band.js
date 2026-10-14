'use strict'
// 最小探针：真实文件 → 点图 → PM 选中源码 → 截图（覆盖到整段）→ 量几何
// 用法：node tmp/probe-band.js <port> [nosel]
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const NOSEL = process.argv[3] === 'nosel'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 25000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))

  log('boot...')
  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui') }
    return 'OK'
  })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  log('open...')
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1300)
  await send('Page.bringToFront').catch(() => null)
  log('click img...')
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  log('imgPt=' + JSON.stringify(pt))
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(600)
  log('revealed=' + (await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)))
  if (!NOSEL) {
    log('pm select...')
    await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const from = Number(el.getAttribute('data-img-from'))
      const to = from + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
      return { from, to }
    })()`)
    await sleep(700)
  }
  log('measure...')
  const g = await json(`(() => {
    const R = (x) => [Math.round(x.left * 100) / 100, Math.round(x.top * 100) / 100, Math.round(x.width * 100) / 100, Math.round(x.height * 100) / 100]
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const p = el.closest('p, pre, div')
    const sel = document.getSelection()
    return {
      pRect: R(p.getBoundingClientRect()), pCls: p.className,
      ident: { cls: el.className, rects: [...el.getClientRects()].map(R) },
      widgets: [...p.querySelectorAll('[data-img-widget] img')].map((im) => R(im.getBoundingClientRect())),
      lineRects: (() => { const q = document.createRange(); q.selectNodeContents(p); return [...q.getClientRects()].map(R) })(),
      selRect: sel.rangeCount ? R(sel.getRangeAt(0).getBoundingClientRect()) : null,
      selRects: sel.rangeCount ? [...sel.getRangeAt(0).getClientRects()].map(R) : null,
      selStr: sel.rangeCount ? sel.toString().slice(0, 20) : ''
    }
  })()`)
  log(JSON.stringify(g, null, 1))
  log('shot...')
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 300, y: 330, width: 1000, height: 320, scale: 1 }, captureBeyondViewport: false })
  const file = NOSEL ? 'tmp/px-band-nosel.png' : 'tmp/px-band-sel.png'
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  log('saved ' + file)
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
