'use strict'
/**
 * CSS 方案原型（不落盘）：在活实例里注入候选样式，量「标识符底色矩形」并把
 * 原生选区高亮的像素带一并取回。用法：node tmp/probe-css.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'p1'
const REAL = 'C:\\Users\\yangbaibai\\Desktop\\Lumin' + '\u76f8\u5173' + '\\\u6570\u5b66\u516c\u5f0f\u793a\u4f8b.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

const CANDIDATE = `
.md-preview .img-src-revealed:not(.img-src-revealed--block) {
  background-image: linear-gradient(var(--edge), var(--edge));
  background-repeat: no-repeat;
  background-size: 100% 1lh;
  background-position: center;
  background-origin: content-box;
  background-clip: border-box, content-box;
  padding-block: calc((1lh - 1em) / 2);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
`

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
  log('open file...')
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(REAL)}); return 'ok' })()`)
  await sleep(1300)
  await send('Page.bringToFront').catch(() => null)
  log('1lh support: ' + (await ev(`CSS.supports('background-size', '100% 1lh')`)) + ' | highlight api: ' + (await ev(`typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'`)))
  log('click img...')
  // 幂等：若已经处于显形态就别再点（再点会 toggle 关掉）
  const revealed0 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  if (!revealed0) {
    const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  const revealed1 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  log('revealed: before=' + revealed0 + ' after=' + revealed1)
  if (!revealed1) throw new Error('identifier not revealed')

  const CLIP = { x: 300, y: 330, width: 1000, height: 320 }
  const readGeom = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const cs = getComputedStyle(el)
    const p = el.closest('p, li, pre, div')
    const lines = (() => { const q = document.createRange(); q.selectNodeContents(p); return [...q.getClientRects()].map(R) })()
    const sel = document.getSelection()
    return {
      cls: el.className, display: cs.display, lh: cs.lineHeight, fs: cs.fontSize,
      bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 60), bgSize: cs.backgroundSize,
      bgPos: cs.backgroundPosition, bgOrigin: cs.backgroundOrigin, bgClip: cs.backgroundClip,
      pad: cs.paddingTop + '/' + cs.paddingBottom, bdb: cs.webkitBoxDecorationBreak || cs.boxDecorationBreak,
      bgRects: [...el.getClientRects()].map(R),
      lines,
      selRects: sel.rangeCount && sel.toString() ? [...sel.getRangeAt(0).getClientRects()].map(R) : null,
      selStrLen: sel.rangeCount ? sel.toString().length : 0
    }
  })()`)

  const out = { tag: TAG, real: REAL }
  const selectSource = async () => {
    // 先把 PM 选区落到**源码末尾的空光标**（`revealDecision` 口径下仍显示），
    // 再设成整段源码范围 —— 否则"同值 setSelection"是空事务，DOM 选区不会重建。
    await ev(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const to = Number(el.getAttribute('data-img-from')) + (el.textContent || '').length
      const v = window.__vt.ed().view
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, to)))
      return 'ok'
    })()`)
    await sleep(250)
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
  const brief = (g) => ({
    cls: g.cls, display: g.display, lh: g.lh, bg: g.bg, bgImage: g.bgImage, bgSize: g.bgSize,
    bgPos: g.bgPos, bgOrigin: g.bgOrigin, bgClip: g.bgClip, pad: g.pad, bdb: g.bdb,
    bgRects: g.bgRects, selRects: g.selRects, selStrLen: g.selStrLen
  })
  out.baseline = await readGeom()
  await shot(`tmp/px-${TAG}-base-nosel.png`, CLIP)

  await selectSource()
  out.baselineSel = await readGeom()
  await shot(`tmp/px-${TAG}-base-sel.png`, CLIP)
  await ev(`document.getSelection().removeAllRanges()`)
  await sleep(400)

  // 注入候选 CSS（只加样式，不动代码）
  log('inject candidate css...')
  await ev(`(() => {
    const s = document.createElement('style')
    s.id = 'xw-probe-css'
    s.textContent = ${JSON.stringify(CANDIDATE)}
    document.head.appendChild(s)
    return 'ok'
  })()`)
  await sleep(400)
  out.candidate = await readGeom()
  await shot(`tmp/px-${TAG}-cand-nosel.png`, CLIP)
  await selectSource()
  out.candidateSel = await readGeom()
  await shot(`tmp/px-${TAG}-cand-sel.png`, CLIP)

  // 清掉注入样式
  await ev(`(() => { document.getElementById('xw-probe-css')?.remove(); return 'ok' })()`)
  fs.writeFileSync(`tmp/probe-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify({
    tag: TAG,
    baseline: brief(out.baseline),
    baselineSel: brief(out.baselineSel),
    candidate: brief(out.candidate),
    candidateSel: brief(out.candidateSel)
  }, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
