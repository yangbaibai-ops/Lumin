// 观察：Backspace 进入代码块后的后续输入行为
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function setup(md) { await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`); await sleep(500) }
async function caretInParaAfterCode() {
  return ev(`(() => {
    const ed = window.__vt.ed()
    let cb = -1
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') cb = p })
    const node = ed.state.doc.nodeAt(cb)
    const after = cb + node.nodeSize
    let next = null
    ed.state.doc.descendants((n, p) => { if (p === after && n.type.isTextblock) next = { type: n.type.name, start: p + 1, len: n.content.size } })
    ed.chain().focus().setTextSelection(next.start).run()
    return JSON.stringify({ cb, next })
  })()`)
}
async function pressKey(key, code, vk, text) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
  if (text) await send('Input.dispatchKeyEvent', { type: 'char', key: text, text, unmodifiedText: text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  await sleep(300)
}
async function state(tag) {
  return ev(`(() => {
    const ed = window.__vt.ed(); const s = ed.state.selection; const $p = ed.state.doc.resolve(s.from)
    const blocks = []
    ed.state.doc.descendants((n, p) => { if (n.type.isTextblock) blocks.push(n.type.name + '@' + p + '[' + (n.textContent||'') + ']') })
    const ae = document.activeElement
    return JSON.stringify({ tag: ${JSON.stringify(tag)}, from: s.from, selType: $p.parent.type.name,
      ae: ae ? (ae.className || ae.tagName) : null, inCm: !!(ae && ae.closest && ae.closest('.cm-editor')), blocks })
  })()`)
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
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(400)

  // S1: 空段落 → Backspace → 输入 "A"
  await setup('```js\nconst x = 1\n```\n\n')
  await caretInParaAfterCode()
  console.log('S1 state:', await state('before'))
  await pressKey('Backspace', 'Backspace', 8)
  console.log('S1 after BS:', await state('after-bs'))
  await pressKey('a', 'KeyA', 65, 'a')
  console.log('S1 after type:', await state('after-type-a'))

  // S2: 有内容段落 → Backspace → 输入 "A"
  await setup('```js\nconst x = 1\n```\n\n后段落XYZ')
  await caretInParaAfterCode()
  await pressKey('Backspace', 'Backspace', 8)
  console.log('S2 after BS:', await state('after-bs'))
  await pressKey('a', 'KeyA', 65, 'a')
  console.log('S2 after type:', await state('after-type-a'))

  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
