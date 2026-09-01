// 诊断：Enter 前状态 + 事件触发
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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 200)
    return r.result?.result?.value
  }
  await send('Runtime.enable', {})

  console.log('[setup]', await evalJs(`(() => {
    window.__bi = []
    document.addEventListener('beforeinput', e => window.__bi.push(e.inputType), true)
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent === 'para one')
    if (!p) return 'NO_P'
    const block = p.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const last = w.nextNode()
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return JSON.stringify({
      focused: document.activeElement === block,
      selContainer: s.anchorNode?.textContent ?? null,
      selOffset: s.anchorOffset,
      vis: document.visibilityState
    })
  })()`))

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
  await new Promise((r) => setTimeout(r, 900))
  console.log('[after]', await evalJs(`JSON.stringify({
    bi: window.__bi,
    blocks: Array.from(document.querySelectorAll('.md-block-inner')).map(b => JSON.stringify(b.textContent)),
    caret: document.activeElement?.closest('[data-block]')?.dataset.block ?? null
  })`))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
