// 探测：代码块末尾直接打字（无回车）的插入位置
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
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 160)
    return r.result?.result?.value
  }
  const key = (type, params) => send('Input.dispatchKeyEvent', { type, ...params })
  await send('Runtime.enable', {})

  await evalJs(`(() => {
    const pre = document.querySelector('pre.code-wrap')
    const block = pre.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(pre.querySelector('code'), NodeFilter.SHOW_TEXT)
    let last = null
    let n
    while ((n = w.nextNode())) last = n
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await key('keyDown', { key: 'A', code: 'KeyA', text: 'A', unmodifiedText: 'A', windowsVirtualKeyCode: 65 })
  await key('keyUp', { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await new Promise((r) => setTimeout(r, 500))
  console.log(await evalJs(`JSON.stringify({
    preHTML: document.querySelector('pre.code-wrap')?.outerHTML.slice(-120)
  })`))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
