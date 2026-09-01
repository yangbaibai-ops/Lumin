// 验证 beforeinput / input 事件在真实输入下的触发情况
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

  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__evts = []
      document.addEventListener('beforeinput', e => window.__evts.push('bi:' + e.inputType), true)
      document.addEventListener('input', e => window.__evts.push('in:' + (e.target.tagName)), true)
      const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
      const inner = p.closest('.md-block-inner')
      inner.focus()
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) { if (!n.parentElement.classList.contains('md-meta')) break }
      const r = document.createRange()
      r.setStart(n, 4)
      r.collapse(true)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
      return 'ready, active=' + document.activeElement.tagName
    })()`
  })

  // 真实输入字符 'X'
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'x',
    code: 'KeyX',
    text: 'x',
    windowsVirtualKeyCode: 88
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 })
  // 真实 Enter
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 800))

  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({ evts: window.__evts, active: document.activeElement?.tagName })',
    returnByValue: true
  })
  console.log('[result]', r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
