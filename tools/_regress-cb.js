// 回归：代码块核心修复（空块退格删除 / 代码块后段落行首退格进入块尾 / 输入回车）
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
  await sleep(350)
}
async function prepare(md) {
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 150 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { const f = window.__vt.files(); f.setContent(${JSON.stringify(md)}); const ed = window.__vt.ed(); ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(900)
}
async function clickCmAt(offsetRatio) {
  const p = JSON.parse(await ev(`(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + Math.max(10, r.height / 2)) }) })()`))
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(200)
}
async function codeText() { return ev(`(() => { const ed = window.__vt.ed(); let c = ''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c += '[' + n.textContent + ']' }); return c })()`) }
async function blocksCount() { return ev(`(() => { const ed = window.__vt.ed(); let n = 0; ed.state.doc.descendants((x) => { if (x.type.name === 'codeBlock') n++ }); return n })()`) }
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
  await sleep(500)
  const results = []
  const check = (n, c, x) => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? ' | ' + x : ''))

  // 测试 A：代码块内输入+Enter
  await prepare(['正文', '', '```js', 'const a = 1', '```'].join('\n'))
  await clickCmAt()
  await send('Input.insertText', { text: 'hello' })
  await sleep(150)
  await key('keyDown', 'Enter', 'Enter', 13); await key('keyUp', 'Enter', 'Enter', 13)
  await sleep(150)
  await send('Input.insertText', { text: 'world' })
  await sleep(400)
  const codeA = await codeText()
  check('代码块输入+回车', codeA.includes('hello') && codeA.includes('world'), codeA)

  // 测试 B：空代码块按退格 → 整块删除
  await prepare(['正文', '', '```', '', '```', '', '尾部'].join('\n'))
  await clickCmAt()
  await key('keyDown', 'Backspace', 'Backspace', 8); await key('keyUp', 'Backspace', 'Backspace', 8)
  await sleep(400)
  const nB = await blocksCount()
  check('空代码块退格删除', nB === 0, `blocks=${nB}`)

  // 测试 C：代码块后段落行首退格 → 光标进入代码块末尾（非空代码块）
  await prepare(['正文', '', '```js', 'code line', '```', '', ''].join('\n'))
  // 点击代码块后第一段开头：用 PM 命令把光标放到 blockquote 后段落起始 = 文档后部空段落
  await ev(`(() => { const ed = window.__vt.ed(); const size = ed.state.doc.content.size; ed.commands.setTextSelection(size - 1); ed.commands.focus(); return 'ok' })()`)
  await sleep(150)
  await key('keyDown', 'Backspace', 'Backspace', 8); await key('keyUp', 'Backspace', 'Backspace', 8)
  await sleep(300)
  const infoC = await ev(`(() => { const ed = window.__vt.ed(); const sel = ed.state.selection; return JSON.stringify({ from: sel.from, code: (() => { let c=''; ed.state.doc.descendants((n)=>{ if(n.type.name==='codeBlock') c=n.textContent }); return c })() }) })()`)
  const cC = JSON.parse(infoC)
  // 期望：空段落被吞掉，光标落在代码块内末尾（文本 'code line' 之后）
  check('代码块后段落退格→入块尾', cC.code.endsWith('code line'), `from=${cC.from} code=${JSON.stringify(cC.code)}`)

  console.log(results.join('\n'))
  ws.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 2 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
