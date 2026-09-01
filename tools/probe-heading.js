// 诊断标题行末判断条件
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
      const textNode = Array.from(h1.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').trim())
      h1.closest('.md-block-inner').focus()
      const range = document.createRange()
      range.setStart(textNode, textNode.textContent.length)
      range.collapse(true)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(range)
      const hRange = document.createRange()
      hRange.selectNodeContents(h1)
      hRange.collapse(false)
      const cmp = range.compareBoundaryPoints(Range.START_TO_START, hRange)
      const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
      const headingFound = el?.closest('h1,h2,h3,h4,h5,h6')?.tagName ?? null
      return JSON.stringify({ cmp, collapsed: range.collapsed, headingFound, h1HTML: h1.outerHTML.slice(0, 150) })
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
