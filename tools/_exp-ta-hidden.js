const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

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
  const r = await ev(`(async () => {
    const ta = document.createElement('textarea')
    ta.value = Array(200).fill('abcdefghij').join('\\n')
    document.body.appendChild(ta)
    ta.style.cssText = 'position:fixed;left:-9999px;width:200px;height:120px'
    ta.focus()
    ta.setSelectionRange(777, 777)
    ta.scrollTop = 500
    const before = { sel: ta.selectionStart, st: ta.scrollTop }
    ta.style.display = 'none'
    await new Promise((r2) => setTimeout(r2, 100))
    const hidden = { sel: ta.selectionStart, st: ta.scrollTop }
    ta.style.display = ''
    await new Promise((r2) => setTimeout(r2, 100))
    const after = { sel: ta.selectionStart, st: ta.scrollTop }
    ta.remove()
    return JSON.stringify({ before, hidden, after })
  })()`)
  console.log('textarea none-往返:', r)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
