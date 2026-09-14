// 验收：「文件 → 新建窗口」打开的是**干净窗口**（不继承当前工作区）
//
// 断言：新窗口 root=null、侧栏是空态入口（不是别人的文件夹树）、编辑器是空白未命名缓冲区、
// 标题为 Untitled-N.md - Lumin；**原窗口与全局工作区完全不受影响**；
// 干净窗口里依然能正常打开文件、也能自己再打开文件夹（不是残废窗口）。
//
// 跑法：用**独立 userData** 起实例（不碰用户正在用的窗口/数据）：
//   $env:ELECTRON_RENDERER_URL='http://localhost:5173'; $env:LUMIN_DEBUG_PORT='9222'
//   electron . --user-data-dir=$env:TEMP\lumin-clean-userdata
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
  window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

const SNAP = `JSON.stringify({
  noWorkspaceFlag: window.luminAPI.app.startupNoWorkspace,
  root: window.__vt.files().root,
  doc: window.__vt.files().current?.path ?? null,
  docName: window.__vt.files().current?.name ?? null,
  title: document.title,
  treeRows: document.querySelectorAll('aside [data-tree-row]').length,
  hubVisible: (() => {
    const hub = document.querySelector('aside .empty-hub')
    if (!hub) return false
    // 空态是三个图标按钮（文案在 aria-label 上），按 i18n 取标签，避免把界面语言写死在断言里
    const t = (k) => window.__vt.app.config.globalProperties.$t(k)
    const labels = [...hub.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '')
    return labels.includes(t('open.newDoc')) && labels.includes(t('open.openFile')) && labels.includes(t('open.openFolder'))
  })(),
  slot: window.luminAPI.app.sessionSlot
})`

async function pages() {
  return (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
}

async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let j = 0; j < 80; j++) {
    await sleep(250)
    if ((await c.ev(SETUP)) === 'ok' && (await c.ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

const snap = async (w) => JSON.parse(await w.ev(SNAP))

/** 通过真实 UI 点击「文件」菜单里的某一项（Alt+F 打开菜单 → 点条目中心） */
async function clickFileMenuItem(w, labelExpr) {
  await w.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
    modifiers: 1
  })
  await w.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
    modifiers: 1
  })
  await sleep(500)
  const pos = await w.ev(`(() => {
    const p = document.querySelector('.topmenu-drop.fixed')
    if (!p) return null
    const label = ${labelExpr}
    const btn = [...p.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label)
    if (!btn) return JSON.stringify({ found: false, items: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()) })
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!pos) throw new Error('文件菜单没有打开')
  const info = JSON.parse(pos)
  if (!info.found) throw new Error('菜单里找不到目标项: ' + JSON.stringify(info.items))
  await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, button: 'none' })
  await sleep(60)
  await w.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await sleep(40)
  await w.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  return true
}

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 两个一次性工作区（不碰用户数据）
  const WS1 = path.join(os.tmpdir(), 'lumin-clean-ws1')
  const WS2 = path.join(os.tmpdir(), 'lumin-clean-ws2')
  for (const [dir, files] of [
    [WS1, { 'alpha.md': '# alpha\n\nhello\n' }],
    [WS2, { 'beta.md': '# beta\n' }]
  ]) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  }
  const ALPHA = path.join(WS1, 'alpha.md')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const w1 = await attach(all[0])
  let w2 = null

  try {
    // ① 让原窗口处在一个明确的「有工作区」状态（并确保编辑器里没有别的文档干扰）
    await w1.ev(`(() => { window.__vt.files().close(); return 'ok' })()`)
    await w1.ev(`(async () => { await window.__vt.files().setRoot(${JSON.stringify(WS1)}); return 'ok' })()`)
    await sleep(900)
    const before = await snap(w1)
    c('window-a-has-workspace', before.root === WS1 && before.treeRows > 0, JSON.stringify(before))

    // ② 真实菜单：文件 → 新建窗口
    const labelExpr = `(() => { try { return window.__vt.app.config.globalProperties.$t('menu.newWindow') } catch { return '新建窗口' } })()`
    await clickFileMenuItem(w1, labelExpr)
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w2 = await attach(fresh)
        break
      }
    }
    if (!w2) throw new Error('新窗口没有出现')
    seen.add(w2.id)
    await sleep(1200)
    const b = await snap(w2)
    console.log('NEW-WINDOW ' + JSON.stringify(b))

    c('new-window-flag', b.noWorkspaceFlag === true, JSON.stringify(b.noWorkspaceFlag))
    c('new-window-no-folder', b.root === null, JSON.stringify(b.root))
    c('new-window-shows-empty-state', b.hubVisible === true && b.treeRows === 0, JSON.stringify({ hub: b.hubVisible, rows: b.treeRows }))
    c('new-window-blank-untitled', b.doc === null && /^Untitled-\d+\.md$/.test(String(b.docName)), JSON.stringify({ doc: b.doc, name: b.docName }))
    c('new-window-title', b.title === 'Lumin', JSON.stringify(b.title))

    // ③ 原窗口与全局工作区不受影响
    const after = await snap(w1)
    c('window-a-untouched', after.root === WS1 && after.treeRows > 0 && after.slot === before.slot, JSON.stringify(after))
    const globalRoot = await w2.ev(`window.luminAPI.workspace.getRoot()`)
    c('global-workspace-unchanged', globalRoot === WS1, JSON.stringify(globalRoot))

    // ④ 干净窗口仍然可用：能打开文件（且不会因此获得文件夹）
    await w2.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(ALPHA)}); return 'ok' })()`)
    await sleep(900)
    const opened = await snap(w2)
    c('clean-window-opens-file', opened.doc === ALPHA && opened.title === 'alpha.md - Lumin' && opened.root === null, JSON.stringify(opened))
    c('clean-window-still-no-tree', opened.treeRows === 0, JSON.stringify(opened.treeRows))

    // ⑤ 干净窗口也能自己再打开一个文件夹
    await w2.ev(`(async () => { await window.__vt.files().setRoot(${JSON.stringify(WS2)}); return 'ok' })()`)
    await sleep(1000)
    const adopted = await snap(w2)
    c('clean-window-can-open-folder', adopted.root === WS2 && adopted.treeRows > 0, JSON.stringify(adopted))

    // ⑥ 边界：「在新窗口打开文件」这条路径**不受影响**（仍继承工作区，只是多打开一个文件）
    await w2.send('Page.close').catch(() => {})
    await sleep(700)
    await w1.ev(`(async () => { await window.__vt.files().setRoot(${JSON.stringify(WS1)}); return 'ok' })()`)
    await sleep(600)
    const beforeOpen = await snap(w1)
    await w1.ev(`(window.luminAPI.app.openInNewWindow(${JSON.stringify(ALPHA)}), 'ok')`)
    let w3 = null
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w3 = await attach(fresh)
        break
      }
    }
    if (!w3) throw new Error('「在新窗口打开文件」的窗口没有出现')
    seen.add(w3.id)
    await sleep(1200)
    const o = await snap(w3)
    c('open-file-in-new-window-still-inherits', o.noWorkspaceFlag === false && o.root === WS1 && o.doc === ALPHA, JSON.stringify(o))
    c('open-file-window-does-not-disturb-a', (await snap(w1)).root === beforeOpen.root, JSON.stringify(await snap(w1)))
    await w3.send('Page.close').catch(() => {})
    await sleep(700)
  } finally {
    if (w2 && w2.ws.readyState === 1) await w2.send('Page.close').catch(() => {})
    await sleep(700)
    fs.rmSync(WS1, { recursive: true, force: true })
    fs.rmSync(WS2, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w1.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
