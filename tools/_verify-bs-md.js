// 验证最终 markdown 序列化（files store content，经 onUpdate 防抖落 store）
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function setup(md) { await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`); await sleep(600) }
async function focusEditor() { await ev(`(() => { const ed = window.__vt.ed(); ed.commands.focus(); const pm = document.querySelector('.tiptap, .ProseMirror'); if (pm) { pm.focus(); ed.commands.focus() } return 'ok' })()`); await sleep(120) }
async function caretAtParaStartAfterCode() {
  return ev(`(() => {
    const ed = window.__vt.ed()
    let cb = -1
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') cb = p })
    const node = ed.state.doc.nodeAt(cb)
    const after = cb + node.nodeSize
    let next = null
    ed.state.doc.descendants((n, p) => { if (p === after && n.type.isTextblock) next = { start: p + 1 } })
    if (!next) return 'NO-NEXT'
    ed.chain().focus().setTextSelection(next.start).run()
    return 'ok'
  })()`)
}
async function pressBackspace() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(400)
}
async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
  }
  await sleep(500)
}
async function md() { return ev(`(() => window.__vt.pinia._s.get('files').current?.content ?? null)()`) }

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
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(800)
  await ev(`(async () => { const files = window.__vt.pinia._s.get('files'); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await waitEditor()

  // S1: 空占位段 → BS 进代码块 → 输入 YY（应追加到代码）
  await setup('前文\n\n```js\nconst x = 1\n```\n\n')
  await caretAtParaStartAfterCode(); await focusEditor(); await pressBackspace(); await typeText('YY')
  console.log('S1 md:', JSON.stringify(await md()))

  // S2: 正文段 → BS（不吞文）→ 输入 ZZ（代码追加，正文保留）
  await setup('前文\n\n```js\nconst x = 1\n```\n\n后段落XYZ')
  await caretAtParaStartAfterCode(); await focusEditor(); await pressBackspace(); await typeText('ZZ')
  console.log('S2 md:', JSON.stringify(await md()))

  ws.close(); process.exit(0)
}
async function waitEditor(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ok = await ev(`(() => { const ed = window.__vt.ed(); return ed && ed.view && ed.view.dom ? 'yes' : 'no' })()`)
    if (ok === 'yes') return
    await sleep(300)
  }
  throw new Error('editor not ready')
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
