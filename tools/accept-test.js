// 最终验收：完整链路（打开 → 行内编辑 → 标记符 → 保存 → FTS 片段 → 全局搜索高亮）
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
  await send('Runtime.enable', {})

  console.log('[1] open+edit:', await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    const p = Array.from(document.querySelectorAll('.md-block-inner p')).find(x => x.textContent.length > 10)
    p.closest('.md-block-inner').focus()
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) break }
    const r = document.createRange()
    r.setStart(n, 2)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    document.execCommand('insertText', false, '所见即所得')
    await new Promise(r => setTimeout(r, 700))
    return JSON.stringify({
      h1: document.querySelector('.md-preview h1')?.textContent ?? null,
      noTextarea: !document.querySelector('textarea.md-raw'),
      edited: Array.from(document.querySelectorAll('.md-block-inner p')).some(x => x.textContent.includes('所见即所得'))
    })
  })()`))

  console.log('[2] save+fts:', await evalJs(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const hit = await window.luminAPI.db.search('所见即所得')
    const latin = await window.luminAPI.db.search('编辑')
    return JSON.stringify({
      cjkHit: hit.length > 0,
      cjkSnip: (hit[0]?.bodySnippet || '').slice(0, 50),
      latinHit: latin.length > 0
    })
  })()`))

  console.log('[3] global search highlight:', await evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    const modal = Array.from(document.querySelectorAll('input')).find(i => i.placeholder.includes('全文索引') || i.placeholder.includes('full-text'))
    if (modal) {
      modal.value = '所见即所得'
      modal.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 900))
    }
    const hl = document.querySelectorAll('.gs-hl').length
    const items = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('features.md')).length
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return JSON.stringify({ opened: !!modal, highlight: hl, items })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
