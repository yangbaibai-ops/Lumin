// 最终全面验证：文件树 / 编辑循环 / 查找栏 / 主题切换 / 大纲联动
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

  // 1. 设置工作区并刷新
  await evalJs(`window.luminAPI.workspace.setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace')`)
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))
  console.log('[1] file tree:', await evalJs(`JSON.stringify({
    files: Array.from(document.querySelectorAll('aside [class*=truncate]')).map(n => n.textContent).slice(0, 8),
    hasTree: document.body.innerText.includes('README.md'),
    hasFolder: document.body.innerText.includes('docs')
  })`))

  // 2. 点击 README.md 打开
  console.log('[2] open README:', await evalJs(`(async () => {
    const el = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'README.md')
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    return JSON.stringify({ route: location.hash, h1: document.querySelector('.md-preview h1')?.textContent ?? null })
  })()`))

  // 3. 编辑循环（点击 h1 块 → 修改 → Escape → 验证渲染 + 无异常）
  console.log('[3] edit cycle:', await evalJs(`(async () => {
    const h1 = document.querySelector('.md-preview h1')
    h1?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))
    const ta = document.querySelector('textarea.md-raw')
    if (!ta) return 'NO_TA'
    ta.value = '# Lumin 已编辑 ✦'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({ h1: document.querySelector('.md-preview h1')?.textContent ?? null })
  })()`))

  // 4. 查找栏（实时渲染模式）
  console.log('[4] find bar:', await evalJs(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const bar = document.querySelector('input[placeholder="查找"]')
    if (!bar) return 'NO_FIND_BAR'
    bar.value = 'Lumin'
    bar.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const marks = document.querySelectorAll('mark.lm-find-mark').length
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return JSON.stringify({ marks })
  })()`))

  // 5. 主题切换（先打开状态栏主题下拉）
  console.log('[5] theme switch:', await evalJs(`(async () => {
    const sel = Array.from(document.querySelectorAll('button')).find(b => /跟随系统|浅色|深色/.test(b.textContent) && b.textContent.length < 8)
    sel?.click()
    await new Promise(r => setTimeout(r, 300))
    const dark = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('深色'))
    dark?.click()
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({ dark: document.documentElement.classList.contains('theme-dark') })
  })()`))

  // 6. 大纲联动
  console.log('[6] outline sync:', await evalJs(`(async () => {
    const tab = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '大纲')
    tab?.click()
    await new Promise(r => setTimeout(r, 400))
    return JSON.stringify({ outlineHasTitle: document.body.innerText.includes('Lumin 已编辑') })
  })()`))

  console.log('[exceptions]', logs.slice(0, 6))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
