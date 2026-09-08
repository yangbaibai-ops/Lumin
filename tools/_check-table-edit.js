// 最小复测 table-cell-edit（定位含 '1' 的单元格 → 光标落到其后 → 键入 '9' → 期望出现 '19'），
// 确认是否为键盘输入抖动而非真实回归。
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

  // 打开验收文件（含表格），定位 '1' 单元格
  await ev(`(async () => { await window.__vt.files().openPath('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\tipverify.md'); return 'ok' })()`)
  await sleep(1200)

  for (let attempt = 1; attempt <= 4; attempt++) {
    const pos = await ev(`(() => {
      const ed = window.__vt.ed()
      let p = -1
      ed.state.doc.descendants((n, pp) => { if (p < 0 && n.isText && n.text === '1') p = pp + 1 })
      if (p >= 0) ed.chain().focus().setTextSelection(p + 1).run()
      return p
    })()`)
    if (pos < 0) { console.log('FAIL locate cell'); process.exit(2) }
    await send('Input.insertText', { text: '9' })
    await sleep(300)
    const r = await ev(`(() => { const td = [...document.querySelectorAll('.ProseMirror td')].find((t) => t.textContent === '19'); return { found: !!td } })()`)
    console.log(`attempt ${attempt}: pos=${pos} found19=${r.found}`)
    if (r.found) { console.log('PASS table-cell-edit'); ws.close(); process.exit(0) }
  }
  console.log('FAIL table-cell-edit (4 attempts)')
  ws.close()
  process.exit(1)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
