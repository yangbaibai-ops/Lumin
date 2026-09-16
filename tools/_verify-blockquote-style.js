// 验收：引用（blockquote）渲染样式
// 1) 经典灰色前置色条：3px、取 --edge-strong、无底色、无圆角；
// 2) 实时渲染界面里光标进入引用（编辑态）不再出现「>」前缀；
// 3) 文档内容本身不受影响（markdown 仍是 "> ..."），工具栏引用开关照常可用。
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const QUOTE = `(() => {
  const bq = document.querySelector('.ProseMirror blockquote')
  if (!bq) return JSON.stringify({ present: false })
  const cs = getComputedStyle(bq)
  const p = bq.querySelector('p')
  const before = p ? getComputedStyle(p, '::before') : null
  return JSON.stringify({
    present: true,
    borderLeftWidth: cs.borderLeftWidth,
    borderLeftColor: cs.borderLeftColor,
    borderLeftStyle: cs.borderLeftStyle,
    background: cs.backgroundColor,
    radius: cs.borderTopLeftRadius,
    color: cs.color,
    revealClass: bq.className,
    beforeContent: before ? before.content : null,
    text: bq.textContent.trim(),
    hasCaret: !!document.querySelector('.ProseMirror-focused')
  })
})()`
const MD = ['# 引用样式验收', '', '> 这是一段引用文本', '> 第二行引用', '', '普通段落'].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(400)

  const before = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (before.dirty) { console.log('SKIP: 当前文档有未保存修改'); ws.close(); return }

  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`)
  await sleep(700)

  // 光标不在引用内
  await ev(`(() => { const ed = window.__vt.ed(); ed.commands.setTextSelection(1); return 'ok' })()`)
  await sleep(300)
  const idle = JSON.parse(await ev(QUOTE))
  console.log('IDLE   ' + JSON.stringify(idle))

  // 光标点进引用（编辑态）
  const pt = JSON.parse(await ev(`(() => { const bq = document.querySelector('.ProseMirror blockquote'); const r = bq.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }) })()`))
  await clickPoint(pt.x, pt.y)
  await sleep(500)
  const editing = JSON.parse(await ev(QUOTE))
  console.log('EDITING ' + JSON.stringify(editing))

  const token = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--edge-strong').trim()`)
  const rgb = await ev(`(() => { const el = document.createElement('div'); el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--edge-strong').trim(); document.body.appendChild(el); const v = getComputedStyle(el).color; el.remove(); return v })()`)
  console.log('TOKEN --edge-strong = ' + token + ' → ' + rgb)

  c('quote-present', editing.present === true)
  c('gray-bar-3px', editing.borderLeftWidth === '3px' && editing.borderLeftStyle === 'solid', JSON.stringify({ w: editing.borderLeftWidth, s: editing.borderLeftStyle }))
  c('bar-uses-edge-strong', editing.borderLeftColor === rgb, `bar=${editing.borderLeftColor} token=${rgb}`)
  c('bar-is-gray-not-accent', !/99,\s*102,\s*241/.test(editing.borderLeftColor), editing.borderLeftColor)
  c('no-background', editing.background === 'rgba(0, 0, 0, 0)' || editing.background === 'transparent', editing.background)
  c('no-radius', editing.radius === '0px', editing.radius)
  c('no-gt-marker-idle', idle.beforeContent === 'none' && !String(idle.revealClass).includes('md-reveal'), JSON.stringify({ content: idle.beforeContent, cls: idle.revealClass }))
  c('no-gt-marker-editing', editing.beforeContent === 'none' && !String(editing.revealClass).includes('md-reveal'), JSON.stringify({ content: editing.beforeContent, cls: editing.revealClass }))
  c('caret-in-quote', editing.text.includes('这是一段引用文本'), editing.text)

  // 文档内容仍是 markdown（只是不渲染 > 标记）
  const content = await ev(`window.__vt.files().current.content`)
  c('markdown-intact', content.includes('> 这是一段引用文本'), JSON.stringify(content.split('\n').slice(0, 4)))

  // 工具栏引用开关仍可用（在普通段落上切换）
  const toggled = await ev(`(() => {
    const ed = window.__vt.ed()
    let last = -1
    ed.state.doc.descendants((n, pos) => { if (n.type.name === 'paragraph' && n.textContent.includes('普通段落')) last = pos })
    ed.commands.setTextSelection(last + 3)
    ed.chain().focus().toggleBlockquote().run()
    let count = 0
    ed.state.doc.descendants((n) => { if (n.type.name === 'blockquote') count++ })
    return count
  })()`)
  c('toggle-still-works', toggled === 2, 'blockquotes=' + toggled)

  // 复原
  await ev(`(async () => { const f = window.__vt.files(); await f.close(); ${before.path ? `await f.openPath(${JSON.stringify(before.path)})` : ''} await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0)); return 'ok' })()`)
  await sleep(400)
  const restored = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  c('state-restored', restored.path === before.path && restored.dirty === false, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
