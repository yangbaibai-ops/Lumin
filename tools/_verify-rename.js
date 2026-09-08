// 验证就地重命名：右键文件 → 点「重命名」→ 出现 input → 输入新名 → 回车 → 文件名变化。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value }
async function mouse(type, x, y, opts = {}) { await send('Input.dispatchMouseEvent', { type, x, y, button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1, buttons: opts.buttons ?? (type === 'mouseReleased' ? 0 : 1) }) }

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  // 找到第一个 .md 文件节点
  const node = await ev(`(() => {
    const rows = [...document.querySelectorAll('.group')]
    const file = rows.find((r) => /\\.md$/.test(r.textContent.trim()) && r.textContent.trim().length < 30)
    if (!file) return null
    const b = file.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, name: file.textContent.trim() }
  })()`)
  if (!node) { console.log('FAIL no file node'); process.exit(2) }
  console.log('target file:', node.name)

  // 右键打开上下文菜单
  await mouse('mousePressed', node.x, node.y, { button: 'right', clickCount: 1 })
  await mouse('mouseReleased', node.x, node.y, { button: 'right', clickCount: 1 })
  await sleep(300)
  // 点「重命名」
  const renameItem = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '重命名'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!renameItem) { console.log('FAIL no rename menu item'); process.exit(2) }
  await mouse('mousePressed', renameItem.x, renameItem.y, { clickCount: 1 })
  await mouse('mouseReleased', renameItem.x, renameItem.y, { clickCount: 1 })
  await sleep(400)

  // 检查 input 是否出现
  const inputState = await ev(`(() => { const inp = document.querySelector('.group input'); return { hasInput: !!inp, value: inp?.value ?? '', selected: inp ? (inp.selectionStart + '..' + inp.selectionEnd) : null } })()`)
  console.log('after rename click:', JSON.stringify(inputState))

  // 输入新名并回车
  if (inputState.hasInput) {
    await send('Input.insertText', { text: 'renamed-check' })
    await sleep(100)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(800)
    const after = await ev(`(() => { const rows = [...document.querySelectorAll('.group')]; const names = rows.map(r => r.textContent.trim()); return JSON.stringify({ hasRenamed: names.some(n => n.includes('renamed-check')), names: names.slice(0, 8) }) })()`)
    console.log('after enter:', after)
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
