// 验证：1) toast 位置为右下角且不遮挡底部栏；2) tooltip 悬停边缘元素时完整显示在视口内。
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

  // 桥接
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)

  // 1) 触发 toast，检查其容器位置
  await ev(`(() => { window.__vt.ui().toast('已保存测试', 'success', 3000); return 'ok' })()`)
  await sleep(300)
  const toastPos = await ev(`(() => {
    const c = [...document.querySelectorAll('.fixed')].find((d) => d.classList.contains('bottom-12') && d.classList.contains('right-4'))
    if (!c) return null
    const r = c.getBoundingClientRect()
    return JSON.stringify({ bottom: Math.round(window.innerHeight - r.bottom), right: Math.round(window.innerWidth - r.right) })
  })()`)
  console.log('toast container (bottom/right offset):', toastPos)

  // 2) tooltip：找一个靠左边的带 title 元素（侧边栏按钮），悬停后检查 tooltip 完整在视口内
  const el = await ev(`(() => {
    const b = [...document.querySelectorAll('[title]')].find((x) => x.title && x.getBoundingClientRect().left < 120)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.title }
  })()`)
  if (el) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: el.x, y: el.y })
    await sleep(900)
    const tip = await ev(`(() => {
      const t = document.querySelector('.lm-tooltip')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), vw: window.innerWidth, vh: window.innerHeight, fullyVisible: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight })
    })()`)
    console.log('tooltip near left edge:', tip)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  } else {
    console.log('no left-edge title element')
  }

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
