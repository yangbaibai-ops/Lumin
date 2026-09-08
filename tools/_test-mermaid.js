// 测试 renderMermaidInHtml 在真实渲染层上下文中的表现（mermaid 动态导入）。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

const expr = `(async () => {
  try {
    const m = await import('/@fs/D:/code_workspace/Lumin/src/renderer/src/lib/export.ts')
    const html = '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>'
    const t0 = Date.now()
    const out = await m.renderMermaidInHtml(html, 'light')
    return JSON.stringify({ ok: true, ms: Date.now() - t0, hasSvg: out.includes('<svg'), len: out.length })
  } catch (e) {
    return JSON.stringify({ ok: false, err: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 800) })
  }
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) console.log('EXCEPTION', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  else console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
