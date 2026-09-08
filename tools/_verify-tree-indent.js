// 验证：侧边栏文件树中，同一层级的文件与文件夹图标 x 坐标应一致（都顶格）。
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

  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { await window.__vt.files().setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace'); window.__vt.ui().sidebarTab = 'files'; return 'ok' })()`)
  await sleep(1200)

  const data = await ev(`(() => {
    // 文件树行：直接取 TreeNode 的根节点行（有 chevron 的是文件夹，无 chevron 有 file 图标的是文件）
    const rows = [...document.querySelectorAll('.group')]
    const topLevel = rows.filter((r) => {
      // 根节点：paddingLeft 为 6px（depth 0）
      return r.style.paddingLeft === '6px'
    })
    const out = topLevel.slice(0, 10).map((r) => {
      const svgs = r.querySelectorAll('svg')
      const last = svgs[svgs.length - 1]
      return { name: r.textContent.trim().slice(0, 16), iconX: last ? Math.round(last.getBoundingClientRect().left) : null, pad: r.style.paddingLeft }
    })
    return JSON.stringify(out)
  })()`)
  console.log('topLevel', data)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
