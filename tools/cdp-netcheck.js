// 诊断动态 import 失败原因：捕获网络层错误
async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const failures = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Network.loadingFailed') {
      failures.push(m.params)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Network.enable', {})
  await send('Runtime.evaluate', {
    expression: "import('/node_modules/.vite/deps/pinia.js').then(() => 'ok').catch(e => 'fail')",
    awaitPromise: true
  })
  await new Promise((r) => setTimeout(r, 1200))
  console.log(JSON.stringify(failures, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
