// 检查空 codeBlock 在 PM 层是否可删：强制 NodeSelection + Delete；及光标在其后段落按 Backspace。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

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
    window.__vt = { pinia, files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)
  await ev(`(() => { location.hash = '#/editor'; return 'ok' })()`)
  await sleep(500)
  await ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)
  await sleep(400)
  const md = '段落A\n\n```js\nabc\n```\n\n段落B'
  await ev(`(() => { window.__vt.ed().commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
  await sleep(400)
  // 清空 codeblock
  await ev(`(() => {
    const ed = window.__vt.ed(); let pos = -1
    ed.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'codeBlock') pos = p })
    const node = ed.state.doc.nodeAt(pos)
    ed.commands.command(({ tr }) => { tr.delete(pos + 1, pos + node.nodeSize - 1); return true })
    return pos
  })()`)
  await sleep(300)

  // 1) 强制 NodeSelection + Delete 命令
  const del1 = await ev(`(() => {
    const ed = window.__vt.ed(); let pos = -1
    ed.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === 'codeBlock') pos = p })
    ed.chain().focus().setNodeSelection(pos).deleteSelection().run()
    let c = 0
    ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c++ })
    return c
  })()`)
  console.log('after NodeSelection+Delete, codeBlocks:', del1)

  // 重新建一个空 codeblock，测试光标在其后段落按 Backspace
  await ev(`(() => { window.__vt.ed().commands.setContent('甲\n\n\`\`\`\n\n\`\`\`\n\n乙'); return 'ok' })()`)
  await sleep(400)
  await ev(`(() => { window.__vt.ed().commands.setContent('甲\n\n\`\`\`\n\n\`\`\`\n\n乙'); return 'ok' })()`)
  await sleep(400)
  const st = await ev(`(() => { const ed = window.__vt.ed(); const s = ed.state.selection; ed.chain().focus('end').run(); return 'ok' })()`)
  await sleep(200)
  // 从文档末尾 Backspace 数次（应删除空段落后进入段落乙，再到 codeblock 前）
  let backspaced = 0
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    backspaced++
    await sleep(200)
  }
  const afterB = await ev(`(() => { const ed = window.__vt.ed(); let c = 0; let md=''; ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c++ }); return JSON.stringify({ codeBlocks: c }) })()`)
  console.log('after 3 backspaces from end, codeBlocks:', afterB)

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
