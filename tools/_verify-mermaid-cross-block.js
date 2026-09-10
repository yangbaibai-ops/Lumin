// 验收：
// A) mermaid 源码态下点击「别的代码块」（CM 块 / 另一个 mermaid 块 / 正文段落）都应
//    立即回到图表态，并提交改动 —— 回归「只有点正文段落才生效」的缺陷
// B) 回归被 blur 拦截保护的行为：在 CM 里拖选后输入，焦点不被 PM 抢回、选区不被重置
const CDP = 'http://127.0.0.1:9222/json'
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function pointInBlock(i, selector) {
  const s = await ev(`(() => {
    const w = document.querySelectorAll('.code-block-wrapper')[${i}]
    const el = w && w.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  })()`)
  return s ? JSON.parse(s) : null
}
const BLOCKS = `(() => {
  const blocks = Array.from(document.querySelectorAll('.code-block-wrapper')).map((w) => ({
    lang: w.querySelector('.code-block-lang-label')?.textContent ?? null,
    render: !!w.querySelector('.mermaid-render'),
    svg: !!w.querySelector('.mermaid-render svg'),
    textarea: !!w.querySelector('.mermaid-source-input'),
    cm: !!w.querySelector('.cm-editor')
  }))
  return JSON.stringify({ blocks, active: String(document.activeElement?.className ?? '').slice(0, 28) })
})()`
const NODE_TEXTS = `(() => { const ed = window.__vt.ed(); const out = []; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') out.push({ lang: n.attrs.language, text: n.textContent }) }); return JSON.stringify(out) })()`

const MD = [
  '# 跨块验收',
  '',
  '```mermaid',
  'graph TD',
  '  A1 --> A2',
  '```',
  '',
  '```js',
  'const b = 1',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  C1 --> C2',
  '```',
  '',
  '尾段'
].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable'); await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym]
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(`(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`)
  await sleep(400)

  const openedBefore = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (openedBefore.dirty) { console.log('SKIP: 当前文档有未保存修改'); ws.close(); return }

  await ev(`(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`)
  await ev(`(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`)
  await ev(`(async () => { for (let i = 0; i < 300 && document.querySelectorAll('.mermaid-render svg').length < 2; i++) await new Promise((r) => setTimeout(r, 25)); return 'svg' })()`)
  await sleep(600)

  /** 让第 0 块进入源码态并输入一段带标记的源码 */
  async function enterSource(marker) {
    const p = await pointInBlock(0, '.mermaid-render')
    c(`block0-diagram-before-${marker}`, !!p)
    await clickPoint(p.x, p.y)
    await sleep(450)
    const st = JSON.parse(await ev(BLOCKS))
    c(`block0-source-focused-${marker}`, st.blocks[0].textarea === true && st.active.includes('mermaid-source-input'), JSON.stringify(st.blocks[0]))
    await send('Input.insertText', { text: `\n  %% ${marker}` })
    await sleep(300)
  }
  const block0Back = async (marker) => {
    const st = JSON.parse(await ev(BLOCKS))
    c(`block0-back-to-diagram-${marker}`, st.blocks[0].render === true && st.blocks[0].textarea === false, JSON.stringify(st.blocks[0]))
    const texts = JSON.parse(await ev(NODE_TEXTS))
    c(`edits-committed-${marker}`, (texts[0]?.text || '').includes(`%% ${marker}`), JSON.stringify(texts[0]))
  }

  // ── A1) 源码态 → 点击「另一个代码块（CM 块）」── 用户报的缺陷
  await enterSource('K1')
  const cmPt = await pointInBlock(1, '.cm-content')
  await clickPoint(cmPt.x + 20, cmPt.y)
  await sleep(800)
  const afterCm = JSON.parse(await ev(BLOCKS))
  console.log('AFTER-CLICK-CM  ' + JSON.stringify(afterCm))
  await block0Back('K1')
  c('cm-block-got-focus', afterCm.active.includes('cm-content'), afterCm.active)

  // ── A2) 源码态 → 点击「另一个 mermaid 块」
  await enterSource('K2')
  const mmdPt = await pointInBlock(2, '.mermaid-render')
  await clickPoint(mmdPt.x, mmdPt.y)
  await sleep(700)
  const afterMmd = JSON.parse(await ev(BLOCKS))
  console.log('AFTER-CLICK-MMD ' + JSON.stringify(afterMmd))
  await block0Back('K2')
  c('second-mermaid-entered-source', afterMmd.blocks[2].textarea === true, JSON.stringify(afterMmd.blocks[2]))

  // ── A3) 源码态 → 点击正文段落
  const paraPt = JSON.parse(await ev(`(() => { const ps = Array.from(document.querySelectorAll('.ProseMirror > p')); const el = ps[ps.length - 1]; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }) })()`))
  await enterSource('K3')
  await clickPoint(paraPt.x, paraPt.y)
  await sleep(700)
  const afterPara = JSON.parse(await ev(BLOCKS))
  console.log('AFTER-CLICK-PARA ' + JSON.stringify(afterPara))
  await block0Back('K3')

  // ── B) CM 拖选后输入：焦点不被抢回、选区不被重置（blur 拦截保护的行为）──
  const cmBox = await pointInBlock(1, '.cm-content')
  await clickPoint(cmBox.left + 50, cmBox.top + 10)
  await sleep(300)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cmBox.left + 40, y: cmBox.top + 10, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 4; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cmBox.left + 40 + i * 12, y: cmBox.top + 10, button: 'left', buttons: 1 })
    await sleep(60)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cmBox.left + 88, y: cmBox.top + 10, button: 'left', clickCount: 1 })
  await sleep(400)
  const dragState = JSON.parse(await ev(`(() => {
    const ae = document.activeElement
    return JSON.stringify({
      inCm: !!(ae && ae.closest && ae.closest('.cm-editor')),
      selLayerRects: document.querySelectorAll('.cm-selectionLayer > .cm-selectionBackground').length
    })
  })()`))
  console.log('DRAG-SELECT     ' + JSON.stringify(dragState))
  // 注：drawSelection() 用自绘层渲染选区，window.getSelection() 恒为空，故只看焦点是否被留在 CM
  c('drag-focus-stays-in-cm', dragState.inCm === true, JSON.stringify(dragState))
  const cmTextBefore = await ev(`document.querySelector('.cm-content').textContent`)
  await send('Input.insertText', { text: 'X' })
  await sleep(500)
  const cmTextAfter = await ev(`document.querySelector('.cm-content').textContent`)
  const focusStill = await ev(`(() => { const ae = document.activeElement; return !!(ae && ae.closest && ae.closest('.cm-editor')) })()`)
  c('typed-replaces-selection', cmTextAfter !== cmTextBefore && cmTextAfter.includes('X'), JSON.stringify({ before: cmTextBefore, after: cmTextAfter }))
  c('focus-still-in-cm-after-typing', focusStill === true)

  // 复原
  await ev(`(async () => {
    const f = window.__vt.files()
    await f.close()
    ${openedBefore.path ? `await f.openPath(${JSON.stringify(openedBefore.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    return 'ok'
  })()`)
  await sleep(400)
  const restored = JSON.parse(await ev(`(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty }) })()`))
  c('state-restored', restored.path === openedBefore.path, JSON.stringify(restored))

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  ws.close()
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
