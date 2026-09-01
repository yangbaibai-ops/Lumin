// 探测代码块内 Enter 后的连续输入
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
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 160))
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.args.map((a) => a.value ?? '').join(' ')
      if (!t.includes('vite')) logs.push('[log] ' + t.slice(0, 160))
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 200)
    return r.result?.result?.value
  }
  const key = (type, params) => send('Input.dispatchKeyEvent', { type, ...params })
  await send('Runtime.enable', {})

  // 光标放到代码末尾
  console.log('[setup]', await evalJs(`(() => {
    const pre = document.querySelector('pre.code-wrap')
    const block = pre.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
    let last = null
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('code-lang')) last = n }
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return JSON.stringify({ focused: document.activeElement === block, anchor: s.anchorNode?.textContent?.slice(-6) })
  })()`))

  await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 300))
  console.log('[after enter]', await evalJs(`(() => {
    const s = getSelection()
    return JSON.stringify({ anchor: s.anchorNode?.textContent?.slice(-8) ?? null, offset: s.anchorOffset })
  })()`))

  // 逐字输入 XY
  for (const ch of 'XY') {
    await key('keyDown', { key: ch, code: 'Key' + ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.charCodeAt(0) })
    await key('keyUp', { key: ch, code: 'Key' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) })
    await new Promise((r) => setTimeout(r, 120))
  }
  await new Promise((r) => setTimeout(r, 600))
  console.log('[after type]', await evalJs(`JSON.stringify({
    codeText: document.querySelector('pre.code-wrap code')?.textContent ?? null,
    preText: document.querySelector('pre.code-wrap')?.textContent ?? null
  })`))
  console.log('[logs]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
