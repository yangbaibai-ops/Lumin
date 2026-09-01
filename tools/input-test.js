// 验证：基础输入逻辑 / 源码模式不渲染 / 代码块原地编辑
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
  const typeText = async (text) => {
    for (const ch of text) {
      const code = ch === '\n' ? 13 : ch.charCodeAt(0)
      await key('keyDown', {
        key: ch,
        code: 'Key' + ch.toUpperCase(),
        text: ch,
        unmodifiedText: ch,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code
      })
      await key('keyUp', { key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: code })
    }
  }
  const pressEnter = async () => {
    await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  const pressBackspace = async () => {
    await key('rawKeyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  await send('Runtime.enable', {})

  const DOC = '# 测试\n\n正文段落 **加粗内容** 结尾\n\n```js\nconst x = 1\n```\n'
  await evalJs(`(async () => {
    await window.luminAPI.workspace.setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace')
    await window.luminAPI.file.write('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\input-demo.md', ${JSON.stringify(DOC)})
    return 'ok'
  })()`)
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2800))
  console.log('[0] open:', await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'input-demo.md')
    const clicked = !!item
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1800))
    return JSON.stringify({
      clicked,
      route: location.hash,
      h1: document.querySelector('.md-preview h1')?.textContent ?? null,
      pCount: document.querySelectorAll('.md-block-inner p').length,
      preCount: document.querySelectorAll('.md-block-inner pre.code-wrap').length
    })
  })()`))

  // 确保处于实时渲染模式（editorMode 会持久化，上次测试切到了源码模式）
  await evalJs(`(async () => {
    const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    liveBtn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return JSON.stringify({ pCount: document.querySelectorAll('.md-block-inner p').length })
  })()`)

  // 1. 基础打字 + 符号（行内直接输入）
  await evalJs(`(() => {
    const p = document.querySelector('.md-preview p')
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
    return 'ready'
  })()`)
  await typeText(' 符号(*+_~`#)测试')
  await new Promise((r) => setTimeout(r, 600))
  console.log('[1] typing+symbols:', await evalJs(`JSON.stringify({
    text: Array.from(document.querySelectorAll('.md-block-inner p')).map(x => x.textContent).join('|'),
    rawVisible: Array.from(document.querySelectorAll('.md-block-inner p')).some(x => x.textContent.includes('( *+'))
  })`))

  // 2. 加粗文字中间回车 → 两侧都是加粗、无裸露标记符
  await evalJs(`(() => {
    const strong = document.querySelector('.md-preview strong')
    const block = strong.closest('.md-block-inner')
    block.focus()
    const w = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 2)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ready'
  })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[2] split inside bold:', await evalJs(`JSON.stringify({
    strongCount: document.querySelectorAll('.md-preview strong').length,
    rawAsterisk: document.querySelector('.md-preview')?.textContent?.includes('*') ?? false,
    blocks: Array.from(document.querySelectorAll('.md-block-inner')).map(b => JSON.stringify(b.textContent))
  })`))

  // 3. 代码块原位编辑：点击 → 框样式不变（高亮层+透明输入层），直接打字 + 回车
  console.log('[3] code in-place:', await evalJs(`(async () => {
    const pre = document.querySelector('pre.code-wrap')
    pre.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const ta = document.querySelector('textarea.code-edit-input')
    const boxStyle = ta ? getComputedStyle(ta.closest('.code-edit-box')).backgroundColor : null
    const highlightLayer = !!document.querySelector('.code-edit-highlight')
    if (ta) {
      ta.value = ta.value + 'const y = 2\\nreturn y'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 500))
      ta.blur()
      await new Promise(r => setTimeout(r, 700))
    }
    return JSON.stringify({
      hadOverlay: !!ta,
      boxStyle,
      highlightLayer,
      codeAfter: document.querySelector('pre.code-wrap code')?.textContent ?? null,
      highlighted: !!document.querySelector('pre.code-wrap .hljs-keyword')
    })
  })()`))

  // 4. 源码模式：不渲染 Markdown 样式（同字号、不加粗）
  console.log('[4] source flat:', await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('源码'))
    btn?.click()
    await new Promise(r => setTimeout(r, 1200))
    const cm = document.querySelector('.cm-editor')
    const heading = cm?.querySelector('.cm-line')?.textContent ?? null
    const headingStyle = cm ? getComputedStyle(cm.querySelector('.cm-line')).fontWeight + '/' + getComputedStyle(cm.querySelector('.cm-line')).fontSize : null
    const hasBold = Array.from(cm?.querySelectorAll('span') ?? []).some(s => getComputedStyle(s).fontWeight === '700')
    const hasLargeHeading = Array.from(cm?.querySelectorAll('span') ?? []).some(s => parseFloat(getComputedStyle(s).fontSize) > 17)
    return JSON.stringify({ firstLine: heading, headingStyle, hasBold, hasLargeHeading })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
