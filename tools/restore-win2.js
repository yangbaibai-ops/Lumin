// 通过浏览器级 CDP 端点恢复窗口
async function main() {
  const version = await (await fetch('http://127.0.0.1:9222/json/version')).json()
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
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
  const w = await send('Browser.getWindowForTarget', { targetId: page.id })
  const winId = w.result?.windowId
  console.log('windowId:', winId)
  if (winId) {
    await send('Browser.setWindowBounds', { windowId: winId, bounds: { windowState: 'normal' } })
    await new Promise((r) => setTimeout(r, 1500))
    const w2 = await send('Browser.getWindowBounds', { windowId: winId })
    console.log('bounds:', JSON.stringify(w2.result?.bounds))
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
