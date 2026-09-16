// 复现：空代码块删除困境。设内容 → 清空代码块 → 尝试多种删除方式观察结果。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

const COUNT = `(() => { const ed = window.__vt.ed(); let blocks = 0; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') blocks++ }); return blocks })()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')
  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = sym ? prov[sym] : null
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(600)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(400)

  // 文档：段落后一个带内容的代码块 + 段落
  const md = '段落A\n\n```js\nline1\nline2\n```\n\n段落B'
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(500)
  console.log('initial codeBlocks:', await ev(COUNT))

  // 尝试通过 PM 事务把 codeBlock 文本清空（删除内容区间，留下空 codeBlock）
  await ev(`(() => {
    const ed = window.__vt.ed()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'codeBlock') pos = p })
    const node = ed.state.doc.nodeAt(pos)
    ed.commands.command(({ tr }) => { tr.delete(pos + 1, pos + node.nodeSize - 1); return true })
    return pos
  })()`)
  await sleep(500)
  console.log('after empty content, codeBlocks:', await ev(COUNT))

  // 尝试 1：点击代码块头部（选择节点）然后按 Delete —— 用 CDP 鼠标点击头部区域
  const hdr = await ev(`(() => { const h = document.querySelector('.code-block-header'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (hdr) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hdr.x, y: hdr.y, clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hdr.x, y: hdr.y, clickCount: 1, buttons: 0 })
    await sleep(300)
  }
  const selType1 = await ev(`(() => { const ed = window.__vt.ed(); return ed.state.selection.constructor.name })()`)
  console.log('after header click, selection type:', selType1)

  // 尝试 2：全选 + Delete（Ctrl+A 后 Delete）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await sleep(200)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await sleep(400)
  console.log('after ctrl+A + Delete, codeBlocks:', await ev(COUNT))

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
