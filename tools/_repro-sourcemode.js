// tools/_repro-sourcemode.js — 源码/实时渲染切换复现
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TEST_DIR = 'D:/code_workspace/Lumin-test-workspace'
const TEST_PATH = TEST_DIR + '/tipverify.md'
const TEST_MD = ['# 切换标题', '', '切换段落**加粗**。', ''].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (label, expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) { console.log(`[${label}] EX: ` + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return undefined }
    const v = r.result?.result?.value
    console.log(`[${label}] => ` + (v === undefined ? String(v) : v))
    return v
  }
  const ensureBridge = () => ev('bridge', `(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui') }
    return 'OK'
  })()`)

  await send('Page.enable')
  await send('Page.bringToFront')
  await ensureBridge()
  await ev('route', `(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1000)
  await ensureBridge()
  await ev('setRoot', `window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
  await ev('writeFile', `window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`)
  await ev('openPath', `(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
  await sleep(1200)
  await ensureBridge()

  // 1) 初始：实时渲染
  await ev('init', `(() => {
    const pm = document.querySelector('.ProseMirror')
    const ta = document.querySelector('textarea.source-editor')
    return JSON.stringify({ wysiwyg: !!pm, source: !!ta, h1: !!pm?.querySelector('h1'), mode: window.__vt.ui().editorMode })
  })()`)

  // 2) 点击工具栏切换按钮（title 含「源码」）
  const btn = await ev('btnPt', `(() => {
    const b = [...document.querySelectorAll('.icon-btn')].find((x) => (x.title || '').includes('源码模式'))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`)
  const bp = JSON.parse(btn)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: bp.x, y: bp.y, button: 'left', clickCount: 1 })
  }
  await sleep(500)
  await ev('afterToggle', `(() => {
    const pm = document.querySelector('.ProseMirror')
    const ta = document.querySelector('textarea.source-editor')
    const focused = document.activeElement === ta
    return JSON.stringify({
      wysiwyg: !!pm,
      source: !!ta,
      focused,
      value: ta ? ta.value : '',
      mode: window.__vt.ui().editorMode
    })
  })()`)

  // 3) 在源码模式输入（textarea 光标在末尾 → insertText）
  await send('Input.insertText', { text: '源码追加' })
  await sleep(500)
  await ev('afterType', `(() => {
    const ta = document.querySelector('textarea.source-editor')
    const content = window.__vt.files().current.content
    return JSON.stringify({ value: ta ? ta.value : '', storeHas: content.includes('源码追加'), dirty: window.__vt.files().dirty })
  })()`)

  // 4) 切回实时渲染
  const btn2 = await ev('btnPt2', `(() => {
    const b = [...document.querySelectorAll('.icon-btn')].find((x) => (x.title || '').includes('实时渲染'))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`)
  const bp2 = JSON.parse(btn2)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: bp2.x, y: bp2.y, button: 'left', clickCount: 1 })
  }
  await sleep(900)
  await ev('backToWysiwyg', `(() => {
    const pm = document.querySelector('.ProseMirror')
    const ta = document.querySelector('textarea.source-editor')
    const h1 = pm?.querySelector('h1')
    let pFound = false
    window.__vt.ed()?.view.state.doc.descendants((n) => { if (n.type.name === 'paragraph' && n.textContent.includes('源码追加')) pFound = true })
    return JSON.stringify({ wysiwyg: !!pm, source: !!ta, h1Text: h1 ? h1.textContent : '', pFound, mode: window.__vt.ui().editorMode })
  })()`)

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL:', e.message); process.exit(1) })
