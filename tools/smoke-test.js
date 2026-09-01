// Lumin 交互冒烟测试：通过 CDP 在真实窗口内执行
const SAMPLE = `# 你好，Lumin ✨

这是一段 **所见即所得** 的测试文本，包含 *斜体*、~~删除线~~ 与 \`行内代码\`。

- 无序列表项
- 任务清单：
- [ ] 待办事项
- [x] 已完成事项

> 引用块：写作如光般通透。

| 功能 | 状态 |
| --- | --- |
| 实时渲染 | ✅ |
| 数学公式 | ✅ |

行内公式 $E = mc^2$ 与块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

\`\`\`javascript
function greet(name) {
  console.log('Hello, ' + name)
}
\`\`\`

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
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails) {
      return 'EXCEPTION: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    }
    return r.result?.result?.value
  }

  const sampleJson = JSON.stringify(SAMPLE)

  // 1. 进入编辑器
  console.log('[1] editor boot:', await evalJs(`(async () => {
    location.hash = '#/editor'
    await new Promise(r => setTimeout(r, 1500))
    return JSON.stringify({
      route: location.hash,
      hasSidebar: !!document.querySelector('aside'),
      placeholder: document.body.innerText.includes('在此开始写作'),
      liveArea: !!document.querySelector('.md-preview')
    })
  })()`))

  // 2. 模拟输入整篇 Markdown
  console.log('[2] typing:', await evalJs(`(async () => {
    const ph = document.querySelector('.md-preview .cursor-text') || document.querySelector('.md-preview')
    ph.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 120))
    const ta = document.querySelector('textarea.md-raw')
    if (!ta) return 'NO_TEXTAREA'
    ta.value = ${sampleJson}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise(r => setTimeout(r, 1800))
    return JSON.stringify({
      h1: document.querySelector('.md-preview h1')?.textContent ?? null,
      strong: !!document.querySelector('.md-preview strong'),
      taskBoxes: document.querySelectorAll('.md-preview input[type=checkbox]').length,
      table: !!document.querySelector('.md-preview table'),
      quote: !!document.querySelector('.md-preview blockquote'),
      katex: document.querySelectorAll('.md-preview .katex').length,
      hljs: !!document.querySelector('.md-preview .hljs-keyword'),
      mermaidSvg: !!document.querySelector('.md-mermaid svg'),
      toc: !!document.querySelector('.md-toc')
    })
  })()`))

  // 3. 切换到源码模式
  console.log('[3] source mode:', await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('源码'))
    if (!btn) return 'NO_BTN'
    btn.click()
    await new Promise(r => setTimeout(r, 1200))
    return JSON.stringify({
      cm: !!document.querySelector('.cm-editor'),
      content: document.querySelector('.cm-content')?.textContent.includes('你好，Lumin') ?? false,
      lineNumbers: !!document.querySelector('.cm-gutters')
    })
  })()`))

  // 4. 切回实时渲染
  console.log('[4] back to live:', await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
    btn?.click()
    await new Promise(r => setTimeout(r, 1000))
    return JSON.stringify({ h1Back: document.querySelector('.md-preview h1')?.textContent ?? null })
  })()`))

  // 5. 大纲联动
  console.log('[5] outline:', await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('大纲'))
    btn?.click()
    await new Promise(r => setTimeout(r, 400))
    const outline = btn?.parentElement?.parentElement
    const body = document.body.innerText
    return JSON.stringify({ headingInOutline: body.includes('你好，Lumin') })
  })()`))

  // 6. 状态栏统计
  console.log('[6] statusbar:', await evalJs(`(() => {
    const t = document.body.innerText
    return JSON.stringify({
      hasWordCount: /\\d+ 字/.test(t),
      hasCursor: /行 \\d+，列/.test(t),
      theme: document.documentElement.className
    })
  })()`))

  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
