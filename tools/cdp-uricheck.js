// 捕获 404 的完整 URL 与 import 实际请求路径
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
  const reqs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Network.requestWillBeSent') {
      reqs.push({ url: m.params.request.url, type: m.params.type })
    } else if (m.method === 'Network.responseReceived') {
      const last = reqs[reqs.length - 1]
      if (last && last.url === m.params.response.url) last.status = m.params.response.status
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
    expression: "(async () => { const f = await fetch('/node_modules/.vite/deps/pinia.js'); const fstat = f.status; try { await import('/node_modules/.vite/deps/pinia.js'); return 'import-ok fetch=' + fstat } catch(e) { return 'import-fail fetch=' + fstat + ' :: ' + e.message.slice(0,120) } })()",
    awaitPromise: true
  })
  await new Promise((r) => setTimeout(r, 1500))
  for (const r of reqs.filter((x) => x.url.includes('deps'))) {
    console.log(r.status ?? '?', r.type, r.url)
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
