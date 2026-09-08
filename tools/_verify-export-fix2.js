// 直接实例化 useExport 并调用 runExport('pdf')，验证修复后传入的是可克隆的普通对象。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }

const expr = `(async () => {
  try {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }

    // 拦截 export.pdf
    window.__exportCapture = null
    window.luminAPI.export.pdf = (payload, settings) => {
      window.__exportCapture = { settings, cloneable: (() => { try { structuredClone(settings); return true } catch { return false } })() }
      return Promise.resolve('D:\\\\fake.pdf')
    }

    const { useExport } = await import('/@fs/D:/code_workspace/Lumin/src/renderer/src/composables/useExport.ts')
    const { runExport } = useExport()
    await runExport('pdf')
    return JSON.stringify({ captured: !!window.__exportCapture, cloneable: window.__exportCapture?.cloneable, settings: window.__exportCapture?.settings })
  } catch (e) {
    return JSON.stringify({ err: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 600) })
  }
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  // 打开一个文档，让 files.current 存在
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1000)
  await ev(`(() => { const app = document.querySelector('#app')?.__vue_app__; if (!app) return 'NO_APP'; const prov = app._context.provides; const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)'); const pinia = sym ? prov[sym] : null; window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }; return 'OK' })()`)
  await ev(`(async () => { await window.__vt.files().openPath('D:\\\\code_workspace\\\\Lumin-test-workspace\\\\tipverify.md'); return 'ok' })()`)
  await sleep(1500)
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) console.log('EXCEPTION', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  else console.log(r.result?.result?.value)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
