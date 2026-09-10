const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function clickModeBtn(text) {
  const p = await ev(`(() => {
    const els = Array.from(document.querySelectorAll('.mode-seg-btn'))
    const el = els.find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) return 'NO-BTN'
  const g = JSON.parse(p)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 })
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
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, ui: () => pinia._s.get('ui') }
    return 'OK'
  })()`)
  await sleep(500)
  console.log('start mode:', await ev(`(() => window.__vt.ui().editorMode)()`))
  await clickModeBtn('实时渲染')
  await sleep(400)
  console.log('after click 实时渲染:', await ev(`(() => window.__vt.ui().editorMode)()`))
  await clickModeBtn('分屏')
  await sleep(400)
  console.log('after click 分屏:', await ev(`(() => window.__vt.ui().editorMode)()`))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
