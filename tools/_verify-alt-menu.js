// 验证：Alt+F 打开应用内 TopMenuBar 下拉（间接证明原生菜单条不再拦截 Alt）。
const CDP = 'http://127.0.0.1:9222/json'
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

  // 先确保菜单关闭
  await ev(`(() => { const app = document.querySelector('#app')?.__vue_app__; const prov = app?._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)'); const pinia = sym ? prov[sym] : null; window.__vt = { pinia, ui: () => pinia._s.get('ui') }; return 'ok' })()`)

  const closedBefore = await ev(`!document.querySelector('.topmenu-drop')`)

  // 按 Alt+F（CDP modifiers: Alt=1）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
  await sleep(300)

  const dropOpen = await ev(`(() => { const d = document.querySelector('.topmenu-drop'); return d ? d.textContent.trim().slice(0, 60) : null })()`)
  console.log('closed before Alt+F:', closedBefore)
  console.log('topmenu-drop after Alt+F:', dropOpen)

  // 关闭（按 Esc 或点击空白）
  await ev(`(() => { const app = document.querySelector('#app').__vue_app__; const prov = app._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)'); const pinia = sym ? prov[sym] : null; pinia._s.get('ui').toasts = []; return 'ok' })()`)

  ws.close()
  process.exit(closedBefore === true && dropOpen !== null ? 0 : 1)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
