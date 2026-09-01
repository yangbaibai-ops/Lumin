// 验证段落行末回车后的光标位置与空段落块
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

  await evalJs(`(async () => {
    const ORIGINAL = ${JSON.stringify('# T\n\npara one\n\npara two')}
    await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\caret-demo.md', ORIGINAL)
    return 'written'
  })()`)
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2500))
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1000))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'caret-demo.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1400))
    return 'ok'
  })()`)

  await evalJs(`(() => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent === 'para one')
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
    return 'ready'
  })()`)
  await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 800))
  console.log(await evalJs(`(() => {
    const inner = document.activeElement?.closest('.md-block-inner')
    const blocks = Array.from(document.querySelectorAll('.md-block-inner')).map(b => JSON.stringify(b.textContent))
    return JSON.stringify({
      caretBlockIdx: inner?.closest('[data-block]')?.dataset.block ?? null,
      caretInEmpty: (inner?.textContent || '').length === 0,
      blocks
    })
  })()`))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
