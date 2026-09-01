// 重载并捕获进入编辑器路由时的异常
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
    } else if (m.method) events.push(m)
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable', {})
  await send('Log.enable', {})
  await send('Page.enable', {})
  await send('Page.navigate', { url: 'http://localhost:5173/#/editor' })
  await new Promise((r) => setTimeout(r, 5000))
  for (const m of events) {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      console.log('[console.' + m.params.type + ']', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('[EXC]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300))
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      console.log('[log.' + m.params.entry.level + ']', m.params.entry.text.slice(0, 300))
    }
  }
  const st = await send('Runtime.evaluate', {
    expression: "JSON.stringify({ blocks: document.querySelectorAll('.md-block-inner').length, hash: location.hash, mainFirst: document.querySelector('main')?.firstElementChild?.className })",
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
