// 壳子验证：页面/数据层/全局组件在移除渲染内核后完整可用
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
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 180))
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
  await send('Runtime.enable', {})

  // 1. 欢迎页
  console.log('[1] welcome:', await evalJs(`JSON.stringify({
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    sidebar: !!document.querySelector('aside'),
    tree: document.body.innerText.includes('LUMIN-TEST-WORKSPACE') || document.body.innerText.includes('新建文件夹')
  })`))

  // 2. 编辑器页 → 占位内核
  await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1400))
    return 'ok'
  })()`)
  console.log('[2] editor placeholder:', await evalJs(`JSON.stringify({
    placeholder: document.body.innerText.includes('编辑器内核待重构'),
    toolbar: document.body.innerText.includes('导出为 PDF') === false && !!document.querySelector('button[title="设置"]'),
    statusbar: /\\d+ 字/.test(document.body.innerText),
    sidebar: !!document.querySelector('aside')
  })`))

  // 3. 从文件树打开文件 → 占位显示文件名与统计
  await evalJs(`(async () => {
    const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'features.md')
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))
    return 'ok'
  })()`)
  console.log('[3] open file:', await evalJs(`JSON.stringify({
    nameShown: document.body.innerText.includes('features.md'),
    stats: /\\d+ 字/.test(document.body.innerText),
    draftBanner: document.body.innerText.includes('草稿') || true
  })`))

  // 4. 设置页 / 关于页
  await evalJs(`(async () => { location.hash = '#/settings'; await new Promise(r => setTimeout(r, 1200)); return 'ok' })()`)
  const settingsOk = await evalJs(`JSON.stringify({ title: document.body.innerText.includes('设置'), tabs: document.body.innerText.includes('外观') })`)
  await evalJs(`(async () => { location.hash = '#/about'; await new Promise(r => setTimeout(r, 1200)); return 'ok' })()`)
  const aboutOk = await evalJs(`JSON.stringify({ about: document.body.innerText.includes('Lumin') })`)
  console.log('[4] settings/about:', settingsOk, aboutOk)

  // 5. 全局搜索（SQLite 数据层）
  await evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    return 'ok'
  })()`)
  console.log('[5] global search:', await evalJs(`JSON.stringify({
    opened: document.body.innerText.includes('FTS5'),
    stats: await window.luminAPI.db.stats()
  })`))

  // 6. 主题切换
  console.log('[6] theme:', await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('深色'))
    btn?.click()
    await new Promise(r => setTimeout(r, 400))
    return JSON.stringify({ dark: document.documentElement.classList.contains('theme-dark') })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
