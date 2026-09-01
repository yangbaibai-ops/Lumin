// 通过 Browser 域恢复窗口状态
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
  const w = await send('Browser.getWindowForTarget', {})
  const winId = w.result?.windowId
  console.log('windowId:', winId)
  await send('Browser.setWindowBounds', { windowId: winId, bounds: { windowState: 'normal' } })
  await new Promise((r) => setTimeout(r, 1500))
  const st = await send('Runtime.evaluate', {
    expression: "JSON.stringify({ vis: document.visibilityState, blocks: document.querySelectorAll('.md-block-inner').length })",
    returnByValue: true
  })
  console.log('[state]', st.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
