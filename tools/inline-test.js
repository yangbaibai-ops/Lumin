// 行内所见即所得 + SQLite 冒烟测试
const helpers = `
function setCaret(node, offset) {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
}
function insertText(t) {
  document.execCommand('insertText', false, t)
}
function blurAll() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  document.body.focus()
}
function textNodesIn(el) {
  const out = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if (n.parentElement && n.parentElement.classList.contains('md-meta')) continue
    out.push(n)
  }
  return out
}
function firstText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if (!n.parentElement?.classList.contains('md-meta')) return n
  }
  return null
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
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 240))
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
    if (r.result?.exceptionDetails) {
      return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 200)
    }
    return r.result?.result?.value
  }
  await send('Runtime.enable', {})

  // 0. 启动进入编辑器并打开 features.md
  console.log('[0] open file:', await evalJs(`(async () => {
    ${helpers}
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1500))
    const treeItem = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    treeItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return JSON.stringify({
      route: location.hash,
      h1: document.querySelector('.md-preview h1')?.textContent ?? null,
      noTextarea: !document.querySelector('textarea.md-raw'),
      blocks: document.querySelectorAll('.md-block-inner').length
    })
  })()`))

  // 1. 行内编辑（不显示源码）
  console.log('[1] inline edit:', await evalJs(`(async () => {
    ${helpers}
    const p = document.querySelector('.md-preview p')
    const node = firstText(p)
    p.focus()
    setCaret(node, 2)
    insertText('所见即所得')
    await new Promise(r => setTimeout(r, 500))
    blurAll()
    await new Promise(r => setTimeout(r, 400))
    const newP = document.querySelector('.md-preview p')
    return JSON.stringify({
      text: newP?.textContent ?? null,
      noSourceVisible: !document.querySelector('textarea.md-raw'),
      hasInserted: (newP?.textContent || '').includes('所见即所得')
    })
  })()`))

  // 2. 标记符显隐（光标进入加粗文字显示 **，样式不变）
  console.log('[2] marker reveal:', await evalJs(`(async () => {
    ${helpers}
    const strong = document.querySelector('.md-preview strong')
    const metaSpans = strong ? strong.querySelectorAll('.md-meta').length : 0
    const before = strong ? getComputedStyle(strong.querySelector('.md-meta')).display : 'n/a'
    // 光标进入 strong
    const tn = strong ? firstText(strong) : null
    if (tn) {
      strong.parentElement.focus()
      setCaret(tn, 2)
      await new Promise(r => setTimeout(r, 200))
    }
    const after = strong ? getComputedStyle(strong.querySelector('.md-meta')).display : 'n/a'
    const revealed = strong?.classList.contains('md-reveal') ?? false
    const styleKept = strong ? getComputedStyle(strong).fontWeight === '700' : false
    // 光标移到普通段落
    const p = document.querySelector('.md-preview p')
    const pn = firstText(p)
    if (pn) { p.focus(); setCaret(pn, 0) }
    await new Promise(r => setTimeout(r, 200))
    const afterLeave = strong ? getComputedStyle(strong.querySelector('.md-meta')).display : 'n/a'
    return JSON.stringify({ metaSpans, before, after, revealed, styleKept, afterLeave })
  })()`))

  // 3. 表格单元格直接编辑 + Tab 导航
  console.log('[3] table edit:', await evalJs(`(async () => {
    ${helpers}
    const td = document.querySelector('.md-preview tbody td')
    const tn = firstText(td)
    td.closest('.md-block-inner').focus()
    setCaret(tn, tn.textContent.length)
    insertText(' ✓')
    await new Promise(r => setTimeout(r, 500))
    // Tab 到下一个单元格（光标移动而非 focus 变化）
    td.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 200))
    insertText('TAB')
    await new Promise(r => setTimeout(r, 500))
    blurAll()
    await new Promise(r => setTimeout(r, 500))
    const cells = Array.from(document.querySelectorAll('.md-preview tbody td'))
    return JSON.stringify({
      cell1: cells[0]?.textContent ?? null,
      cell2: cells[1]?.textContent ?? null,
      tabMoved: (cells[1]?.textContent || '').includes('TAB'),
      noSource: !document.querySelector('textarea.md-raw')
    })
  })()`))

  // 4. 链接保持可点击（点击不显示源码）
  console.log('[4] link:', await evalJs(`(async () => {
    ${helpers}
    const a = document.querySelector('.md-preview a[href^="http"]')
    const innerBefore = a?.textContent
    const tn = a ? firstText(a) : null
    if (tn && a) {
      a.closest('.md-block-inner').focus()
      setCaret(tn, 1)
      insertText('X')
      await new Promise(r => setTimeout(r, 400))
      blurAll()
      await new Promise(r => setTimeout(r, 300))
    }
    return JSON.stringify({
      before: innerBefore,
      after: a?.textContent ?? null,
      href: a?.getAttribute('href') ?? null,
      noBrackets: !document.querySelector('.md-preview')?.innerHTML.includes('](')
    })
  })()`))

  // 5. 公式点击 → 行内编辑 LaTeX
  console.log('[5] math edit:', await evalJs(`(async () => {
    ${helpers}
    const math = document.querySelector('.md-math')
    const texBefore = math?.dataset.tex ?? null
    math?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    const input = document.querySelector('.md-math-input')
    const hasInput = !!input
    if (input) {
      input.value = 'a^2 + b^2 = c^2'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 600))
    }
    const math2 = document.querySelector('.md-math')
    return JSON.stringify({ texBefore, hasInput, texAfter: math2?.dataset.tex ?? null })
  })()`))

  // 6. 代码块点击 → 源码编辑 → 重新高亮
  console.log('[6] code edit:', await evalJs(`(async () => {
    ${helpers}
    await new Promise(r => setTimeout(r, 500))
    const pre = document.querySelector('pre.code-wrap')
    pre?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    const ta = document.querySelector('textarea.md-code-raw')
    const shown = ta?.value ?? null
    if (ta) {
      ta.value = ta.value.replace('const y = 42', 'const z = 7')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.blur()
      await new Promise(r => setTimeout(r, 700))
    }
    return JSON.stringify({
      shown,
      after: document.querySelector('pre.code-wrap code')?.textContent ?? null,
      highlighted: !!document.querySelector('pre.code-wrap .hljs-keyword')
    })
  })()`))

  // 7. Enter 拆分块 / Backspace 合并块
  console.log('[7] block split/merge:', await evalJs(`(async () => {
    ${helpers}
    await new Promise(r => setTimeout(r, 600))
    const realBlocks = () => document.querySelectorAll('.md-block-inner').length - 1 // 减去虚尾块
    const before = realBlocks()
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    const inner = p.closest('.md-block-inner')
    inner.focus()
    const tn = firstText(p)
    setCaret(tn, 3)
    const ok = document.execCommand('insertParagraph')
    await new Promise(r => setTimeout(r, 700))
    const afterSplit = realBlocks()
    return JSON.stringify({ before, afterSplit, execOk: ok })
  })()`))

  // 8. 虚尾块持续写作
  console.log('[8] virtual tail:', await evalJs(`(async () => {
    ${helpers}
    const inners = Array.from(document.querySelectorAll('.md-block-inner'))
    const virtual = inners[inners.length - 1]
    const realBefore = inners.length - 1
    virtual.focus()
    await new Promise(r => setTimeout(r, 100))
    insertText('尾部新段落')
    await new Promise(r => setTimeout(r, 700))
    const inners2 = Array.from(document.querySelectorAll('.md-block-inner'))
    const realAfter = inners2.length - 1
    const lastReal = inners2[inners2.length - 2]
    return JSON.stringify({
      realBefore,
      realAfter,
      tailText: lastReal?.textContent?.slice(0, 20) ?? null
    })
  })()`))

  // 9. SQLite：保存后全文搜索 + 元数据
  console.log('[9] sqlite:', await evalJs(`(async () => {
    // 触发保存 → file:write → DB upsert（含最新内容）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const s1 = await window.luminAPI.db.stats()
    const r1 = await window.luminAPI.db.search('所见即所得')
    const r2 = await window.luminAPI.db.search('表格')
    const meta = await window.luminAPI.db.getDocument('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md')
    await window.luminAPI.db.setPinned('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md', true)
    const meta2 = await window.luminAPI.db.getDocument('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md')
    await window.luminAPI.db.setPinned('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\features.md', false)
    return JSON.stringify({
      stats: s1,
      hitInline: r1.length > 0,
      hitShort: r2.length > 0,
      metaWordCount: meta?.wordCount ?? null,
      pinned: meta2?.isPinned ?? false,
      snippet: (r1[0]?.bodySnippet || '').slice(0, 50)
    })
  })()`))

  // 10. 全局搜索弹窗（真实按键事件源自 document）
  console.log('[10] global search:', await evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    const modal = Array.from(document.querySelectorAll('input')).find(i => i.placeholder.includes('全文索引') || i.placeholder.includes('full-text'))
    const opened = !!modal
    if (modal) {
      modal.value = '表格'
      modal.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 900))
    }
    const resultItems = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('features.md')).length
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return JSON.stringify({ opened, hasResults: resultItems > 0, items: resultItems })
  })()`))

  console.log('[exceptions]', logs.slice(0, 8))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
