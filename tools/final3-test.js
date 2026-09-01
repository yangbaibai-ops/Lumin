// 聚焦验证：Backspace 合并 / CJK 全文搜索 / 修复后的 Tab
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

  // 打开文件
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return 'ok'
  })()`)

  // 1. Backspace 合并（rawKeyDown 配方）
  console.log('[1] backspace:', await evalJs(`(async () => {
    window.__evts = []
    document.addEventListener('beforeinput', e => window.__evts.push(e.inputType), true)
    const inners = Array.from(document.querySelectorAll('.md-block-inner'))
    const before = inners.length - 1
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
    window.__before = before
    return 'ready'
  })()`))
  await key('rawKeyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await new Promise((r) => setTimeout(r, 800))
  console.log('[1b] result:', await evalJs(`JSON.stringify({
    evts: window.__evts,
    before: window.__before,
    after: document.querySelectorAll('.md-block-inner').length - 1
  })`))

  // 2. CJK 插入 + 保存 + trigram 搜索
  console.log('[2] cjk search:', await evalJs(`(async () => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    const inner = p.closest('.md-block-inner')
    inner.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 2)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    document.execCommand('insertText', false, '所见即所得')
    await new Promise(r => setTimeout(r, 700))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const r1 = await window.luminAPI.db.search('所见即所得')
    return JSON.stringify({ hit: r1.length > 0, snip: (r1[0]?.bodySnippet || '').slice(0, 40) })
  })()`))

  // 3. 修复后的 Tab（真实按键）
  console.log('[3] tab:', await evalJs(`(async () => {
    const td = document.querySelector('.md-preview tbody td')
    td.closest('.md-block-inner').focus()
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {}
    const tn = td.firstChild?.textContent ? td.firstChild : null
    const w2 = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
    const first = w2.nextNode()
    const r = document.createRange()
    r.setStart(first, first.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`))
  await key('rawKeyDown', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await key('keyUp', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await new Promise((r) => setTimeout(r, 300))
  await key('keyDown', { key: 'z', code: 'KeyZ', text: 'z', unmodifiedText: 'z', windowsVirtualKeyCode: 90 })
  await key('keyUp', { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
  await new Promise((r) => setTimeout(r, 700))
  console.log('[3b] cells:', await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.md-preview tbody td')).map(t => t.textContent))`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
