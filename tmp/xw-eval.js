'use strict'
// 通用 CDP 求值（带超时）：node tmp/xw-eval.js <port> <expression>
const PORT = process.argv[2] || '9334'
const EXPR = process.argv[3]
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) { console.log('NO_PAGE'); process.exit(1) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pend.delete(i); rej(new Error('timeout ' + method)) }, 8000)
    pend.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  try {
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) console.log('EXC', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    else console.log(JSON.stringify(r.result?.result?.value))
  } catch (e) { console.log('ERR', e.message) }
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); process.exit(1) })
