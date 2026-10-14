'use strict'
// 线路 15 段落的**完整几何**：段落行盒 / 正文文字 rect / 图片 widget rect / 标识符片段 rect
// 用法：node tmp/probe-geo.js <port> [selYes]
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const WITH_SEL = process.argv[3] === 'sel'
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
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(200)

  // 点第一张图
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(500)

  if (WITH_SEL) {
    await json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const from = Number(el.getAttribute('data-img-from'))
      const to = from + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
      return 'ok'
    })()`)
    await sleep(600)
  }

  const geo = await json(`(() => {
    const R = (x) => [Math.round(x.left * 100) / 100, Math.round(x.top * 100) / 100, Math.round(x.width * 100) / 100, Math.round(x.height * 100) / 100]
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const p = el.closest('p, pre, div')
    const out = {
      p: { tag: p.tagName, cls: p.className, rect: R(p.getBoundingClientRect()), lineRects: [...p.getClientRects()].map(R) },
      ident: { cls: el.className, rects: [...el.getClientRects()].map(R) },
      widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => ({ cls: w.className, rect: R(w.getBoundingClientRect()), img: R(w.querySelector('img').getBoundingClientRect()), va: getComputedStyle(w.querySelector('img')).verticalAlign, disp: getComputedStyle(w).display })),
      texts: [],
      sel: null
    }
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const t = (n.textContent || '')
      if (!t.trim()) continue
      const rg = document.createRange(); rg.selectNodeContents(n)
      out.texts.push({ txt: t.slice(0, 14), len: t.length, rects: [...rg.getClientRects()].map(R), parent: n.parentElement.className || n.parentElement.tagName })
    }
    const sel = document.getSelection()
    if (sel.rangeCount && sel.toString()) {
      out.sel = { str: sel.toString().slice(0, 20), rects: [...sel.getRangeAt(0).getClientRects()].map(R) }
    }
    return out
  })()`)
  console.log(JSON.stringify(geo, null, 1))
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 300, y: 330, width: 1000, height: 320, scale: 1 }, captureBeyondViewport: false })
  fs.writeFileSync(WITH_SEL ? 'tmp/px-geo-sel.png' : 'tmp/px-geo-nosel.png', Buffer.from(r.result.data, 'base64'))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1) })
