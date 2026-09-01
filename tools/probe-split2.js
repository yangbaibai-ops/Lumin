// 复现测试序列中的 insertParagraph 行为并捕获调试日志
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
  const logs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable', {})
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      // 打开 features.md
      location.hash = '#/editor'
      await new Promise(r => setTimeout(r, 1200))
      const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1500))
      const real = () => document.querySelectorAll('.md-block-inner').length - 1
      const out = { before: real() }
      const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
      const inner = p.closest('.md-block-inner')
      inner.focus()
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) { if (!n.parentElement.classList.contains('md-meta')) break }
      const r = document.createRange()
      r.setStart(n, 3)
      r.collapse(true)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
      out.exec = document.execCommand('insertParagraph')
      await new Promise(r => setTimeout(r, 800))
      out.after = real()
      out.paragraphHtml = p?.outerHTML?.slice(0, 200) ?? 'gone'
      return JSON.stringify(out)
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log('[result]', r.result?.result?.value)
  console.log('[debug logs]', logs.slice(-8))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
