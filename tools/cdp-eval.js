// CDP 求值工具：node tools/cdp-eval.js "<js expression>"
// 用于在运行中的 Lumin 窗口内执行 JS 并返回结果
const url = 'http://127.0.0.1:9222/json'
const expr = process.argv[2]

async function main() {
  const targets = await (await fetch(url)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) {
    console.log('NO_PAGE_TARGET')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
  } else {
    console.log(JSON.stringify(r.result?.result?.value))
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
