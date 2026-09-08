// 插桩复现：点击标题→代码块内拖拽多选，记录 PM 事务/焦点/选区变化，定位抢焦点来源。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  return r.result?.result?.value
}
async function mouse(type, x, y, opts = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: opts.button ?? 'left', buttons: opts.buttons ?? (type === 'mouseup' ? 0 : 1), clickCount: opts.clickCount ?? 1 })
}

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('NO_PAGE_TARGET')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await send('Page.enable')
  await send('Page.bringToFront')

  let visible = false
  for (let i = 0; i < 12; i++) { if ((await ev('document.visibilityState')) === 'visible') { visible = true; break } await sleep(300) }
  if (!visible) { console.log('FAIL window-visible'); process.exit(2) }
  console.log('PASS window-visible')

  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  if (boot !== 'OK') { console.log('FAIL pinia-bridge', boot); process.exit(2) }

  await ev(`(() => { location.hash = '#/editor'; window.__vt.ui().editorMode = 'wysiwyg'; window.__vt.settings().syncScroll = false; return 'ok' })()`)
  await sleep(800)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(500)
  const md = `# 标题

\`\`\`js
const a = 1
const b = 2
\`\`\``
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(500)

  // 插桩
  await ev(`(() => {
    const ed = window.__vt.ed()
    window.__trace = []
    const push = (k, d) => window.__trace.push({ t: Date.now(), k, ...d })
    const origDispatch = ed.view.dispatch.bind(ed.view)
    ed.view.dispatch = function (tr) {
      const st = new Error().stack.split('\\n').slice(2, 5).map((s) => s.replace(/.*at /, '').trim()).join(' <- ')
      push('pm-dispatch', { selSet: !!tr.selectionSet, from: tr.selection.from, to: tr.selection.to, stack: st })
      return origDispatch(tr)
    }
    const origFocus = ed.view.focus.bind(ed.view)
    ed.view.focus = function () { push('pm-focus', { ae: document.activeElement && document.activeElement.className }); return origFocus() }
    const obs = ed.view.domObserver
    const origStop = obs.stop.bind(obs)
    const origStart = obs.start.bind(obs)
    obs.stop = function () { push('obs-stop'); return origStop() }
    obs.start = function () { push('obs-start'); return origStart() }
    document.addEventListener('selectionchange', () => {
      const ae = document.activeElement
      push('selectionchange', { inCm: !!(ae && ae.closest && ae.closest('.cm-editor')), hasFocus: ed.view.hasFocus() })
    })
    return 'ok'
  })()`)
  await sleep(200)

  const rects = await ev(`(() => {
    const h = document.querySelector('.ProseMirror h1')
    const cm = document.querySelector('.ProseMirror .cm-editor .cm-content')
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.left, top: b.top, width: b.width, height: b.height } }
    return { h: h ? r(h) : null, cm: cm ? r(cm) : null }
  })()`)
  if (!rects.h || !rects.cm) { console.log('FAIL rects', JSON.stringify(rects)); process.exit(2) }

  // 点击标题
  await mouse('mousePressed', rects.h.x, rects.h.y, { clickCount: 1 })
  await mouse('mouseReleased', rects.h.x, rects.h.y, { clickCount: 1 })
  await sleep(300)

  // 代码块内拖拽多选
  const y = rects.cm.y
  const x0 = rects.cm.left + 4
  const x1 = rects.cm.left + Math.min(80, rects.cm.width - 8)
  await mouse('mousePressed', x0, y, { clickCount: 1 })
  await sleep(20)
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y, { button: 'left', buttons: 1 }); await sleep(20) }
  await mouse('mouseReleased', x1, y, { clickCount: 1 })

  // 立即（<60ms）读选区，再等待后读
  const instant = await ev(`(() => {
    const sel = document.getSelection()
    const cmContent = document.querySelector('.ProseMirror .cm-editor .cm-content')
    return { text: sel ? sel.toString() : '', collapsed: sel ? sel.isCollapsed : true, inCm: !!(sel && cmContent && (cmContent.contains(sel.anchorNode) || cmContent.contains(sel.focusNode))) }
  })()`)
  await sleep(400)
  const finalState = await ev(`(() => {
    const ae = document.activeElement
    const sel = document.getSelection()
    const cmContent = document.querySelector('.ProseMirror .cm-editor .cm-content')
    const h = document.querySelector('.ProseMirror h1')
    const ed = window.__vt.ed()
    return {
      activeInCm: !!(ae && ae.closest && ae.closest('.cm-editor')),
      selText: sel ? sel.toString() : '',
      selCollapsed: sel ? sel.isCollapsed : true,
      selInCm: !!(sel && cmContent && (cmContent.contains(sel.anchorNode) || cmContent.contains(sel.focusNode))),
      badge: h ? getComputedStyle(h, '::before').display : 'no-h1',
      pmFrom: ed.state.selection.from,
      pmDispatchCount: window.__trace.filter((x) => x.k === 'pm-dispatch').length,
      pmFocusCount: window.__trace.filter((x) => x.k === 'pm-focus').length,
      selChangeCount: window.__trace.filter((x) => x.k === 'selectionchange').length
    }
  })()`)
  const trace = await ev(`window.__trace`)
  console.log('instant', JSON.stringify(instant))
  console.log('finalState', JSON.stringify(finalState))
  console.log('trace', JSON.stringify(trace))
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
