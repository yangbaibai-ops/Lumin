// 最小复测 heading input rule（# + 空格 → h1），确认是否为环境抖动而非真实回归。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  // 桥接
  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  if (boot !== 'OK') { console.log('FAIL bridge', boot); process.exit(2) }

  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(600)
  await ev(`(() => { const ed = window.__vt.ed(); ed?.commands.focus('start'); return document.hasFocus() })()`)
  await sleep(200)

  // 多次尝试
  for (let attempt = 1; attempt <= 4; attempt++) {
    await send('Input.insertText', { text: '#' })
    await sleep(60)
    await send('Input.insertText', { text: ' ' })
    await sleep(300)
    const r = await ev(`(() => {
      const h = document.querySelector('.ProseMirror h1')
      const ed = window.__vt.ed()
      return { hasH1: !!h, h1Text: h?.textContent ?? '', reveal: h?.classList.contains('md-reveal') ?? false, md: ed?.storage.markdown.getMarkdown() ?? '' }
    })()`)
    console.log(`attempt ${attempt}:`, JSON.stringify(r))
    if (r.hasH1) { console.log('PASS heading-input-rule'); ws.close(); process.exit(0) }
    // 重置为空白再试
    await ev(`(() => { window.__vt.ed().commands.setContent(''); window.__vt.ed().commands.focus('start'); return 'ok' })()`)
    await sleep(300)
  }
  console.log('FAIL heading-input-rule (4 attempts)')
  ws.close()
  process.exit(1)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
