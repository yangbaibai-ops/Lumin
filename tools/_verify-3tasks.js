// 验证：1) 段落(D) 菜单及代码块插入; 2) toast 样式; 3) 新建文件进入就地重命名。
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
    if (!app) return 'NO_APP'
    const prov = app._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { pinia, files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'OK'
  })()`)

  // 打开编辑器 + 设置工作区
  await ev(`(() => { location.hash = '#/editor'; window.__vt.files().setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace'); return 'ok' })()`)
  await sleep(1000)

  // 1) 检查菜单按钮含 段落(D)
  const btns = await ev(`(() => [...document.querySelectorAll('.topmenu-root > button')].map(b => b.textContent.trim()).join('|'))()`)
  console.log('menu buttons:', btns)

  // 打开 段落(D) 下拉，点击「代码块」
  const dIdx = btns.split('|').findIndex((s) => s.includes('段落'))
  if (dIdx >= 0) {
    await ev(`(() => { [...document.querySelectorAll('.topmenu-root > button')][${dIdx}].click(); return 'ok' })()`)
    await sleep(300)
    const items = await ev(`(() => [...document.querySelectorAll('.topmenu-drop button')].map(b => b.textContent.trim()).join('|'))()`)
    console.log('paragraph menu items:', items)
    // 点「代码块」
    await ev(`(() => { const b = [...document.querySelectorAll('.topmenu-drop button')].find(x => x.textContent.includes('代码块')); if (b) b.click(); return 'ok' })()`)
    await sleep(600)
    const codeBlockInserted = await ev(`(() => { const ed = window.__vt.ed(); let has = false; ed && ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') has = true }); return has })()`)
    console.log('codeBlock inserted:', codeBlockInserted)
  }

  // 2) toast 样式：触发一个成功 toast，检查结构
  await ev(`(() => { window.__vt.ui().toast('保存成功测试消息', 'success', 3000); return 'ok' })()`)
  await sleep(300)
  const toastInfo = await ev(`(() => { const t = document.querySelector('.fixed.bottom-12 .rounded-xl'); if (!t) return null; const bar = t.querySelector('.absolute.inset-y-0'); const ic = t.querySelector('svg'); return JSON.stringify({ hasBar: !!bar, iconName: ic ? (ic.getAttribute('stroke') !== null ? 'svg' : 'no') : 'none', text: t.textContent.trim() }) })()`)
  console.log('toast:', toastInfo)

  // 3) 新建文件进入就地重命名
  const beforeCount = await ev(`(() => (window.__vt.files().dirCache['D:\\\\code_workspace\\\\Lumin-test-workspace'] || []).length)()`)
  await ev(`(async () => { await window.__vt.files().newFileAt('D:\\\\code_workspace\\\\Lumin-test-workspace'); return 'ok' })()`)
  await sleep(600)
  const renameState = await ev(`(() => { const inp = document.querySelector('.group input'); return JSON.stringify({ hasInput: !!inp, value: inp?.value ?? null, count: (window.__vt.files().dirCache['D:\\\\code_workspace\\\\Lumin-test-workspace'] || []).length }) })()`)
  console.log('new file rename state:', renameState, 'before count:', beforeCount)
  // 提交重命名：输入名字并回车
  if (renameState.includes('"hasInput":true')) {
    await send('Input.insertText', { text: 'rename-check' })
    await sleep(100)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(600)
    const names = await ev(`(() => (window.__vt.files().dirCache['D:\\\\code_workspace\\\\Lumin-test-workspace'] || []).map(n => n.name).join('|'))()`)
    console.log('after rename commit:', names)
  }

  ws.close()
  process.exit(0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
