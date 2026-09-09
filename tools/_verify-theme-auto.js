// 验证：深色 → 跟随系统(auto) 后，CSS 主题能正确跟随系统（此前只标题栏更新，内容仍深色）。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

const STATE = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  const prov = app?._context.provides
  const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = sym ? prov[sym] : null
  const html = document.documentElement
  return JSON.stringify({
    themeClass: [...html.classList].find((c) => c.startsWith('theme-')),
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches
  })
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)

  // 先切到 auto 读取「真实系统」偏好
  await ev(`(() => { window.__vt.settings().setTheme('auto'); return 'ok' })()`)
  await sleep(400)
  console.log('after auto (system ref):', await ev(STATE))

  await ev(`(() => { window.__vt.settings().setTheme('dark'); return 'ok' })()`)
  await sleep(400)
  console.log('after dark:', await ev(STATE))

  await ev(`(() => { window.__vt.settings().setTheme('auto'); return 'ok' })()`)
  await sleep(500)
  console.log('after auto again (bug scenario):', await ev(STATE))

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
