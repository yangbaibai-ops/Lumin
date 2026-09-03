// tools/_repro-rapidenter.js — 快速回车验收：8 次回车应全部落 CM（9 行），PM 不回滚
const CDP = 'http://127.0.0.1:9222/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TEST_DIR = 'D:/code_workspace/Lumin-test-workspace'
const TEST_PATH = TEST_DIR + '/tipverify.md'
const TEST_MD = ['# 验收标题', '', '正文段落。', '', '```js', "console.log('hello')", '```', ''].join('\n')

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('NO_PAGE_TARGET')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error('页面异常: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const ensureBridge = () => ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = sym ? prov[sym] : null
    if (!pinia) return 'NO_PINIA'
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)

  await send('Page.enable')
  await send('Page.bringToFront')
  await ensureBridge()
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(1000)
  await ensureBridge()
  await ev(`window.luminAPI.workspace.setRoot(${JSON.stringify(TEST_DIR)}).then(() => 'ok')`)
  await ev(`window.luminAPI.file.write(${JSON.stringify(TEST_PATH)}, ${JSON.stringify(TEST_MD)}).then(() => 'ok')`)
  await ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(TEST_PATH)}); return 'ok' })()`)
  await sleep(1200)
  await ensureBridge()

  // 点击 CM 行尾
  const r = await ev(`(() => {
    const cm = document.querySelector('.cm-content')
    const b = cm?.getBoundingClientRect()
    return b ? { x: b.left + 60, y: b.top + b.height - 10 } : null
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)

  // 快速回车 ×8（35ms 间隔，模拟快速连点/按住）
  for (let i = 0; i < 8; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(35)
  }
  // 按住不动：15ms 间隔 ×10（系统按键重复速率）
  for (let i = 0; i < 10; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(15)
  }
  await sleep(800)

  const state = await ev(`(() => {
    const ae = document.activeElement
    const ed = window.__vt.ed()
    let pmLines = -1
    ed?.view.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') pmLines = n.textContent.split('\\n').length })
    return JSON.stringify({
      active: ae?.tagName + '.' + (typeof ae?.className === 'string' ? ae.className.split(' ')[0] : ''),
      cmLines: document.querySelectorAll('.cm-line').length,
      pmLines
    })
  })()`)
  console.log('final state:', state)

  const cmLines = JSON.parse(state).cmLines
  const pmLines = JSON.parse(state).pmLines
  if (cmLines === 19 && pmLines === 19) {
    console.log('PASS: 18 rapid Enters all landed (19 lines) in CM and PM')
  } else {
    console.log('FAIL: expected 19 lines in both, got cm=' + cmLines + ' pm=' + pmLines)
    process.exitCode = 1
  }

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL:', e.message); process.exit(1) })
