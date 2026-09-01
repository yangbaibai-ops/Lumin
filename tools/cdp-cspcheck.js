// 捕获 import() 期间的控制台 CSP 报错
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
  const logs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') {
      logs.push(m)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable', {})
  await send('Log.enable', {})
  await send('Runtime.evaluate', {
    expression: "import('/node_modules/.vite/deps/pinia.js').then(() => 'ok').catch(e => 'fail: ' + e.message)",
    awaitPromise: true
  })
  await new Promise((r) => setTimeout(r, 1500))
  for (const m of logs) {
    const text = m.method === 'Log.entryAdded' ? m.params.entry.text : m.params.args.map((a) => a.value ?? a.description).join(' ')
    console.log('>>', text.slice(0, 260))
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
