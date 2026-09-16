// 回归：代码块 typing 经「源码模式往返」（CM 曾被 display:none）后仍正常
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function key(type, key, code, vk) { await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }) }
async function clickMode(text) {
  const p = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('.mode-seg-btn')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) throw new Error('NO-BTN ' + text)
  const g = JSON.parse(p)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await sleep(400)
}
async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(600)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 150 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  const md = ['# 标题', '正文', '', '```js', 'const a = 1', '```', '', '## 尾部'].join('\n')
  await ev(`(() => { const f = window.__vt.files(); f.setContent(${JSON.stringify(md)}); const ed = window.__vt.ed(); ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(900)
  // 源码模式往返
  await clickMode('源码')
  await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return 'ok' })()`)
  await sleep(150)
  await send('Input.insertText', { text: '\n### 源码加了一行' })
  await sleep(300)
  await clickMode('实时渲染')
  await sleep(500)
  // 回渲染后：代码块可见且可聚焦输入
  let cmFocus = false
  for (let a = 0; a < 5 && !cmFocus; a++) {
    const p = JSON.parse(await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + Math.min(60, r.width / 2), y: r.top + Math.max(10, r.height / 2), w: r.width, h: r.height }) })()`))
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(250)
    cmFocus = await ev(`(() => { const el = document.querySelector('.cm-content'); return el ? document.activeElement === el : false })()`)
  }
  await send('Input.insertText', { text: 'zz' })
  await sleep(400)
  const code = await ev(`(() => { const ed = window.__vt.ed(); let c = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent }); return c })()`)
  console.log((cmFocus ? 'PASS' : 'FAIL') + ' 源码往返后 CM 可聚焦', '')
  console.log((code.includes('zz') ? 'PASS' : 'FAIL') + ' 源码往返后代码块可输入', JSON.stringify(code))
  console.log('heading 同步:', (await ev(`(() => { const ed = window.__vt.ed(); let ok = false; ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.includes('源码加了一行')) ok = true }); return ok })()`) ? 'PASS' : 'FAIL'))
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
