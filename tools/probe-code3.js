// 聚焦复现：代码块内 Enter 的真实行为
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

  // 重置文件 + 切换工作区
  const DOC = '# 测试\n\n正文段落\n\n' + '```js\nconst x = 1\n```\n'
  await evalJs(`(async () => {
    await window.luminAPI.workspace.setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace')
    await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\input-demo.md', ${JSON.stringify(DOC)})
    return 'ok'
  })()`)
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2800))
  await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'input-demo.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1700))
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return 'ok'
  })()`)

  // 点击代码块（触发扁平化）→ 光标到代码末尾
  await evalJs(`(() => {
    const pre = document.querySelector('pre.code-wrap')
    pre.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const block = pre.closest('.md-block-inner')
    block.focus()
    const code = pre.querySelector('code')
    const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    let last = null
    let n
    while ((n = w.nextNode())) last = n
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    window.__bi = []
    document.addEventListener('beforeinput', e => window.__bi.push(e.inputType), true)
    return JSON.stringify({ spanCount: code.querySelectorAll('span').length, text: code.textContent })
  })()`)

  await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise((r) => setTimeout(r, 1200)) // 等待输入同步完成后再打字
  console.log('[after enter]', await evalJs(`(() => {
    const s = getSelection()
    return JSON.stringify({
      bi: window.__bi,
      anchor: s.anchorNode?.textContent?.slice(-10) ?? null,
      offset: s.anchorOffset,
      anchorParent: s.anchorNode?.parentElement?.tagName ?? null,
      preHTML: document.querySelector('pre.code-wrap')?.outerHTML.slice(-150)
    })
  })()`))

  await key('keyDown', { key: 'X', code: 'KeyX', text: 'X', unmodifiedText: 'X', windowsVirtualKeyCode: 88 })
  await key('keyUp', { key: 'X', code: 'KeyX', windowsVirtualKeyCode: 88 })
  await new Promise((r) => setTimeout(r, 500))
  console.log('[after X]', await evalJs(`JSON.stringify({
    preHTML: document.querySelector('pre.code-wrap')?.outerHTML.slice(-200)
  })`))
  console.log('[logs]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
