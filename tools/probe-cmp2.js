// 深入探测边界点
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
      const h1 = document.querySelector('.md-preview h1')
      const w = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
      let last = null
      let n
      while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) last = n }
      const range = document.createRange()
      range.setStart(last, last.textContent.length)
      range.collapse(true)
      const hRange = document.createRange()
      hRange.selectNodeContents(h1)
      hRange.collapse(false)
      const caretContainer = range.startContainer.nodeType === 3 ? 'TEXT:' + JSON.stringify(range.startContainer.textContent) : range.startContainer.nodeName
      const hEndContainer = hRange.startContainer.nodeType === 3 ? 'TEXT:' + JSON.stringify(hRange.startContainer.textContent) : hRange.startContainer.nodeName
      return JSON.stringify({
        caret: { c: caretContainer, o: range.startOffset },
        hEnd: { c: hEndContainer, o: hRange.startOffset },
        cmp: range.compareBoundaryPoints(Range.START_TO_START, hRange),
        h1Children: Array.from(h1.childNodes).map(x => x.nodeType === 3 ? 'T' + JSON.stringify(x.textContent) : x.nodeName + ':' + x.textContent)
      })
    })()`,
    returnByValue: true
  })
  console.log(r.result?.result?.value ?? 'ERR')
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
