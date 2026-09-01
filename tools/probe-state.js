// 探测当前文档状态
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
      out.preview = (document.querySelector('.md-preview')?.innerHTML || '').slice(0, 500)
      out.docName = document.querySelector('main')?.textContent?.includes('features.md') ? 'features.md' : '?'
      const s = await window.luminAPI.db.search('INLINE')
      const s2 = await window.luminAPI.db.search('加粗')
      out.inlineHit = s.length
      out.jiacuHit = s2.length
      out.stats = await window.luminAPI.db.stats()
      const meta = await window.luminAPI.db.getDocument('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md')
      out.dbHasInline = meta?.content.includes('INLINE') ?? false
      out.dbContentLen = meta?.content.length ?? 0
      return JSON.stringify(out)
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
