// 最终回归：段落行末回车 → 光标落到虚尾块；行中回车 → 新块
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
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200))
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
  const pressEnter = async () => {
    await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await send('Runtime.enable', {})

  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1400))
    return 'ok'
  })()`)

  // 段落行末回车 → 光标在虚尾块
  await evalJs(`(() => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    const block = p.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let last = null
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) last = n }
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[1] enter at para end:', await evalJs(`JSON.stringify({
    caretInVirtual: document.activeElement?.closest('.md-block-virtual') != null,
    blocks: document.querySelectorAll('.md-block-inner').length - 1
  })`))

  // 行中回车 → 块数 +1 且光标在新块
  await evalJs(`(() => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    const block = p.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 3)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[2] enter mid-para:', await evalJs(`JSON.stringify({
    blocks: document.querySelectorAll('.md-block-inner').length - 1,
    caretBlockIdx: document.activeElement?.closest('[data-block]')?.dataset.block ?? null
  })`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
