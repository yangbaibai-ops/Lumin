'use strict'
// 快速查看：当前文档、图片、错误提示
const PORT = process.argv[2] || '9351'
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  const out = {
    bridge: await ev(`!!window.__vt`),
    files: await ev(`(() => { const f = window.__vt.files(); return { path: f.currentPath, dir: f.currentDir, contentLen: (f.content||'').length } })()`),
    doc: await ev(`(() => { const e = window.__vt.ed(); if (!e) return null; return { size: e.state.doc.content.size, text: e.state.doc.textBetween(0, Math.min(400, e.state.doc.content.size), '\\n') } })()`),
    imgs: await ev(`document.querySelectorAll('.ProseMirror img').length`),
    widgets: await ev(`document.querySelectorAll('.ProseMirror [data-img-widget]').length`),
    toasts: await ev(`[...document.querySelectorAll('[class*=toast],[class*=notif],[role=alert]')].map((n) => (n.textContent||'').slice(0,120))`),
    dialogs: await ev(`[...document.querySelectorAll('[role=dialog],[class*=modal]')].map((n) => (n.textContent||'').slice(0,160))`)
  }
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1) })
