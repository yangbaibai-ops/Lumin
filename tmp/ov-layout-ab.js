'use strict'
/**
 * ⑤ 布局不受影响的**同构建 A/B**：
 *   A = 现在（覆盖层生效）  B = 运行时把覆盖层与 z-index 那条新规则一起关掉
 * 逐个比较图片/段落的 getBoundingClientRect()；再顺带验证"覆盖层不拦截鼠标"。
 * 用法：node tmp/ov-layout-ab.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'ab'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-overlay-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CLIP = { x: 300, y: 330, width: 1000, height: 340 }

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
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(450)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await dismiss()
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(COPY)}); return 'ok' })()`)
  await sleep(1500)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  for (let i = 0; i < 40; i++) {
    if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break
    await sleep(400)
  }
  // 点开图片（显形 + 覆盖层）
  const pt = await json(`(() => { const im = document.querySelector('.ProseMirror [data-img-widget] img'); const r = im.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const measure = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return {
      para: R(p.getBoundingClientRect()),
      widgets: [...p.querySelectorAll('[data-img-widget] img')].map((im) => R(im.getBoundingClientRect())),
      h2: R([...document.querySelectorAll('.ProseMirror h2')][0].getBoundingClientRect()),
      h1: R([...document.querySelectorAll('.ProseMirror p')][0].getBoundingClientRect()),
      scrollH: document.querySelector('.editor-scroll').scrollHeight,
      docH: document.querySelector('.ProseMirror').getBoundingClientRect().height,
      overlays: document.querySelectorAll('.img-src-overlay > div').length,
      overlayRects: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())),
      hitMid: (() => { const el = document.elementFromPoint(${Math.round(pt.x)}, ${Math.round(pt.y)}); return el ? String(el.className).slice(0, 40) : null })()
    }
  })()`)
  const out = { tag: TAG, pt }
  await click(pt.x, pt.y)
  out.A = await measure()
  // B：运行时关掉覆盖层 + 新加的那条 z-index 规则
  await ev(`(() => {
    const s = document.createElement('style'); s.id = 'xw-off'
    s.textContent = '.img-src-overlay{display:none !important}.editor-content .md-preview{z-index:auto !important}'
    document.head.appendChild(s)
    return 'ok'
  })()`)
  await sleep(500)
  out.B = await measure()
  await ev(`document.getElementById('xw-off').remove()`)
  await sleep(400)
  out.A2 = await measure()
  const keys = ['para', 'widgets', 'h2', 'h1']
  out.diff = {}
  for (const k of keys) out.diff[k] = JSON.stringify(out.A[k]) === JSON.stringify(out.B[k]) ? 'identical' : { A: out.A[k], B: out.B[k] }
  out.diff.scrollH = out.A.scrollH === out.B.scrollH ? 'identical' : { A: out.A.scrollH, B: out.B.scrollH }
  out.diff.docH = out.A.docH === out.B.docH ? 'identical' : { A: out.A.docH, B: out.B.docH }
  out.overlayStillThere = out.A.overlays > 0 && out.A2.overlays > 0 && out.B.overlays > 0
  fs.writeFileSync(`tmp/ov-layout-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
