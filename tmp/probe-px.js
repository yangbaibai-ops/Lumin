'use strict'
// 像素级取证：原生选区**实际画出来**的高度 vs Range.getClientRects() vs 标识符底色高度
// 用法：node tmp/probe-px.js <port>
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`))

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
  await sleep(1200)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { const pm = document.querySelector('.ProseMirror'); pm.focus(); return 'ok' })()`)
  await sleep(200)

  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
      captureBeyondViewport: false
    })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }

  const out = {}
  // ── A) 普通正文段落的前 3 个字符做原生选区（对照"选区画多高"）
  const A = await json(`(() => {
    const p = document.querySelector('.ProseMirror p')
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n = null
    while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 4) break
    const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, 3)
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(rg)
    const pr = p.getBoundingClientRect()
    const sr = sel.getRangeAt(0)
    const cs = getComputedStyle(p)
    return {
      pRect: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
      lh: cs.lineHeight, fs: cs.fontSize, ff: cs.fontFamily,
      selRects: [...sr.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]),
      textRect: (() => { const q = document.createRange(); q.selectNodeContents(n); const r0 = q.getClientRects()[0]; return [Math.round(r0.left), Math.round(r0.top), Math.round(r0.width), Math.round(r0.height)] })()
    }
  })()`)
  out.A = A
  await sleep(250)
  await shot('tmp/px-a-plain-sel.png', { x: 300, y: A.pRect[1] - 20, width: 400, height: 80 })

  // ── B) 点图 → 标识符显形（不选区）
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(500)
  const B = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const cs = getComputedStyle(el)
    return { ok: true, cls: el.className, lh: cs.lineHeight, fs: cs.fontSize, bg: cs.backgroundColor, pad: cs.padding,
      rects: [...el.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]) }
  })()`)
  out.B = B
  await shot('tmp/px-b-ident-nosel.png', { x: 300, y: 340, width: 1000, height: 100 })

  // ── C) 同一段源码范围做成原生选区（PM setSelection + DOM 选区）
  const C = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const from = Number(el.getAttribute('data-img-from'))
    const to = from + (el.textContent || '').length
    const v = window.__vt.ed().view
    const TS = v.state.selection.constructor
    v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
    return { from, to }
  })()`)
  await sleep(600)
  const C2 = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const sel = document.getSelection()
    const sr = sel.rangeCount ? sel.getRangeAt(0) : null
    return {
      selStr: sel.toString().slice(0, 30),
      selRects: sr ? [...sr.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]) : null,
      elShown: !!el,
      elRects: el ? [...el.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]) : null,
      elCls: el ? el.className : null,
      bg: el ? getComputedStyle(el).backgroundColor : null,
      selBg: sel && sel.rangeCount ? (() => { const e = sel.getRangeAt(0).startContainer.parentElement; return getComputedStyle(e).color })() : null
    }
  })()`)
  out.C = { pos: C, after: C2 }
  await shot('tmp/px-c-ident-sel.png', { x: 300, y: 340, width: 1000, height: 100 })

  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1) })
