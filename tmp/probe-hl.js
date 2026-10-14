'use strict'
/**
 * 机制对比探针：同一段源码范围，三种"覆盖区域"
 *   A) 现状：标识符自身的 background-color（字形高）
 *   B) 原生选区：document.getSelection() 高亮（像素带）
 *   C) CSS Custom Highlight API：::highlight() 高亮（像素带）
 * 用法：node tmp/probe-hl.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9334'
const TAG = process.argv[3] || 'hl'
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
  const revealed0 = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
  if (!revealed0) {
    const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  log('revealed=' + (await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)))

  const CLIP = { x: 300, y: 330, width: 1000, height: 320 }
  const geom = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const p = el.closest('p, li, pre, div')
    const q = document.createRange(); q.selectNodeContents(p)
    const sel = document.getSelection()
    const cs = getComputedStyle(el)
    return {
      cls: el.className, bg: cs.backgroundColor, lh: cs.lineHeight, fs: cs.fontSize, pad: cs.padding,
      bgRects: [...el.getClientRects()].map(R),
      pRect: R(p.getBoundingClientRect()),
      lines: [...q.getClientRects()].map(R),
      selStrLen: sel.rangeCount ? sel.toString().length : 0,
      selRects: sel.rangeCount && sel.toString() ? [...sel.getRangeAt(0).getClientRects()].map(R) : null,
      highlights: (() => { try { return [...CSS.highlights.keys()] } catch (e) { return [] } })(),
      hlRects: (() => {
        try {
          const h = CSS.highlights.get('xw-test')
          if (!h) return null
          const out = []
          for (const r of h) out.push(...[...r.getClientRects()].map(R))
          return out
        } catch (e) { return 'ERR:' + e.message }
      })()
    }
  })()`)

  const out = { tag: TAG }
  // A) 现状
  out.A_bg = await geom()
  await shot(`tmp/px-${TAG}-A-bg.png`, CLIP)

  // B) 原生选区（DOM Selection API，直接写，不经 PM）
  await ev(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const sel = document.getSelection()
    sel.removeAllRanges()
    const r = document.createRange(); r.selectNodeContents(el)
    sel.addRange(r)
    return 'ok'
  })()`)
  await sleep(500)
  await send('Page.bringToFront').catch(() => null)
  await ev(`document.querySelector('.ProseMirror').focus()`)
  await sleep(300)
  out.B_sel = await geom()
  await shot(`tmp/px-${TAG}-B-sel.png`, CLIP)

  // C) Custom Highlight API
  await ev(`(() => { document.getSelection().removeAllRanges(); return 'ok' })()`)
  await sleep(200)
  const hl = await ev(`(() => {
    const s = document.createElement('style')
    s.id = 'xw-hl-style'
    s.textContent = '::highlight(xw-test) { background-color: var(--edge); }'
    document.head.appendChild(s)
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const r = document.createRange(); r.selectNodeContents(el)
    CSS.highlights.set('xw-test', new Highlight(r))
    return CSS.highlights.has('xw-test')
  })()`)
  log('highlight registered=' + hl)
  await sleep(500)
  out.C_hl = await geom()
  await shot(`tmp/px-${TAG}-C-hl.png`, CLIP)

  // 清理
  await ev(`(() => { CSS.highlights.delete('xw-test'); document.getElementById('xw-hl-style')?.remove(); document.getSelection().removeAllRanges(); return 'ok' })()`)
  fs.writeFileSync(`tmp/probe-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL: ' + e.message); process.exit(1) })
