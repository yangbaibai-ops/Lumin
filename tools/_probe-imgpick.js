'use strict'
// 最小复核（第四十八轮切片 A）：文档内容是否仍是字面 `![]()`（排除 widget 按钮自己的 DOM 文本）
const PORT = process.env.LUMIN_DEBUG_PORT || '9333'
const EXPR = `JSON.stringify((() => {
  const ed = document.querySelector('.ProseMirror')
  let docText = ''
  const walk = (n) => { for (const c of n.childNodes) {
    if (c.nodeType === 3) docText += c.nodeValue
    else if (c.nodeType === 1 && !(c.matches && c.matches('[data-md-image-picker]'))) walk(c)
  } }
  if (ed) walk(ed)
  return { pickers: document.querySelectorAll('.md-image-picker').length, docText: docText.slice(0, 40), reqs: window.__mdImagePickRequests ?? null }
})())`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const ev = (expression) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, (m) => res(m.result?.result?.value))
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
  const out = await ev(EXPR)
  const r = JSON.parse(out)
  console.log(
    'docText=' + JSON.stringify(r.docText) + ' 纯文本未变=' + (r.docText === '![]()' ? 'OK' : 'FAIL')
  )
  console.log('pickers=' + r.pickers + ' reqs=' + r.reqs)
  process.exit(0)
}

main().catch((e) => {
  console.log('probe=1 ' + e.message)
  process.exit(1)
})
