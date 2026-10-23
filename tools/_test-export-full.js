// 全链路导出测试：打开含 mermaid/表格/任务的验收文档，走 buildExportHtml 完整路径。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

const expr = `(async () => {
  try {
    const app = document.querySelector('#app').__vue_app__
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    const files = pinia._s.get('files')
    const ed = pinia._s.get('editor')?.instance
    const settings = pinia._s.get('settings')
    const m = await import('/@fs/C:/work/Lumin/src/renderer/src/lib/export.ts')
    const raw = ed ? ed.getHTML() : '<p>x</p>'
    const html = await m.renderMermaidInHtml(raw, settings.effectiveTheme)
    const title = (files.current?.name || 'doc').replace(/\\.(md|markdown|txt)$/i, '')
    const r = await window.luminAPI.export.pdf({ title, html, css: m.exportCss }, settings.export.pdf)
    return JSON.stringify({ ok: true, path: r, htmlLen: html.length, hasMermaid: raw.includes('language-mermaid'), hasSvg: html.includes('<svg') })
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
  // 打开验收文档
  await ev(`(async () => { await window.__vt_files_open('C:\\\\work\\\\Lumin\\\\test-workspace\\\\tipverify.md'); return 'ok' })()`).catch(() => {})
  // 确保桥接 + 打开文档
  await send('Runtime.evaluate', { expression: `(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`, returnByValue: true })
  await ev(`(async () => { await window.__vt.files().openPath('C:\\\\work\\\\Lumin\\\\test-workspace\\\\tipverify.md'); return 'ok' })()`)
  await sleep(1500)
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) console.log('EXCEPTION', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  else console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
