// 验证 bug2 修复：拦截 export.pdf，触发真实 runExport，检查传入的 settings 是否可克隆（普通对象）。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }
async function mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 }) }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  // 桥接 + 打开文档 + 拦截 export.pdf
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    window.__exportCapture = null
    const orig = window.luminAPI.export.pdf.bind(window.luminAPI.export)
    window.luminAPI.export.pdf = (payload, settings) => {
      window.__exportCapture = { settings, cloneable: (() => { try { structuredClone(settings); return true } catch { return false } })(), isProxy: !!(settings && settings.__v_isReactive) }
      return Promise.resolve('D:\\fake.pdf')
    }
    return 'OK'
  })()`)
  await ev(`(async () => { await window.__vt.files().openPath('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\tipverify.md'); return 'ok' })()`)
  await sleep(1200)

  // 点击工具栏导出按钮 → 点击 PDF 项
  const btn = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '导出'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!btn) { console.log('FAIL no export button'); process.exit(2) }
  await mouse('mousePressed', btn.x, btn.y)
  await mouse('mouseReleased', btn.x, btn.y)
  await sleep(400)
  const item = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出为 PDF'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!item) { console.log('FAIL no PDF item (dropdown not open?)'); process.exit(2) }
  await mouse('mousePressed', item.x, item.y)
  await mouse('mouseReleased', item.x, item.y)
  await sleep(1200)

  const cap = await ev(`window.__exportCapture`)
  console.log('capture', JSON.stringify(cap))
  ws.close()
  process.exit(cap && cap.cloneable === true ? 0 : 1)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
