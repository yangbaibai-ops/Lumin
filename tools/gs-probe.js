// 排查全局搜索弹窗监听
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
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const out = {}
      out.before = document.body.innerText.includes('FTS5')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 500))
      out.after = document.body.innerText.includes('FTS5')
      out.inputs = Array.from(document.querySelectorAll('input')).map(i => i.placeholder.slice(0, 24))
      out.teleports = document.body.children.length
      return JSON.stringify(out)
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log(r.result?.result?.value ?? JSON.stringify(r.result?.exceptionDetails ?? 'ERR'))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
