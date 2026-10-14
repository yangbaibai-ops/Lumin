'use strict'
// 原型 3：inline 档用 padding-block = (1lh - 1.24em)/2 + clone 把底色铺满整行行盒
// 相位：真实文件（行内）→ 块级夹具
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'pad'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAOUlEQVR4nO3OMREAMAgEMPwrY8ZBndQFz5C7CEj1vFMqPhASEhJKD4SEhITSAyEhIaH0QEhIqHdDH4Op4tOjeOJYAAAAAElFTkSuQmCC'
const BLOCK_MD = `<img src="${PNG_B}" style="zoom:100%;" />\n`

const CAND = `
.md-preview .img-src-revealed:not(.img-src-revealed--block) {
  padding-block: calc((1lh - 1.24em) / 2);
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
  const selectSource = async () => {
    await ev(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const to = Number(el.getAttribute('data-img-from')) + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, to)))
      return 'ok'
    })()`)
    await sleep(200)
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
  const geom = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), b: +x.bottom.toFixed(2), h: +x.height.toFixed(2), w: +x.width.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const cs = getComputedStyle(el)
    const p = el.closest('p, li, pre, div')
    const lines = (() => {
      const q = document.createRange(); q.selectNodeContents(p)
      const rs = [...q.getClientRects()].filter((x) => x.width > 0)
      const out = []
      for (const r of rs) {
        const hit = out.find((o) => r.top < o.b - 0.5 && r.bottom > o.t + 0.5)
        if (hit) { hit.t = Math.min(hit.t, r.top); hit.b = Math.max(hit.b, r.bottom); hit.l = Math.min(hit.l, r.left); hit.r = Math.max(hit.r, r.right) }
        else out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom })
      }
      return out.map((o) => ({ l: +o.l.toFixed(2), t: +o.t.toFixed(2), r: +o.r.toFixed(2), b: +o.b.toFixed(2), w: +(o.r - o.l).toFixed(2), h: +(o.b - o.t).toFixed(2) }))
    })()
    const sel = document.getSelection()
    return {
      ok: true, cls: el.className, display: cs.display, lh: cs.lineHeight, fs: cs.fontSize,
      bg: cs.backgroundColor, pad: cs.paddingTop + '/' + cs.paddingBottom, bdb: cs.boxDecorationBreak,
      elRects: [...el.getClientRects()].map(R), lines, pRect: R(p.getBoundingClientRect()),
      selStrLen: sel.rangeCount ? sel.toString().length : 0,
      selRects: sel.rangeCount && sel.toString() ? [...sel.getRangeAt(0).getClientRects()].map(R) : null
    }
  })()`)

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
  const mdOpen = await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`)
  const out = { tag: TAG, mdLen: mdOpen.length }
  const click = async () => {
    const r0 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
    if (r0) return 'already'
    const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(600)
    return 'clicked'
  }
  await click()
  out.mdRoundtripSame = mdOpen === (await ev(`(() => window.__vt.ed().storage.markdown.getMarkdown())()`))
  // 注入候选
  await ev(`(() => { const s = document.createElement('style'); s.id = 'xw-pad'; s.textContent = ${JSON.stringify(CAND)}; document.head.appendChild(s); return 'ok' })()`)
  await sleep(400)
  out.real = await geom()
  await shot(`tmp/px-${TAG}-real-nosel.png`, { x: 300, y: 330, width: 1000, height: 320 })
  await selectSource()
  out.realSel = await geom()
  await shot(`tmp/px-${TAG}-real-sel.png`, { x: 300, y: 330, width: 1000, height: 320 })

  // 块级夹具（在同一注入样式下量，验证不受影响）
  await ev(`document.getSelection().removeAllRanges()`)
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(BLOCK_MD)}); return 'ok' })()`)
  await sleep(900)
  await click()
  out.block = await geom()
  await shot(`tmp/px-${TAG}-block-nosel.png`, { x: 300, y: 60, width: 1000, height: 240 })
  await selectSource()
  out.blockSel = await geom()
  await shot(`tmp/px-${TAG}-block-sel.png`, { x: 300, y: 60, width: 1000, height: 240 })

  await ev(`document.getElementById('xw-pad')?.remove()`)
  fs.writeFileSync(`tmp/probe-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
