// 复现空列表退出流程并检查落盘内容
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
  await send('Runtime.enable', {})

  const DOC = '# A\n\n段落甲\n\n- 列表一\n- 列表二\n- \n\n尾段\n'
  await evalJs(`(async () => {
    await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\list-test.md', ${JSON.stringify(DOC)})
    return 'ok'
  })()`)
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2800))
  await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'list-test.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1700))
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return 'ok'
  })()`)

  // 空列表项回车
  await evalJs(`(() => {
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
    return 'ready'
  })()`)
  await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 800))
  console.log('[dom]', await evalJs(`JSON.stringify({
    lis: Array.from(document.querySelectorAll('.md-preview li')).map(li => JSON.stringify(li.textContent))
  })`))
  // 等待自动保存落盘
  await new Promise((r) => setTimeout(r, 3500))
  console.log('[disk]', await evalJs(`(async () => {
    const meta = await window.luminAPI.db.getDocument('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\list-test.md')
    return JSON.stringify(meta?.content ?? 'NOT_IN_DB')
  })()`))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
