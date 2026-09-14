// 验证修复：代码块后段落行首 Backspace → 光标进入代码块末尾并聚焦 CM
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function waitEditor(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ok = await ev(`(() => { const ed = window.__vt.ed(); return ed && ed.view && ed.view.dom ? 'yes' : 'no' })()`)
    if (ok === 'yes') return
    await sleep(300)
  }
  throw new Error('editor not ready')
}
async function setup(md) { await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`); await sleep(600) }
async function focusEditor() {
  await ev(`(() => {
    const ed = window.__vt.ed()
    ed.commands.focus()
    const pm = document.querySelector('.tiptap, .ProseMirror')
    if (pm) { pm.focus(); ed.commands.focus() }
    return 'ok'
  })()`)
  await sleep(120)
}
async function caretAtParaStartAfterCode() {
  return ev(`(() => {
    const ed = window.__vt.ed()
    let cb = -1
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') cb = p })
    const node = ed.state.doc.nodeAt(cb)
    const after = cb + node.nodeSize
    let next = null
    ed.state.doc.descendants((n, p) => { if (p === after && n.type.isTextblock) next = { type: n.type.name, start: p + 1, len: n.content.size } })
    if (!next) return 'NO-NEXT'
    ed.chain().focus().setTextSelection(next.start).run()
    return JSON.stringify({ cb, next })
  })()`)
}
async function pressBackspace() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(450)
}
async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
  }
  await sleep(400)
}
async function report(tag) {
  return ev(`(() => {
    const ed = window.__vt.ed(); const s = ed.state.selection; const $p = ed.state.doc.resolve(s.from)
    const types = []
    ed.state.doc.descendants((n, p) => { if (n.type.isTextblock) types.push(n.type.name + '@' + p + '[' + (n.textContent||'') + ']') })
    const ae = document.activeElement
    let cmPos = null, cmLen = null
    const cm = document.querySelector('.cm-editor .cm-content')
    const edStore = window.__vt.pinia._s.get('editor')
    return JSON.stringify({ tag: ${JSON.stringify(tag)}, from: s.from, selType: $p.parent.type.name,
      focused: ae ? (ae.className || ae.tagName) : null, inCm: !!(ae && ae.closest && ae.closest('.cm-editor')),
      blocks: types, md: edStore.markdown ?? null })
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
    const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  // 确保处于编辑器路由（#/editor），欢迎页不挂载 Tiptap
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return location.hash })()`)
  await sleep(800)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await waitEditor()
  await sleep(300)

  // 场景 1：空占位段落
  await setup('前文\n\n```js\nconst x = 1\n```\n\n')
  console.log('S1 setup:', await caretAtParaStartAfterCode())
  await focusEditor()
  await pressBackspace()
  console.log('S1 after BS:', await report('S1-empty-after-bs'))
  await typeText('YY')
  console.log('S1 after type YY:', await report('S1-after-type'))

  // 场景 2：有正文段落（不得并入代码）
  await setup('前文\n\n```js\nconst x = 1\n```\n\n后段落XYZ')
  console.log('S2 setup:', await caretAtParaStartAfterCode())
  await focusEditor()
  await pressBackspace()
  console.log('S2 after BS:', await report('S2-text-after-bs'))
  await typeText('ZZ')
  console.log('S2 after type ZZ:', await report('S2-after-type'))

  // 场景 3：多代码块，光标在第 2 个代码块后的段落
  await setup('```py\na=1\n```\n\n中间段\n\n```js\nconst b=2\n```\n\n尾段')
  console.log('S3 setup:', await caretAtParaStartAfterCode())
  await focusEditor()
  await pressBackspace()
  console.log('S3 after BS:', await report('S3-multi-after-bs'))

  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
