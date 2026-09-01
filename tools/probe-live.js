// 探测实时视图当前状态
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
    expression: `(() => {
      const out = {}
      out.hash = location.hash
      out.mode = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('源码')) ? 'ui' : '?'
      out.previewHTML = (document.querySelector('.md-preview')?.innerHTML || '').slice(0, 400)
      out.blocks = Array.from(document.querySelectorAll('.md-block-inner')).map(b => JSON.stringify(b.textContent))
      out.cmVisible = !!document.querySelector('.cm-editor')
      out.cmText = document.querySelector('.cm-content')?.textContent?.slice(0, 80) ?? null
      return JSON.stringify(out)
    })()`,
    returnByValue: true
  })
  console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
