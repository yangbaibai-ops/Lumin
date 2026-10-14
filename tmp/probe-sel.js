'use strict'
// 原生选区矩形探针：查清 `Selection` / `Range.getClientRects()` 在本实例里的真实行为
// 用法：node tmp/probe-sel.js <port>
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

  // 找一个普通段落文本节点做"纯文本选区"对照（第 1 行）
  const plain = await json(`(() => {
    const p = document.querySelector('.ProseMirror p')
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n = null
    while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 4) break
    if (!n) return { ok: false }
    const rg = document.createRange()
    rg.setStart(n, 0); rg.setEnd(n, 3)
    const sel = document.getSelection()
    sel.removeAllRanges(); sel.addRange(rg)
    const sr = sel.getRangeAt(0)
    const out = {
      ok: true, pCls: p.className, text: n.textContent.slice(0, 20),
      selRangeCount: sel.rangeCount, selStr: sel.toString(),
      srCollapsed: sr.collapsed, srText: sr.toString(),
      srRects: [...sr.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]),
      domRects: [...rg.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]),
      anchor: sel.anchorNode ? sel.anchorNode.nodeName : null,
      cs: (() => { const c = getComputedStyle(p); return { lh: c.lineHeight, fs: c.fontSize, ff: c.fontFamily.slice(0, 40) } })()
    }
    return out
  })()`)
  console.log('PLAIN', JSON.stringify(plain))

  await sleep(300)
  // 再量一次（隔一个事件循环，看 PM 是否把它改回自己的选区）
  const plain2 = await json(`(() => {
    const sel = document.getSelection()
    const sr = sel.rangeCount ? sel.getRangeAt(0) : null
    return { rangeCount: sel.rangeCount, str: sel.toString(), rects: sr ? [...sr.getClientRects()].map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]) : null,
      pmSel: (() => { const s = window.__vt.ed().state.selection; return { from: s.from, to: s.to } })() }
  })()`)
  console.log('PLAIN-2', JSON.stringify(plain2))

  // 点第一张图 → 标识符显形
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(500)

  // 标识符上的原生选区（多个变体）
  const variants = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { ok: false }
    const R = (x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]
    const out = { cls: el.className, childNodes: el.childNodes.length, textLen: (el.textContent || '').length }
    // 变体 1：selectNodeContents(el)
    {
      const sel = document.getSelection(); sel.removeAllRanges()
      const rg = document.createRange(); rg.selectNodeContents(el)
      out.v1_preToString = rg.toString().slice(0, 30)
      sel.addRange(rg)
      const sr = sel.getRangeAt(0)
      out.v1 = { collapsed: sr.collapsed, str: sr.toString().slice(0, 30), rects: [...sr.getClientRects()].map(R), selStr: sel.toString().slice(0, 30) }
      sel.removeAllRanges()
    }
    // 变体 2：只选首 10 个字符
    {
      const tn = (() => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode() })()
      const sel = document.getSelection(); sel.removeAllRanges()
      const rg = document.createRange()
      rg.setStart(tn, 0); rg.setEnd(tn, Math.min(10, tn.length))
      sel.addRange(rg)
      const sr = sel.getRangeAt(0)
      out.v2 = { collapsed: sr.collapsed, str: sr.toString(), rects: [...sr.getClientRects()].map(R) }
      sel.removeAllRanges()
    }
    // 变体 3：PM 的 TextSelection（走 setSelection）
    {
      const v = window.__vt.ed().view
      const from = Number(el.getAttribute('data-img-from'))
      const to = from + (el.textContent || '').length
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, from, to)))
      out.v3_pos = [from, to]
    }
    return out
  })()`)
  console.log('VARIANTS', JSON.stringify(variants))

  await sleep(600)
  const after = await json(`(() => {
    const sel = document.getSelection()
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const s = window.__vt.ed().state.selection
    const R = (x) => [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)]
    return {
      pm: { from: s.from, to: s.to, empty: s.empty },
      selRangeCount: sel.rangeCount, selStr: sel.toString().slice(0, 40),
      selRects: sel.rangeCount ? [...sel.getRangeAt(0).getClientRects()].map(R) : null,
      selType: sel.rangeCount ? sel.getRangeAt(0).startContainer.nodeName : null,
      elShown: !!el, elRects: el ? [...el.getClientRects()].map(R) : null,
      activeEl: document.activeElement ? document.activeElement.className : null
    }
  })()`)
  console.log('AFTER-PM-SEL', JSON.stringify(after))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1) })
