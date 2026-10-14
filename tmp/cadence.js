'use strict'
// 诊断：rAF 与 setTimeout 在隔离实例窗口里的实际节奏（判断能不能做逐帧取证）
const PORT = process.argv[2] || '9351'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  await send('Page.bringToFront').catch(() => null)
  const res = await ev(`(async () => {
    const rafD = []; const timD = []
    await new Promise((res) => { let n = 0; let last = performance.now()
      const step = () => { const now = performance.now(); rafD.push(+(now - last).toFixed(1)); last = now; if (++n >= 20) res(); else requestAnimationFrame(step) }
      requestAnimationFrame(step); setTimeout(() => res(), 3000) })
    await new Promise((res) => { let n = 0; const t0 = performance.now()
      const tick = () => { timD.push(+(performance.now() - t0).toFixed(0)); if (++n >= 10) res(); else setTimeout(tick, 16) }
      setTimeout(tick, 16) })
    return JSON.stringify({ rafCount: rafD.length, rafDeltas: rafD.slice(0, 12), rafAvg: +(rafD.reduce((a,b)=>a+b,0)/(rafD.length||1)).toFixed(1), timDeltas: timD, hidden: document.hidden, visState: document.visibilityState, focus: document.hasFocus() })
  })()`)
  console.log(res)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
