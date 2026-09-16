// 检查代码块内拖选是否真的产生非空选区：mousedown → 数次 mousemove → 在 mouseup 之前读选区。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }
async function mouse(type, x, y, opts = {}) { await send('Input.dispatchMouseEvent', { type, x, y, button: opts.button ?? 'left', buttons: opts.buttons ?? (type === 'mouseup' ? 0 : 1), clickCount: opts.clickCount ?? 1 }) }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

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

  await ev(`(() => { location.hash = '#/editor'; window.__vt.ui().editorMode = 'wysiwyg'; window.__vt.settings().syncScroll = false; return 'ok' })()`)
  await sleep(1000)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(800)
  const md = `\`\`\`js
const a = 1
const b = 2
\`\`\``
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(500)

  const rect = await ev(`(() => { const cm = document.querySelector('.cm-editor .cm-content'); if (!cm) return null; const b = cm.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height, y: b.top + b.height * 0.3 } })()`)
  if (!rect) { console.log('FAIL no cm'); process.exit(2) }

  const x0 = rect.left + 4
  const x1 = rect.left + Math.min(120, rect.width - 8)
  const y = rect.y

  await mouse('mousePressed', x0, y, { clickCount: 1 })
  await sleep(30)
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y, { button: 'left', buttons: 1 })
    await sleep(25)
  }
  // mouseup 之前读取
  const mid = await ev(`(() => {
    const sel = document.getSelection()
    const cmContent = document.querySelector('.cm-editor .cm-content')
    return { text: sel ? sel.toString() : '', collapsed: sel ? sel.isCollapsed : true, inCm: !!(sel && cmContent && (cmContent.contains(sel.anchorNode) || cmContent.contains(sel.focusNode))) }
  })()`)
  console.log('mid-drag', JSON.stringify(mid))
  await mouse('mouseReleased', x1, y, { clickCount: 1 })
  await sleep(50)
  const after = await ev(`(() => {
    const sel = document.getSelection()
    return { text: sel ? sel.toString() : '', collapsed: sel ? sel.isCollapsed : true }
  })()`)
  console.log('after-mouseup', JSON.stringify(after))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
