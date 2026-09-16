// 复现：点击标题显示 H1 徽章后，再在代码块内拖拽多选，焦点是否被抢回标题。
// 运行：powershell -File tools/fg-run.ps1 tools/_repro-heading-cm.js
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
  if (r.result && r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  }
  return r.result?.result?.value
}

async function mouse(type, x, y, opts = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: opts.button ?? 'left',
    buttons: opts.buttons ?? (type === 'mouseup' ? 0 : 1),
    clickCount: opts.clickCount ?? 1
  })
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

  // 前台可见
  let visible = false
  for (let i = 0; i < 12; i++) {
    if ((await ev('document.visibilityState')) === 'visible') { visible = true; break }
    await sleep(300)
  }
  if (!visible) { console.log('FAIL window-visible'); process.exit(2) }
  console.log('PASS window-visible')

  // 桥接
  const boot = await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    if (!pinia || !(pinia._s instanceof Map)) return 'NO_PINIA'
    window.__vt = {
      pinia,
      files: () => pinia._s.get('files'),
      ui: () => pinia._s.get('ui'),
      settings: () => pinia._s.get('settings'),
      ed: () => pinia._s.get('editor')?.instance ?? null
    }
    return 'OK'
  })()`)
  if (boot !== 'OK') { console.log('FAIL pinia-bridge', boot); process.exit(2) }
  console.log('PASS pinia-bridge')

  // 归一化 + 打开无标题文档 + 写入标题与代码块
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

  // 获取标题与代码块内容区坐标
  const rects = await ev(`(() => {
    const h = document.querySelector('.ProseMirror h1')
    const cm = document.querySelector('.ProseMirror .cm-editor .cm-content')
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top, left: b.left, width: b.width, height: b.height } }
    return { h: h ? r(h) : null, cm: cm ? r(cm) : null }
  })()`)
  if (!rects.h || !rects.cm) { console.log('FAIL rects', JSON.stringify(rects)); process.exit(2) }
  console.log('rects', JSON.stringify(rects))

  // 1) 点击标题 → 应显示 H1 徽章
  await mouse('mousePressed', rects.h.x, rects.h.y, { clickCount: 1 })
  await mouse('mouseReleased', rects.h.x, rects.h.y, { clickCount: 1 })
  await sleep(300)
  const afterHeadingClick = await ev(`(() => {
    const h = document.querySelector('.ProseMirror h1')
    const badge = h ? getComputedStyle(h, '::before').display : 'no-h1'
    const ae = document.activeElement
    return { badge, focusedHeading: !!(ae && ae.closest && ae.closest('h1')), inCm: !!(ae && ae.closest && ae.closest('.cm-editor')) }
  })()`)
  console.log('afterHeadingClick', JSON.stringify(afterHeadingClick))

  // 2) 在代码块内拖拽多选
  const y = rects.cm.y
  const x0 = rects.cm.left + 4
  const x1 = rects.cm.left + Math.min(60, rects.cm.width - 8)
  await mouse('mousePressed', x0, y, { clickCount: 1 })
  await sleep(60)
  for (let i = 1; i <= 5; i++) {
    const x = x0 + ((x1 - x0) * i) / 5
    await mouse('mouseMoved', x, y, { button: 'left', buttons: 1 })
    await sleep(30)
  }
  await mouse('mouseReleased', x1, y, { clickCount: 1 })
  await sleep(400)

  const finalState = await ev(`(() => {
    const ae = document.activeElement
    const sel = document.getSelection()
    const cmContent = document.querySelector('.ProseMirror .cm-editor .cm-content')
    const cmSel = (() => {
      if (!sel || !cmContent) return null
      const inCm = cmContent.contains(sel.anchorNode) || cmContent.contains(sel.focusNode)
      return { inCm, collapsed: sel.isCollapsed, text: sel.toString() }
    })()
    const h = document.querySelector('.ProseMirror h1')
    const badge = h ? getComputedStyle(h, '::before').display : 'no-h1'
    const ed = window.__vt.ed()
    const pmSel = ed?.state.selection
    const pmFrom = pmSel ? pmSel.from : -1
    return {
      activeInCm: !!(ae && ae.closest && ae.closest('.cm-editor')),
      cmSel,
      badge,
      pmFrom,
      docSize: ed?.state.doc.content.size ?? -1
    }
  })()`)
  console.log('finalState', JSON.stringify(finalState))

  const pass = finalState.activeInCm === true &&
    finalState.cmSel && finalState.cmSel.inCm === true && finalState.cmSel.collapsed === false
  console.log(pass ? 'PASS focus-stays-in-cm' : 'FAIL focus-stolen')
  console.log('badge-after-cm=', finalState.badge)
  ws.close()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
