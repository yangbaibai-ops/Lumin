// 回归：分屏分隔条拖拽改变左栏宽度 + 双击复位
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function clickMode(text) {
  const p = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('.mode-seg-btn')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) throw new Error('NO-BTN ' + text)
  const g = JSON.parse(p)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await sleep(500)
}
async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(600)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 150 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  const md = ['# 标题', '正文段落。', '', '```js', 'x', '```'].join('\n')
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(md)}); const ed = window.__vt.ed(); ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(800)
  await clickMode('分屏')
  const divider = JSON.parse(await ev(`(() => { const d = document.querySelector('.split-divider'); if (!d) return JSON.stringify({ none: true }); const r = d.getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, midY: r.top + r.height / 2 }) })()`))
  console.log('divider:', JSON.stringify(divider))
  const w0 = await ev(`(() => { const host = document.querySelector('.typora-container')?.parentElement; return host ? Math.round(host.getBoundingClientRect().width) : -1 })()`)
  // 向左拖
  const dx = Math.round(divider.x - 120)
  const dy = Math.round(divider.midY)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(divider.x), y: dy, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dx, y: dy, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dx, y: dy, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(400)
  const w1 = await ev(`(() => { const host = document.querySelector('.typora-container')?.parentElement; return host ? Math.round(host.getBoundingClientRect().width) : -1 })()`)
  console.log(`左栏宽度 ${w0} → ${w1}（期望变小）`, w1 < w0 ? 'PASS 拖拽生效' : 'FAIL')
  // 双击复位
  const d2 = JSON.parse(await ev(`(() => { const d = document.querySelector('.split-divider'); const r = d.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d2.x, y: d2.y, button: 'left', clickCount: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d2.x, y: d2.y, button: 'left', clickCount: 2 })
  await sleep(300)
  const w2 = await ev(`(() => { const host = document.querySelector('.typora-container')?.parentElement; const k = host.parentElement; return host ? Math.round(host.getBoundingClientRect().width / k.getBoundingClientRect().width * 100) / 100 : -1 })()`)
  console.log(`复位后左栏占比 ${w2}（期望≈0.5）`, Math.abs(w2 - 0.5) < 0.05 ? 'PASS 双击复位' : 'FAIL')
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
