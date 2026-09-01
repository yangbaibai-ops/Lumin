// 尝试不同 Enter 按键配方
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

  const caret = `(() => {
    window.__evts = []
    document.addEventListener('beforeinput', e => window.__evts.push('bi:' + e.inputType), true)
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    const inner = p.closest('.md-block-inner')
    inner.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 5)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ok'
  })()`

  // 配方 1: keyDown + text \r
  await send('Runtime.evaluate', { expression: caret })
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
    unmodifiedText: '\r',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 400))
  const r1 = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__evts)', returnByValue: true })
  console.log('[keyDown+text]', r1.result?.result?.value)

  // 配方 2: rawKeyDown + char \r
  await send('Runtime.evaluate', { expression: caret })
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r', unmodifiedText: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 400))
  const r2 = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__evts)', returnByValue: true })
  console.log('[rawKeyDown+char]', r2.result?.result?.value)

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
