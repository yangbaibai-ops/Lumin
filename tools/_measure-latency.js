const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
async function clickModeBtn(text) {
  const p = await ev(`(() => {
    const els = Array.from(document.querySelectorAll('.mode-seg-btn'))
    const el = els.find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!p) throw new Error('NO-BTN ' + text)
  const g = JSON.parse(p)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 })
}
async function measure(label, fromBtn, toBtn) {
  // 确保从 fromBtn 模式开始
  await clickModeBtn(fromBtn)
  await sleep(800)
  // 长文档 + 中段位置
  const parts = []
  for (let i = 1; i <= 40; i++) parts.push(`## 章节 ${i}`, `第 ${i} 段正文内容用于验证切换位置，内容要足够长以产生滚动条。`)
  const md = parts.join('\n')
  await ev(`(() => { const ed = window.__vt.ed(); if (ed) ed.commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(500)
  await ev(`(() => {
    const ed = window.__vt.ed()
    const sc = ed && ed.view && ed.view.dom ? ed.view.dom.closest('.editor-scroll') : null
    if (ed) ed.commands.setTextSelection(Math.floor(ed.state.doc.content.size * 0.5))
    if (sc) sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5
    return 'ok'
  })()`)
  await sleep(200)
  console.log('  [start mode]', await ev(`(() => window.__vt.ui().editorMode)()`))

  // 页面内轮询
  await ev(`(() => {
    window.__log = []
    window.__t0 = performance.now()
    if (window.__timer) clearInterval(window.__timer)
    window.__timer = setInterval(() => {
      const el = document.querySelector('.view-restoring')
      const vis = el ? getComputedStyle(el).visibility : 'none'
      const ed = window.__vt.ed()
      const sc = ed && ed.view && ed.view.dom ? ed.view.dom.closest('.editor-scroll') : null
      const ta = document.querySelector('.source-editor' + (window.__vt.ui().editorMode === 'split' ? '--split' : ''))
      window.__log.push({
        t: Math.round(performance.now() - window.__t0),
        mode: window.__vt.ui().editorMode, vis,
        st: sc ? Math.round(sc.scrollTop) : -9,
        max: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : -9,
        taSt: ta ? Math.round(ta.scrollTop) : -9
      })
    }, 5)
    return 'polling'
  })()`)
  await sleep(60)
  await clickModeBtn(toBtn)
  await sleep(1200)
  const raw = await ev(`(() => { clearInterval(window.__timer); return JSON.stringify(window.__log) })()`)
  const log = JSON.parse(raw)
  // 采样去重（同 mode+vis 连续帧只保留首尾）
  const compact = []
  for (const r of log) {
    const last = compact[compact.length - 1]
    if (!last || last.mode !== r.mode || last.vis !== r.vis) compact.push(r)
  }
  console.log(label, 'compact frames:', compact.length)
  compact.forEach((r) => console.log(`   t+${r.t} mode=${r.mode} vis=${r.vis} st=${r.st} max=${r.max} taSt=${r.taSt}`))
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
  await sleep(900)
  await ev(`(async () => { const files = window.__vt.files(); if (!files.current) await files.openUntitled(); return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(600)
  await measure('wysiwyg→split', '实时渲染', '分屏')
  await measure('split→source', '分屏', '源码')
  await measure('source→wysiwyg', '源码', '实时渲染')
  ws.close(); process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
