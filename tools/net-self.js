// 网络域自检
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
  const events = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) {
      events.push(m.method + ' ' + (m.params?.request?.url || m.params?.url || '').slice(0, 100))
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Network.enable', {})
  await send('Runtime.enable', {})
  await send('Runtime.evaluate', { expression: "fetch('/src/App.vue').then(r => r.status)", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 1000))
  console.log(events.slice(0, 10).join('\n'))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
