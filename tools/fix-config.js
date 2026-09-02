// 通过 IPC 触发主进程重写配置（修复被截断的 config.json）+ 恢复主题
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
      const all = await window.luminAPI.settings.getAll()
      const fixed = await window.luminAPI.settings.update({ theme: 'auto' })
      return JSON.stringify({ theme: fixed.theme, recents: fixed.recentFiles?.length ?? 0, sidebarWidth: fixed.sidebarWidth })
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
