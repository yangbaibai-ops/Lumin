// tools/_repro-split.js — 源码高度 + 分屏双同步 + 分隔条拖拽复现
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TEST_DIR = 'C:/work/Lumin/test-workspace'
const TEST_PATH = TEST_DIR + '/tipverify.md'
const TEST_MD = ['# 分屏标题', '', '分屏段落内容。', ''].join('\n')

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
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
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

  // 1) 源码模式高度
  await ev('toSource', `(() => {
    const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('源码模式'))
    b.click()
    return 'ok'
  })()`)
  await sleep(500)
  await ev('srcHeight', `(() => {
    const ta = document.querySelector('textarea.source-editor')
    const host = ta?.parentElement?.parentElement
    return JSON.stringify({ taH: ta ? ta.getBoundingClientRect().height : 0, hostH: host ? host.getBoundingClientRect().height : 0, scrollH: ta ? ta.scrollHeight : 0 })
  })()`)

  // 2) 分屏模式
  await ev('toSplit', `(() => {
    const b = [...document.querySelectorAll('.mode-seg-btn')].find((x) => (x.title || '').includes('分屏'))
    b.click()
    return 'ok'
  })()`)
  await sleep(900)
  await ev('splitInit', `(() => {
    const pm = document.querySelector('.ProseMirror')
    const ta = document.querySelector('textarea.source-editor')
    const host = ta?.closest('.flex.h-full')
    return JSON.stringify({ pm: !!pm, ta: !!ta, leftW: host ? host.firstElementChild.getBoundingClientRect().width : 0, hostW: host ? host.getBoundingClientRect().width : 0 })
  })()`)

  // 3) 右 → 左
  const taPt = await ev('taPt', `(() => {
    const ta = document.querySelector('textarea.source-editor')
    const r = ta.getBoundingClientRect()
    return JSON.stringify({ x: r.left + 80, y: r.top + 30 })
  })()`)
  const tp = JSON.parse(taPt)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: tp.x, y: tp.y, button: 'left', clickCount: 1 })
  }
  await sleep(250)
  await send('Input.insertText', { text: '右→左' })
  await sleep(800)
  await ev('r2l', `(() => {
    let found = false
    window.__vt.ed()?.view.state.doc.descendants((n) => { if (n.textContent.includes('右→左')) found = true })
    return JSON.stringify({ found })
  })()`)

  // 4) 左 → 右
  const leftPt = await ev('leftPt', `(() => {
    const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
    const pm = host?.querySelector('.ProseMirror')
    const paras = pm ? [...pm.querySelectorAll('p')] : []
    const p = paras[paras.length - 1]
    if (!p) return null
    const r = p.getBoundingClientRect()
    return JSON.stringify({ x: r.left + 40, y: r.top + r.height / 2 })
  })()`)
  const lp = JSON.parse(leftPt)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: lp.x, y: lp.y, button: 'left', clickCount: 1 })
  }
  await sleep(250)
  await send('Input.insertText', { text: '左→右' })
  await sleep(700)
  await ev('l2r', `(() => {
    const ta = document.querySelector('textarea.source-editor')
    return JSON.stringify({ has: ta ? ta.value.includes('左→右') : false })
  })()`)

  // 5) 分隔条拖拽
  const divPt = await ev('divPt', `(() => {
    const d = document.querySelector('.split-divider')
    const r = d.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + 120 })
  })()`)
  const dp = JSON.parse(divPt)
  const before = await ev('ratioBefore', `(() => {
    const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
    const left = host?.firstElementChild
    return left && host ? left.getBoundingClientRect().width / host.getBoundingClientRect().width : 0.5
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dp.x, y: dp.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dp.x - 140, y: dp.y, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dp.x - 140, y: dp.y, button: 'left', clickCount: 1 })
  await sleep(400)
  await ev('ratioAfter', `(() => {
    const host = document.querySelector('textarea.source-editor')?.closest('.flex.h-full')
    const left = host?.firstElementChild
    const ratio = left && host ? left.getBoundingClientRect().width / host.getBoundingClientRect().width : 0.5
    const settings = window.__vt.pinia._s.get('settings')
    return JSON.stringify({ ratio, persisted: settings.splitRatio, before: ${before} })
  })()`)

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL:', e.message); process.exit(1) })
