// 端到端：重新加载 → 输入含 mermaid 的文档 → 观察真实渲染路径
const SAMPLE = `# Mermaid 测试

\`\`\`mermaid
flowchart LR
  A[写作] --> B{渲染}
  B -->|实时| C[预览]
\`\`\`
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
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      logs.push(`[${m.params.type}] ${text.slice(0, 200)}`)
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300))
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
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))

  console.log('[boot]', await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1200))
    return JSON.stringify({ live: !!document.querySelector('.md-preview') })
  })()`))

  console.log('[type]', await evalJs(`(async () => {
    const ph = document.querySelector('.md-preview .cursor-text') || document.querySelector('.md-preview')
    ph.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 200))
    const ta = document.querySelector('textarea.md-raw')
    if (!ta) return 'NO_TEXTAREA'
    ta.value = ${JSON.stringify(SAMPLE)}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'typed+escaped'
  })()`))

  // 轮询 8 秒观察 mermaid 状态
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const state = await evalJs(`JSON.stringify({
      ph: document.querySelectorAll('[data-mermaid]').length,
      svg: document.querySelectorAll('.md-mermaid svg').length,
      err: document.querySelectorAll('.mermaid-error').length,
      pre: document.querySelectorAll('.md-mermaid pre').length
    })`)
    console.log(`[+${i + 1}s]`, state)
  }
  console.log('[logs]', logs.filter((l) => /mermaid|EXC|error/i.test(l)).slice(0, 10))

  // 设置持久化检查（触发一次 settings 写入，观察是否有 clone 异常）
  console.log('[persist]', await evalJs(`(async () => {
    await window.luminAPI.settings.update({ fontSize: 17 })
    const all = await window.luminAPI.settings.getAll()
    return JSON.stringify({ fontSize: all.fontSize, ok: all.fontSize === 17 })
  })()`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
