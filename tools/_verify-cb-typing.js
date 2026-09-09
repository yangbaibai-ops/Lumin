// 回归：代码块内输入、Enter 换行仍正常（空块退格删除修复不破坏既有行为）。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function key(type, key, code, vk, text, modifiers) { await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(text !== undefined ? { text } : {}), ...(modifiers ? { modifiers } : {}) }) }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  // 点击代码块内容区聚焦 CM
  const cm = await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 8 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cm.x, y: cm.y, clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cm.x, y: cm.y, clickCount: 1, buttons: 0 })
  await sleep(300)

  // 输入 'hello'
  await send('Input.insertText', { text: 'hello' })
  await sleep(300)
  // Enter 换行
  await key('keyDown', 'Enter', 'Enter', 13); await key('keyUp', 'Enter', 'Enter', 13)
  await sleep(300)
  // 再输入 'world'
  await send('Input.insertText', { text: 'world' })
  await sleep(500)
  const r = await ev(`(() => { const ed = window.__vt.ed(); let code=''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') code = n.textContent }); return JSON.stringify({ code, md: ed.storage.markdown.getMarkdown().slice(0, 60) }) })()`)
  console.log('after typing + enter:', r)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
