// Typora 一致性验证 v2（步骤间重置文件，避免相互污染）
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
  const pressBackspace = async () => {
    await key('rawKeyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  await send('Runtime.enable', {})

  const ORIGINAL = String.raw`# 特性测试 Features

这是一段包含 **加粗文本** 和 *斜体* 与 ~~删除线~~ 的文字。

| 名称 | 状态 |
| --- | --- |
| 表格 | 可编辑 |
| 链接 | [点我](https://example.com) |

行内公式 $E = mc^2$

` + '```js\nconst x = 1\n```' + `

` + '```mermaid\nflowchart LR\n  A[测试] --> B[通过]\n```'

  const resetFile = `await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md', ${JSON.stringify(ORIGINAL)})`

  const openFile = `(async () => {
    ${resetFile}
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1400))
    return 'ok'
  })()`

  // 0. 启动并打开
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    ${resetFile}
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1400))
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 900))
    return 'ok'
  })()`)

  // 1. 极简块样式
  console.log('[1] minimal block:', await evalJs(`(() => {
    const block = document.querySelector('.md-block')
    block.querySelector('.md-block-inner').focus()
    const cs = getComputedStyle(block)
    return JSON.stringify({ bg: cs.backgroundColor, boxShadow: cs.boxShadow, borderLeft: cs.borderLeftWidth })
  })()`))

  // 2. 标题标记符显隐
  console.log('[2] heading marker:', await evalJs(`(async () => {
    const h1 = document.querySelector('.md-preview h1')
    const marker = h1.querySelector('.md-heading-marker')
    // 先把光标移入正文段落，测量隐藏态
    const p = document.querySelector('.md-preview p')
    p.closest('.md-block-inner').focus()
    const w2 = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n2
    while ((n2 = w2.nextNode())) { if (!n2.parentElement?.classList.contains('md-meta')) break }
    const r2 = document.createRange()
    r2.setStart(n2, 0)
    r2.collapse(true)
    const s2 = getSelection()
    s2.removeAllRanges()
    s2.addRange(r2)
    await new Promise(r => setTimeout(r, 250))
    const before = getComputedStyle(marker).display
    // 再移入标题
    h1.closest('.md-block-inner').focus()
    const w = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 2)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    await new Promise(r => setTimeout(r, 250))
    const during = getComputedStyle(marker).display
    return JSON.stringify({ before, during })
  })()`))

  // 3. 标题行末回车 → 去标题 + 新段落（先重置文件）
  await evalJs(openFile)
  await evalJs(`(() => {
    const h1 = document.querySelector('.md-preview h1')
    // 取最后一个非标记符文本节点（标题可能被拆成多个文本节点）
    const w = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
    let textNode = null
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) textNode = n }
    h1.closest('.md-block-inner').focus()
    const r = document.createRange()
    r.setStart(textNode, textNode.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 900))
  console.log('[3] enter de-head:', await evalJs(`JSON.stringify({
    h1Count: document.querySelectorAll('.md-preview h1').length,
    firstTag: document.querySelector('.md-block-inner')?.firstElementChild?.tagName ?? null,
    blocks: document.querySelectorAll('.md-block-inner').length - 1
  })`))

  // 4. 标题行中回车 → 拆分（前半标题，后半段落）
  await evalJs(openFile)
  await evalJs(`(() => {
    const h1 = document.querySelector('.md-preview h1')
    const textNode = Array.from(h1.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').trim())
    h1.closest('.md-block-inner').focus()
    const r = document.createRange()
    r.setStart(textNode, 2)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 900))
  console.log('[4] split heading:', await evalJs(`JSON.stringify({
    firstTag: document.querySelector('.md-block-inner')?.firstElementChild?.tagName ?? null,
    secondTag: document.querySelectorAll('.md-block-inner')[1]?.firstElementChild?.tagName ?? null
  })`))

  // 5. 标题标记符处退格 → 去标题
  await evalJs(openFile)
  await evalJs(`(() => {
    const h1 = document.querySelector('.md-preview h1')
    const textNode = Array.from(h1.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').trim())
    h1.closest('.md-block-inner').focus()
    const r = document.createRange()
    r.setStart(textNode, 0)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[5] backspace de-head:', await evalJs(`JSON.stringify({
    h1Count: document.querySelectorAll('.md-preview h1').length,
    firstTag: document.querySelector('.md-block-inner')?.firstElementChild?.tagName ?? null
  })`))

  // 6. 表格单元格 | 标记
  await evalJs(openFile)
  console.log('[6] cell pipes:', await evalJs(`(async () => {
    const td = document.querySelector('.md-preview tbody td')
    const pipe = td.querySelector('.md-cell-pipe')
    const before = getComputedStyle(pipe).display
    td.closest('.md-block-inner').focus()
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
    const first = w.nextNode()
    const r = document.createRange()
    r.setStart(first, 0)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    await new Promise(r => setTimeout(r, 250))
    const during = getComputedStyle(pipe).display
    const pipeCount = td.querySelectorAll('.md-cell-pipe').length
    return JSON.stringify({ before, during, pipeCount })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
