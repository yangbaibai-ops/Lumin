// 最终验证：可信输入驱动的行内编辑 + Enter/Backspace/Tab + SQLite + 全局搜索
const SETUP = `
function setCaret(node, offset) {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
}
function firstText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if (!n.parentElement?.classList.contains('md-meta')) return n
  }
  return null
}
function focusP() {
  const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
  const inner = p.closest('.md-block-inner')
  inner.focus()
  const tn = firstText(p)
  setCaret(tn, 4)
  return { p, inner }
}
`

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
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 220))
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
  const typeChar = async (ch) => {
    await key('keyDown', { key: ch, code: 'Key' + ch.toUpperCase(), text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.charCodeAt(0) })
    await key('keyUp', { key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.charCodeAt(0) })
  }
  const pressEnter = async () => {
    await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  const pressBackspace = async () => {
    await key('keyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  const pressTab = async () => {
    await key('keyDown', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await key('keyUp', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  }
  await send('Runtime.enable', {})

  // 0. 打开 features.md
  console.log('[0] open:', await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return JSON.stringify({
      h1: document.querySelector('.md-preview h1')?.textContent ?? null,
      noTextarea: !document.querySelector('textarea.md-raw')
    })
  })()`))

  // 1. 可信输入行内打字
  await evalJs(`(() => { ${SETUP} const r = focusP(); window.__pp = r.p; return 'ready' })()`)
  await typeChar('I')
  await typeChar('N')
  await typeChar('L')
  await typeChar('I')
  await typeChar('N')
  await typeChar('E')
  await new Promise((r) => setTimeout(r, 700))
  console.log('[1] typed:', await evalJs(`JSON.stringify({
    text: window.__pp?.textContent?.slice(0, 30) ?? null,
    noSource: !document.querySelector('textarea.md-raw'),
    synced: Array.from(document.querySelectorAll('.md-block-inner p')).some(p => p.textContent.includes('INLINE'))
  })`))

  // 2. Enter 拆分块（可信输入）
  await evalJs(`(() => { ${SETUP} focusP(); return 'ready' })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[2] enter split:', await evalJs(`JSON.stringify({
    blocks: document.querySelectorAll('.md-block-inner').length - 1,
    p1: document.querySelector('.md-block-inner p')?.textContent?.slice(0, 14) ?? null
  })`))

  // 3. Backspace 合并块（新块起点退格）
  console.log('[3] backspace merge:', await evalJs(`(async () => {
    ${SETUP}
    const inners = Array.from(document.querySelectorAll('.md-block-inner'))
    const second = inners[1]
    second.focus()
    const tn = firstText(second)
    setCaret(tn, 0)
    return 'ready'
  })()`))
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 800))
  console.log('[3b] after merge:', await evalJs(`JSON.stringify({
    blocks: document.querySelectorAll('.md-block-inner').length - 1
  })`))

  // 4. 标记符显隐
  console.log('[4] markers:', await evalJs(`(async () => {
    ${SETUP}
    const strong = document.querySelector('.md-preview strong')
    const hidden = strong ? getComputedStyle(strong.querySelector('.md-meta')).display : 'n/a'
    const tn = strong ? firstText(strong) : null
    if (tn && strong) {
      strong.closest('.md-block-inner').focus()
      setCaret(tn, 2)
      await new Promise(r => setTimeout(r, 200))
    }
    const revealed = strong ? getComputedStyle(strong.querySelector('.md-meta')).display : 'n/a'
    const weight = strong ? getComputedStyle(strong).fontWeight : 'n/a'
    return JSON.stringify({ hidden, revealed, weight })
  })()`))

  // 5. 表格 Tab 导航
  console.log('[5] table tab:', await evalJs(`(async () => {
    ${SETUP}
    const td = document.querySelector('.md-preview tbody td')
    td.closest('.md-block-inner').focus()
    const tn = firstText(td)
    setCaret(tn, tn.textContent.length)
    return 'ready'
  })()`))
  await pressTab()
  await typeChar('Z')
  await new Promise((r) => setTimeout(r, 700))
  console.log('[5b] tab result:', await evalJs(`JSON.stringify({
    cell2: document.querySelectorAll('.md-preview tbody td')[1]?.textContent ?? null
  })`))

  // 6. 保存 + SQLite 搜索
  console.log('[6] sqlite:', await evalJs(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const r1 = await window.luminAPI.db.search('所见即所得')
    const r2 = await window.luminAPI.db.search('INLINE')
    const r3 = await window.luminAPI.db.search('表格')
    const stats = await window.luminAPI.db.stats()
    return JSON.stringify({
      stats,
      hitCJK: r1.length > 0,
      hitLatin: r2.length > 0,
      hitShort: r3.length > 0,
      snippet: (r2[0]?.bodySnippet || '').slice(0, 40)
    })
  })()`))

  // 7. 全局搜索弹窗
  console.log('[7] global search:', await evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    const modal = Array.from(document.querySelectorAll('input')).find(i => i.placeholder.includes('全文索引') || i.placeholder.includes('full-text'))
    if (modal) {
      modal.value = 'INLINE'
      modal.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 900))
    }
    const items = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('features.md')).length
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return JSON.stringify({ opened: !!modal, items })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
