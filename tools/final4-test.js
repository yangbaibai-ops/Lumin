// 验证：块首退格合并 + 标记符删除 + FTS 片段
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
  const key = (type, params) => send('Input.dispatchKeyEvent', { type, ...params })
  const pressBackspace = async () => {
    await key('rawKeyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  const pressDelete = async () => {
    await key('rawKeyDown', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
    await key('keyUp', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  }

  // 打开文件
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return 'ok'
  })()`)

  // 1. 块首退格 → 与上一块合并
  await evalJs(`(() => {
    const inners = Array.from(document.querySelectorAll('.md-block-inner'))
    window.__before = inners.length - 1
    const second = inners[1]
    second.focus()
    const w = document.createTreeWalker(second, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 0)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[1] backspace merge:', await evalJs(`JSON.stringify({
    before: window.__before,
    after: document.querySelectorAll('.md-block-inner').length - 1,
    mergedText: document.querySelector('.md-block-inner')?.textContent?.slice(0, 30) ?? null
  })`))

  // 2. 标记符删除：光标置于加粗文字起点（meta 后）→ 退格取消样式
  await evalJs(`(() => {
    const strong = document.querySelector('.md-preview strong')
    strong.closest('.md-block-inner').focus()
    const w = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 0)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[2] marker delete:', await evalJs(`JSON.stringify({
    strongCount: document.querySelectorAll('.md-preview strong').length,
    text: document.querySelector('.md-preview p')?.textContent?.slice(0, 40) ?? null
  })`))

  // 3. FTS 片段（latin）
  console.log('[3] fts snippet:', await evalJs(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const r = await window.luminAPI.db.search('INLINE')
    return JSON.stringify({ hit: r.length > 0, snip: (r[0]?.bodySnippet || '').slice(0, 50) })
  })()`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
