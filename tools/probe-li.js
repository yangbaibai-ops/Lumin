// 检查 li 元素分布（liCount 5 之谜）
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
      const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'audit.md')
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1600))
      const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
      liveBtn?.click()
      await new Promise(r => setTimeout(r, 1000))
      const lis = Array.from(document.querySelectorAll('.md-preview li')).map(li => JSON.stringify(li.textContent))
      const lists = Array.from(document.querySelectorAll('.md-preview ul, .md-preview ol')).map(l => l.tagName + ':' + l.childElementCount)
      return JSON.stringify({ lis, lists })
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
