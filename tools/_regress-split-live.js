// 回归：分屏模式 live 同步 + 切换文件（编辑器按 :key 重建）
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
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
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
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
  const results = []
  const check = (n, c, x) => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? ' | ' + x : ''))
  // 进分屏，右侧输入一行 → 左侧编辑器出现该标题
  await clickMode('分屏')
  const ta = await ev(`(() => { const t = document.querySelector('textarea.source-editor'); if (!t) return null; t.focus(); const len = t.value.length; t.setSelectionRange(len, len); return 'ok' })()`)
  await send('Input.insertText', { text: '\n## 分屏右侧新增' })
  await sleep(700) // scheduleSplitSync 200ms + 处理
  const leftHas = await ev(`(() => { const ed = window.__vt.ed(); let ok = false; ed.state.doc.descendants((n) => { if (n.type.name === 'heading' && n.textContent.includes('分屏右侧新增')) ok = true }); return ok })()`)
  check('分屏右侧输入→左编辑器同步', leftHas === true, '')
  // 左侧编辑器输入 → 右侧 textarea 更新
  const p = JSON.parse(await ev(`(() => { const el = document.querySelector('.cm-content') || document.querySelector('.md-preview'); if (!el) return JSON.stringify({ none: true }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + Math.max(20, r.height / 2)) }) })()`))
  if (!p.none) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(150)
  }
  await ev(`(() => { const ed = window.__vt.ed(); ed.commands.focus(); ed.commands.setTextSelection(1); ed.commands.insertContent('分屏左侧'); return 'ok' })()`)
  await sleep(800)
  const rightHas = await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.includes('分屏左侧') : false })()`)
  check('左侧编辑器输入→右 textarea 同步', rightHas === true, '')
  console.log(results.join('\n'))
  ws.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 2 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
