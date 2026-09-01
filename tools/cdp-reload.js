// 重新加载 Lumin 页面并捕获控制台与异常
const collectMs = Number(process.argv[2] || 8000)

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
      events.push(m)
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
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })

  await new Promise((r) => setTimeout(r, collectMs))

  for (const m of events) {
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
      console.log(`[console.${m.params.type}]`, args.slice(0, 300))
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      console.log('[EXCEPTION]', d.text, d.exception?.description?.slice(0, 400) || '')
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry
      console.log(`[log.${e.level}]`, e.text.slice(0, 300), e.url ? `(${e.url}:${e.lineNumber})` : '')
    }
  }
  const check = await send('Runtime.evaluate', {
    expression:
      "JSON.stringify({app: document.getElementById('app')?.childElementCount, api: typeof window.luminAPI, h1: document.querySelector('h1')?.textContent ?? null})",
    returnByValue: true
  })
  console.log('[FINAL_STATE]', check.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
