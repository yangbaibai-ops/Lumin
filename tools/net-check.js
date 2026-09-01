// 捕获进入编辑器时的网络请求（找出挂起的 chunk）
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
  const reqs = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Network.requestWillBeSent') {
      reqs.set(m.params.requestId, { url: m.params.request.url.slice(0, 120), status: 'pending' })
    } else if (m.method === 'Network.responseReceived') {
      const r = reqs.get(m.params.requestId)
      if (r) r.status = String(m.params.response.status)
    } else if (m.method === 'Network.loadingFailed') {
      const r = reqs.get(m.params.requestId)
      if (r) r.status = 'FAILED: ' + m.params.errorText
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Network.enable', {})
  await send('Page.enable', {})
  await send('Runtime.evaluate', { expression: "location.hash = '/'" })
  await new Promise((r) => setTimeout(r, 1500))
  await send('Runtime.evaluate', { expression: "location.hash = '#/editor'" })
  await new Promise((r) => setTimeout(r, 6000))
  const rows = Array.from(reqs.values())
  console.log(rows.map((r) => `${r.status.padEnd(12)} ${r.url}`).slice(0, 60).join('\n'))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
