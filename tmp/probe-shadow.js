'use strict'
// 原型 2：inline 档用 box-shadow 把底色铺到「一整行行盒」（1lh）—— 不动元素盒子与 background-color
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'sh'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

const CAND = `
.md-preview .img-src-revealed:not(.img-src-revealed--block) {
  --xw-half: calc((1lh - 1.24em) / 2);
  box-shadow: 0 var(--xw-half) 0 0 var(--edge), 0 calc(0px - var(--xw-half)) 0 0 var(--edge);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
`

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
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 20000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }

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
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1300)
  await send('Page.bringToFront').catch(() => null)
  const r0 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  if (!r0) {
    const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  log('revealed=' + (await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)))
  const CLIP = { x: 300, y: 330, width: 1000, height: 320 }
  await shot(`tmp/px-${TAG}-before.png`, CLIP)
  const parsed = await ev(`(() => {
    const s = document.createElement('style'); s.id = 'xw-sh'; s.textContent = ${JSON.stringify(CAND)}
    document.head.appendChild(s)
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const cs = getComputedStyle(el)
    return JSON.stringify({ boxShadow: cs.boxShadow, bdb: cs.boxDecorationBreak, rects: [...el.getClientRects()].map(r=>[r.left,r.top,r.width,r.height]), lh: cs.lineHeight, fs: cs.fontSize })
  })()`)
  log('after inject: ' + parsed)
  await sleep(400)
  await shot(`tmp/px-${TAG}-after.png`, CLIP)
  const geom = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2), w: +x.width.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const p = el.closest('p, li, pre, div')
    const q = document.createRange(); q.selectNodeContents(p)
    return { elRects: [...el.getClientRects()].map(R), lines: [...q.getClientRects()].map(R).filter((x) => x.w > 0 || x.h > 0), pRect: R(p.getBoundingClientRect()) }
  })()`)
  log('geom=' + JSON.stringify(geom))
  await ev(`document.getElementById('xw-sh')?.remove()`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
