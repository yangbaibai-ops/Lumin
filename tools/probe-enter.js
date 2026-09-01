// 用真实可信输入（Input.dispatchKeyEvent）测试 Enter 拆分
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

  // 在段落中放置光标
  await send('Runtime.evaluate', {
    expression: `(() => {
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
      window.__beforeBlocks = document.querySelectorAll('.md-block-inner').length - 1
      return 'caret set, blocks=' + window.__beforeBlocks
    })()`
  })

  // 真实 Enter 按键
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 900))

  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      before: window.__beforeBlocks,
      after: document.querySelectorAll('.md-block-inner').length - 1,
      firstP: document.querySelector('.md-block-inner p')?.textContent?.slice(0, 12) ?? null
    })`,
    returnByValue: true
  })
  console.log('[result]', r.result?.result?.value)
  console.log('[debug logs]', logs.slice(-6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
