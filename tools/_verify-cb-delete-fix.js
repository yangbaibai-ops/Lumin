// 验证修复（直接路径）：清空 codeBlock 内容 → 点击聚焦 CM → 按 Backspace 删除整块。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = (sym ? prov[sym] : null)
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(500)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(400)
  const md = '段落A\n\n```js\nline one\nline two\n```\n\n段落B'
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(600)

  // 用 PM 事务清空 codeBlock（模拟删光内容后剩下的空块）
  await ev(`(() => {
    const ed = window.__vt.ed(); let pos = -1
    ed.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'codeBlock') pos = p })
    const node = ed.state.doc.nodeAt(pos)
    ed.commands.command(({ tr }) => { tr.delete(pos + 1, pos + node.nodeSize - 1); return true })
    return pos
  })()`)
  await sleep(400)

  // 点击 CM 空内容区聚焦
  const cm = await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 8 } })()`)
  if (!cm) { console.log('FAIL no cm-content'); process.exit(2) }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cm.x, y: cm.y, clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cm.x, y: cm.y, clickCount: 1, buttons: 0 })
  await sleep(300)
  const focusState = await ev(`(() => { const ae = document.activeElement; return JSON.stringify({ inCm: !!(ae && ae.closest && ae.closest('.cm-editor')) }) })()`)
  console.log('cm focused:', focusState)

  // 按 Backspace
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(500)
  const final = await ev(`(() => { const ed = window.__vt.ed(); let c = 0; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c++ }); return JSON.stringify({ codeBlocks: c, md: ed.storage.markdown.getMarkdown().slice(0, 40) }) })()`)
  console.log('after Backspace:', final)

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
