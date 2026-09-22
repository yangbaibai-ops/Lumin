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
  await ev(`(() => { const app = document.querySelector('#app')?.__vue_app__; const prov = app?._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map }); const pinia = (sym ? prov[sym] : null); window.__vt = { pinia, ui: () => pinia._s.get('ui') }; return 'ok' })()`)

  const closedBefore = await ev(`!document.querySelector('.topmenu-drop')`)

  // 按 Alt+F（CDP modifiers: Alt=1）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 1 })
  await sleep(300)

  const dropOpen = await ev(`(() => { const d = document.querySelector('.topmenu-drop'); return d ? d.textContent.trim().slice(0, 60) : null })()`)
  console.log('closed before Alt+F:', closedBefore)
  console.log('topmenu-drop after Alt+F:', dropOpen)

  // ── 断言（此前只打印观察值、退出口径藏在 process.exit 里 ⇒ 运行器读成 0/0）──
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('menu-closed-initially', closedBefore === true, String(closedBefore))
  c('alt-f-opens-in-app-menu', typeof dropOpen === 'string' && dropOpen.length > 8, String(dropOpen).slice(0, 60))
  c('dropdown-has-file-items', /新建|打开/.test(String(dropOpen)), '原生菜单栏若还拦着 Alt，这里拿不到菜单项')
  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)

  // 关闭（按 Esc 或点击空白）
  await ev(`(() => { const app = document.querySelector('#app').__vue_app__; const prov = app._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map }); const pinia = (sym ? prov[sym] : null); pinia._s.get('ui').toasts = []; return 'ok' })()`)

  ws.close()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
