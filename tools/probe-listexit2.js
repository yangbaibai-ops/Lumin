// 定位空列表项退出逻辑
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
      const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (!t.includes('vite')) logs.push('[log] ' + t.slice(0, 200))
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
  await send('Runtime.enable', {})

  await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'list-test.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1600))
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return 'ok'
  })()`)

  console.log(await evalJs(`(async () => {
    const mod = await import('/src/lib/mdSerializer.ts')
    const lis = Array.from(document.querySelectorAll('.md-preview li'))
    const empty = lis.find(li => (li.textContent || '').trim() === '')
    const block = empty.closest('.md-block-inner')
    block.focus()
    const r = document.createRange()
    r.selectNodeContents(empty)
    r.collapse(false)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    const prefix = mod.caretMdOffset(block)
    const md = mod.serializeBlock(block)
    const lineStart = md.lastIndexOf('\\n', prefix - 1) + 1
    const lineEndIdx = md.indexOf('\\n', prefix)
    const lineEnd = lineEndIdx === -1 ? md.length : lineEndIdx
    const line = md.slice(lineStart, lineEnd)
    // 合成 beforeinput 触发应用逻辑
    const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })
    block.dispatchEvent(ev)
    await new Promise(r => setTimeout(r, 600))
    return JSON.stringify({
      liText: JSON.stringify(empty.textContent),
      prefix,
      md,
      line,
      regexMatch: /^\\s*([-*+]\\s+|\\d+[.)]\\s+)$/.test(line),
      lisAfter: Array.from(document.querySelectorAll('.md-preview li')).map(li => JSON.stringify(li.textContent))
    })
  })()`))
  console.log('[logs]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
