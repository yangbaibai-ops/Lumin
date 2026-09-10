// 回归：切换文件（:key remount）与 source 启动场景
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
  await sleep(450)
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
  const results = []
  const check = (n, c, x) => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? ' | ' + x : ''))
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 150 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  const mdA = ['# 文档A', 'AAA 内容。', '', '```js', 'aaa', '```'].join('\n')
  const mdB = ['# 文档B', 'BBB 内容。', '', '```py', 'bbb', '```'].join('\n')
  // 模拟打开文件 A（path 固定，触发 :key remount）
  await ev(`(async () => {
    const f = window.__vt.files()
    f.current = { path: '/tmp/a.md', name: 'a.md', content: ${JSON.stringify(mdA)}, mtimeMs: 1, savedContent: ${JSON.stringify(mdA)} }
    return 'ok'
  })()`)
  await sleep(600)
  const edA = await ev(`(() => { const ed = window.__vt.ed(); let t = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'heading') t += n.textContent }); return t })()`)
  check('打开文档A 编辑器内容', edA === '文档A', edA)
  // 切到源码模式修改，再切另一个文件 B
  await clickMode('源码')
  const taHas = await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.includes('AAA') : false })()`)
  check('源码模式显示A', taHas === true, '')
  await ev(`(async () => {
    const f = window.__vt.files()
    f.current = { path: '/tmp/b.md', name: 'b.md', content: ${JSON.stringify(mdB)}, mtimeMs: 2, savedContent: ${JSON.stringify(mdB)} }
    return 'ok'
  })()`)
  await sleep(700)
  const taB = await ev(`(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value.includes('BBB') : false })()`)
  check('源码模式切到文档B', taB === true, '')
  // 在源码模式直接切回渲染：编辑器应为 B 且按 :key 重建
  await clickMode('实时渲染')
  const edB = await ev(`(() => { const ed = window.__vt.ed(); let t = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'heading') t += n.textContent }); return t })()`)
  check('切回渲染显示文档B', edB === '文档B', edB)
  // 源码模式下 instance 应为 null 但切回渲染后恢复
  const instActive = await ev(`(() => window.__vt.ed() !== null)()`)
  check('渲染模式 instance 恢复', instActive === true, '')
  console.log(results.join('\n'))
  ws.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 2 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
