// 交互排查：代码块点击进入编辑态 + Enter 拆分
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
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 250)
    return r.result?.result?.value
  }

  console.log('[A] code click:', await evalJs(`(async () => {
    const out = {}
    const pre = document.querySelector('pre.code-wrap')
    out.preFound = !!pre
    out.preContentEditable = pre?.getAttribute('contenteditable')
    pre?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 400))
    out.textarea = !!document.querySelector('textarea.md-code-raw')
    out.codeEditVisible = !!document.querySelector('.md-code-raw')
    return JSON.stringify(out)
  })()`))

  console.log('[B] split:', await evalJs(`(async () => {
    const real = () => document.querySelectorAll('.md-block-inner').length - 1
    const out = { before: real() }
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    out.pFound = !!p
    const inner = p?.closest('.md-block-inner')
    inner?.focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 3)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    out.caretActive = document.activeElement === inner
    out.exec = document.execCommand('insertParagraph')
    await new Promise(r => setTimeout(r, 600))
    out.after = real()
    out.pCount = document.querySelectorAll('.md-block-inner p').length
    return JSON.stringify(out)
  })()`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
