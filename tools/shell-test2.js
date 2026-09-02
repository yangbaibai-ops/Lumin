// 复验：全局搜索（SQLite）+ 主题切换
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
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 180)
    return r.result?.result?.value
  }

  // 全局搜索
  await evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    return 'ok'
  })()`)
  console.log('[5] global search:', await evalJs(`(async () => {
    const opened = document.body.innerText.includes('FTS5')
    const stats = await window.luminAPI.db.stats()
    const hit = await window.luminAPI.db.search('特性')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return JSON.stringify({ opened, stats, searchHit: hit.length > 0 })
  })()`))

  // 主题切换（先回到编辑器页，再打开状态栏主题下拉）
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1300))
    const sel = Array.from(document.querySelectorAll('button')).find(b => /跟随系统|浅色|深色|羊皮纸/.test(b.textContent) && b.textContent.length < 6)
    sel?.click()
    await new Promise(r => setTimeout(r, 300))
    const dark = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('深色'))
    dark?.click()
    await new Promise(r => setTimeout(r, 500))
    return 'ok'
  })()`)
  console.log('[6] theme:', await evalJs(`JSON.stringify({ dark: document.documentElement.classList.contains('theme-dark') })`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
