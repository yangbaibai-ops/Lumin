// 计时：触发 app.close() 后，窗口多久真正关闭（验证关闭不再等待 2.5s）。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }

  const t0 = Date.now()
  await send('Runtime.evaluate', { expression: 'window.luminAPI.app.close()', returnByValue: true })

  // 轮询 CDP 端点，直到窗口消失（应用退出）
  let elapsed = -1
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50))
    try {
      const t = await (await fetch(CDP)).json()
      if (!t.some((x) => x.type === 'page')) { elapsed = Date.now() - t0; break }
    } catch {
      elapsed = Date.now() - t0
      break
    }
  }
  console.log('close elapsed ms:', elapsed)
  process.exit(elapsed >= 0 && elapsed < 2000 ? 0 : 1)
}
main().catch((e) => { console.log('FAIL', e.message); process.exit(1) })
