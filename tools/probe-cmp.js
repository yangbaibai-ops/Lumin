// 探测：光标在标题最后一个文本节点末尾时的 cmp 值
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
      const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1400))
      const h1 = document.querySelector('.md-preview h1')
      const w = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
      let last = null
      let n
      while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) last = n }
      h1.closest('.md-block-inner').focus()
      const range = document.createRange()
      range.setStart(last, last.textContent.length)
      range.collapse(true)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(range)
      const hRange = document.createRange()
      hRange.selectNodeContents(h1)
      hRange.collapse(false)
      return JSON.stringify({
        cmp: range.compareBoundaryPoints(Range.START_TO_START, hRange),
        textNodes: Array.from(h1.childNodes).map(c => c.nodeType === 3 ? JSON.stringify(c.textContent) : c.nodeName).join('|')
      })
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log(r.result?.result?.value ?? 'ERR')
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
