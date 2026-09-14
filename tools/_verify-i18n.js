// 验证 i18n：切换语言后顶部菜单文字随之变化。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

const getMenus = `(() => [...document.querySelectorAll('.topmenu-root > button')].map(b => b.textContent.trim()).join('|'))()`

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
    const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)

  await ev(`(() => { window.__vt.settings().setLanguage('en-US'); return 'ok' })()`)
  await sleep(600)
  console.log('menu EN:', await ev(getMenus))

  await ev(`(() => { window.__vt.settings().setLanguage('zh-CN'); return 'ok' })()`)
  await sleep(600)
  console.log('menu ZH:', await ev(getMenus))

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
