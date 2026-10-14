'use strict'
// 全屏截图 + 关键状态（排查 captureScreenshot 是否拿到真画面）
const fs = require('fs')
const { decodePNG } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'full'
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
    if (r.result && r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(r.result.data, 'base64')
  fs.writeFileSync(`tmp/ov-${TAG}.png`, buf)
  const img = decodePNG(buf)
  const counts = new Map()
  for (let y = 0; y < img.h; y += 3) for (let x = 0; x < img.w; x += 3) { const p = img.px(x, y); const k = p.join(','); counts.set(k, (counts.get(k) || 0) + 1) }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const state = {
    size: `${img.w}x${img.h}`,
    distinctColors: counts.size,
    top: top.map(([k, v]) => k + ' x' + v),
    hasFocus: await ev(`document.hasFocus()`),
    activeEl: await ev(`document.activeElement ? document.activeElement.className || document.activeElement.tagName : null`),
    revealed: await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`),
    imgs: await ev(`document.querySelectorAll('.ProseMirror img').length`),
    scrollY: await ev(`document.querySelector('.editor-scroll') ? document.querySelector('.editor-scroll').scrollTop : null`),
    scrollInfo: await ev(`(() => { const s = document.querySelector('.editor-scroll'); return s ? { top: s.scrollTop, h: s.clientHeight, sh: s.scrollHeight } : null })()`),
    imgRect: await ev(`(() => { const im = document.querySelector('.ProseMirror img'); if (!im) return null; const r = im.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })()`),
    disp: await ev(`JSON.stringify({vis: document.visibilityState, hidden: document.hidden, w: innerWidth, h: innerHeight})`)
  }
  console.log(JSON.stringify(state, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1) })
