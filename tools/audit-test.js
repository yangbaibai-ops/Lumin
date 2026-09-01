// 渲染/输入逻辑审计测试 v2
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
  const pressEnter = async (shift = false) => {
    await key('keyDown', {
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: shift ? 8 : 0
    })
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await send('Runtime.enable', {})

  const DOC =
    '# 审计 Audit\n\n段落甲\n\n3. 第三项\n4. 第四项\n\n| 名称 | 状态 |\n| --- | --- |\n| 表格 | 可编辑 |\n\n- 列表一\n- 列表二\n- \n\n```js\nconst a = 1\n```\n'
  await evalJs(`(async () => {
    await window.luminAPI.workspace.setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace')
    await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\audit.md', ${JSON.stringify(DOC)})
    return 'ok'
  })()`)
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2800))
  await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'audit.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1700))
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return 'ok'
  })()`)

  // 1. 点击块边缘（padding 区域，可信鼠标事件）→ 光标应进入块
  await evalJs(`(() => {
    const inner = document.querySelector('.md-block-inner')
    const rect = inner.getBoundingClientRect()
    window.__clickX = rect.left + 2
    window.__clickY = rect.top + rect.height / 2
    return 'ready'
  })()`)
  await send('Runtime.evaluate', {
    expression: `JSON.stringify({ x: window.__clickX, y: window.__clickY, padL: getComputedStyle(document.querySelector('.md-block-inner')).paddingLeft })`,
    returnByValue: true
  })
  const coords = await evalJs(`JSON.stringify({ x: window.__clickX, y: window.__clickY })`)
  const { x, y } = JSON.parse(coords)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 250))
  console.log('[1] edge click caret:', await evalJs(`(() => {
    const inner = document.querySelector('.md-block-inner')
    const s = getSelection()
    return JSON.stringify({ caretInBlock: inner.contains(s.anchorNode) })
  })()`))

  // 2. Shift+Enter → 硬换行 <br>，失焦后仍保留
  console.log('[2] shift+enter:', await evalJs(`(async () => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.includes('段落甲'))
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
  })()`))
  await pressEnter(true)
  await new Promise((r) => setTimeout(r, 300))
  await evalJs(`(() => { document.execCommand('insertText', false, '第二行'); return 'ok' })()`)
  await new Promise((r) => setTimeout(r, 700))
  console.log('[2b] result:', await evalJs(`(async () => {
    // 失焦提交
    if (document.activeElement?.blur) document.activeElement.blur()
    document.body.focus()
    await new Promise(r => setTimeout(r, 600))
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.includes('段落甲'))
    return JSON.stringify({
      hasBr: !!p?.querySelector('br'),
      text: p?.textContent ?? null
    })
  })()`))

  // 3. 表格单元格内回车 → 单元格换行 <br>，表格结构不坏
  console.log('[3] table cell enter:', await evalJs(`(async () => {
    const td = document.querySelector('.md-preview tbody td')
    const block = td.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
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
  })()`))
  await pressEnter(false)
  await evalJs(`(() => { document.execCommand('insertText', false, '新行'); return 'ok' })()`)
  await new Promise((r) => setTimeout(r, 700))
  console.log('[3b] result:', await evalJs(`(async () => {
    if (document.activeElement?.blur) document.activeElement.blur()
    document.body.focus()
    await new Promise(r => setTimeout(r, 600))
    const table = document.querySelector('.md-preview table')
    const cell = table?.querySelector('tbody td')
    return JSON.stringify({
      tableIntact: !!table && table.querySelectorAll('tr').length === 2,
      cellBr: !!cell?.querySelector('br'),
      cellText: cell?.textContent ?? null
    })
  })()`))

  // 4. 有序列表起始序号往返
  console.log('[4] ol start:', await evalJs(`(async () => {
    const ol = document.querySelector('.md-preview ol')
    const startAttr = ol?.getAttribute('start') ?? null
    // 失焦后从源码状态检查 markdown
    if (document.activeElement?.blur) document.activeElement.blur()
    document.body.focus()
    await new Promise(r => setTimeout(r, 600))
    return JSON.stringify({ startAttr, olStill: !!document.querySelector('.md-preview ol') })
  })()`))

  // 5. 空列表项回车 → 退出列表
  console.log('[5] empty li enter:', await evalJs(`(async () => {
    const lis = Array.from(document.querySelectorAll('.md-preview li'))
    const empty = lis.find(li => (li.textContent || '').trim() === '')
    if (!empty) return 'NO_EMPTY_LI'
    const block = empty.closest('.md-block-inner')
    block.focus()
    const r = document.createRange()
    r.selectNodeContents(empty)
    r.collapse(false)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`))
  await pressEnter(false)
  await new Promise((r) => setTimeout(r, 800))
  console.log('[5b] result:', await evalJs(`JSON.stringify({
    liCount: document.querySelectorAll('.md-preview li').length,
    blocks: Array.from(document.querySelectorAll('.md-block-inner')).map(b => JSON.stringify(b.textContent))
  })`))

  // 6. 粘贴多行文本 → 多个 <br>（合成 beforeinput insertFromPaste 触发应用逻辑）
  console.log('[6] paste multiline:', await evalJs(`(async () => {
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.includes('段落甲'))
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
    // 构造粘贴事件（与真实 Ctrl+V 相同的 beforeinput 通道）
    const dt = new DataTransfer()
    dt.setData('text/plain', 'A\\nB\\nC')
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      dataTransfer: dt,
      bubbles: true,
      cancelable: true
    })
    block.dispatchEvent(ev)
    await new Promise(r => setTimeout(r, 400))
    return JSON.stringify({
      brCount: p.querySelectorAll('br').length,
      text: p.textContent
    })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
