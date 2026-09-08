// 设置标题并点击，测量 H1 徽章与标题文字的垂直居中情况，并截图供目检。
const CDP = 'http://127.0.0.1:9222/json'
const fs = require('fs')
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  if (boot !== 'OK') { console.log('FAIL bridge', boot); process.exit(2) }

  await ev(`(() => { location.hash = '#/editor'; window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(1000)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(800)
  await ev(`(() => { window.__vt.ed().commands.setContent('# 标题\\n\\n正文内容'); return 'ok' })()`)
  await sleep(500)

  // 点击标题正文（光标进入标题 → 显示徽章）
  const rect = await ev(`(() => { const h = document.querySelector('.ProseMirror h1'); if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.left + b.width * 0.3, y: b.top + b.height / 2, left: b.left, top: b.top, width: b.width, height: b.height } })()`)
  if (!rect) { console.log('FAIL no h1'); process.exit(2) }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(300)

  const measure = await ev(`(() => {
    const h = document.querySelector('.ProseMirror h1')
    if (!h) return null
    const cs = getComputedStyle(h, '::before')
    const hb = h.getBoundingClientRect()
    // 伪元素垂直中心 = h1.top + top（translateY(-50%) 使中心恰落在 top 位置）
    const badgeCenter = hb.top + parseFloat(cs.top)
    const textRect = (() => { const r = document.createRange(); r.selectNodeContents(h); const b = r.getBoundingClientRect(); return { top: b.top, height: b.height, center: b.top + b.height / 2 } })()
    return { reveal: h.classList.contains('md-reveal'), csTop: cs.top, csTransform: cs.transform, h1Top: hb.top, h1Height: hb.height, badgeCenter: Math.round(badgeCenter), textCenter: Math.round(textRect.center), offset: Math.round(badgeCenter - textRect.center) }
  })()`)
  console.log('measure', JSON.stringify(measure))

  // 截图（含左侧 gutter 徽章区域）
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, rect.left - 80), y: Math.max(0, rect.top - 30), width: 400, height: 120, scale: 2 } })
  fs.writeFileSync('tools/_badge.png', Buffer.from(shot.result.data, 'base64'))
  console.log('saved tools/_badge.png')
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
