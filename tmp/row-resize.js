'use strict'
// 把实例窗口调到用户真实尺寸（1440x955）并确认 innerWidth；同时清掉任何 emulation override
const PORT = process.argv[2] || '9351'
const W = Number(process.argv[3] || 1440)
const H = Number(process.argv[4] || 955)
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
    if (r.result && r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  const before = await ev(`JSON.stringify({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, sw: screen.width, sh: screen.height, availH: screen.availHeight })`)
  await ev(`(() => { window.resizeTo(${W}, ${H}); return 'ok' })()`)
  await new Promise((r) => setTimeout(r, 900))
  const after = await ev(`JSON.stringify({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight })`)
  console.log('before', before)
  console.log('after ', after)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1) })
