// 诊断 settings IPC 状态
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
      try {
        const all = await window.luminAPI.settings.getAll()
        return JSON.stringify({ ok: true, theme: all.theme, recents: all.recentFiles?.length ?? 0 })
      } catch (e) {
        return JSON.stringify({ ok: false, err: e.message })
      }
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log(r.result?.result?.value ?? JSON.stringify(r.result?.exceptionDetails?.exception?.description ?? 'EVAL_FAIL'))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
