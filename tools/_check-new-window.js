// 连接指定 URL 的窗口，检查其当前打开的文件。
const url = 'http://127.0.0.1:9222/json'
const wantUrl = process.argv[2] || '#/editor'
let ws
let id = 0
const pending = new Map()
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }

async function main() {
  const targets = await (await fetch(url)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(wantUrl))
  if (!page) { console.log('NO_TARGET for', wantUrl); process.exit(2) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const app = document.querySelector('#app')?.__vue_app__; const prov = app?._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map }); const pinia = sym ? prov[sym] : null; const files = pinia?._s.get('files'); const ed = pinia?._s.get('editor')?.instance; return JSON.stringify({ current: files?.current ? { name: files.current.name, path: files.current.path } : null, hasEditor: !!ed, h1: document.querySelector('.ProseMirror h1')?.textContent ?? null }) })()`,
    returnByValue: true
  })
  console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
