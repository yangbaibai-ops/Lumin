// 验收：窗口标题跟随本窗口打开的文件（Windows 任务栏里能分清多个窗口）
//
// 规则（见 composables/useWindowTitle.ts）：
//   打开了文件       → `文件名 - Lumin`（有未保存改动时前缀 `• `）
//   没有打开任何文件 → `Lumin`（只开工作区、未命名缓冲区都算没打开文件；连未保存也不算）
//
// 跑法：用**独立 userData** 起一个实例（不碰用户正在用的窗口/数据）：
//   $env:ELECTRON_RENDERER_URL='http://localhost:5173'; $env:LUMIN_DEBUG_PORT='9222'
//   electron . --user-data-dir=$env:TEMP\lumin-title-userdata
// 真实任务栏标题（原生窗口标题）另用 Win32 枚举核对。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const WS = path.join(os.tmpdir(), 'lumin-title-ws')
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
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui') }
  return 'ok'
})()`

const titleOf = (w) => w.ev(`document.title`)
const setup = (w) => w.ev(SETUP)
const setRoot = (w, dir) =>
  w.ev(`(async () => { await window.__vt.files().setRoot(${JSON.stringify(dir)}); return 'ok' })()`)
const openPath = (w, p) =>
  w.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(p)}); return 'ok' })()`)
const closeDoc = (w) => w.ev(`(() => { window.__vt.files().close(); return 'ok' })()`)
const openUntitled = (w) => w.ev(`(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`)

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

async function openScratch(from, seen) {
  await from.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    const fresh = (await pages()).find((p) => !seen.has(p.id))
    if (fresh) return attach(fresh)
  }
  throw new Error('临时窗口未出现')
}

/** 回到「无文档、无工作区」的已知状态，保证套件可重复运行 */
async function reset(w) {
  await closeDoc(w)
  await setRoot(w, null)
  await sleep(500)
}

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(path.join(WS, 'alpha.md'), '# alpha\n\nfirst\n')
  fs.writeFileSync(path.join(WS, 'beta.md'), '# beta\n\nsecond\n')
  const A = path.join(WS, 'alpha.md')
  const B = path.join(WS, 'beta.md')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口（isolated 实例未启动？）')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const w1 = await attach(all[0])
  let w2 = null

  try {
    await reset(w1)
    c('idle-title', (await titleOf(w1)) === 'Lumin', JSON.stringify(await titleOf(w1)))

    await openUntitled(w1)
    await sleep(500)
    c('untitled-without-workspace-is-app-name', (await titleOf(w1)) === 'Lumin', JSON.stringify(await titleOf(w1)))

    // 未命名缓冲区即使有未保存改动，标题也保持纯应用名（未保存另有状态栏/工具栏提示）
    await w1.ev(`(() => { const f = window.__vt.files(); f.setContent('draft text'); return 'ok' })()`)
    await sleep(500)
    c('dirty-untitled-still-app-name', (await titleOf(w1)) === 'Lumin', JSON.stringify({ dirty: await w1.ev(`window.__vt.files().dirty`), title: await titleOf(w1) }))
    await openUntitled(w1)
    await sleep(400)

    await setRoot(w1, WS)
    await sleep(500)
    c('folder-only-title-is-app-name', (await titleOf(w1)) === 'Lumin', JSON.stringify(await titleOf(w1)))

    await openPath(w1, A)
    await sleep(700)
    c('document-title', (await titleOf(w1)) === 'alpha.md - Lumin', JSON.stringify(await titleOf(w1)))

    await w1.ev(`(() => { const f = window.__vt.files(); f.setContent(f.current.content + '\\n\\ndirty\\n'); return 'ok' })()`)
    await sleep(500)
    c('dirty-marker', (await w1.ev(`window.__vt.files().dirty`)) === true && (await titleOf(w1)) === '• alpha.md - Lumin', JSON.stringify(await titleOf(w1)))

    await openPath(w1, A)
    await sleep(600)
    c('dirty-marker-cleared', (await titleOf(w1)) === 'alpha.md - Lumin', JSON.stringify(await titleOf(w1)))

    await w1.ev(
      `(async () => { const f = window.__vt.files(); await f.renameNode({ path: ${JSON.stringify(A)}, name: 'alpha.md', isDir: false }, ${JSON.stringify(WS)}, 'gamma.md'); return 'ok' })()`
    )
    await sleep(800)
    c('title-follows-rename', (await titleOf(w1)) === 'gamma.md - Lumin', JSON.stringify(await titleOf(w1)))

    // ── 第二个窗口：标题独立，互不串台 ──
    w2 = await openScratch(w1, seen)
    seen.add(w2.id)
    await reset(w2)
    c('second-window-idle', (await titleOf(w2)) === 'Lumin', JSON.stringify(await titleOf(w2)))
    await setRoot(w2, WS)
    await openPath(w2, B)
    await sleep(800)
    const t1 = await titleOf(w1)
    const t2 = await titleOf(w2)
    c('two-windows-distinct-titles', t1 === 'gamma.md - Lumin' && t2 === 'beta.md - Lumin', JSON.stringify({ w1: t1, w2: t2 }))

    // 没有打开文件时（未命名缓冲区 / 只有工作区）标题都退回纯应用名
    await openUntitled(w2)
    await sleep(500)
    c('untitled-with-workspace-is-app-name', (await titleOf(w2)) === 'Lumin', JSON.stringify(await titleOf(w2)))
    await setRoot(w2, null)
    await sleep(500)
    c('untitled-after-clearing-workspace-is-app-name', (await titleOf(w2)) === 'Lumin', JSON.stringify(await titleOf(w2)))

    // 关掉文件后回到纯应用名
    await setRoot(w2, WS)
    await closeDoc(w2)
    await sleep(500)
    c('back-to-app-name', (await titleOf(w2)) === 'Lumin', JSON.stringify(await titleOf(w2)))
    await setRoot(w2, null)
    await sleep(500)
    c('app-name-fallback', (await titleOf(w2)) === 'Lumin', JSON.stringify(await titleOf(w2)))

    console.log('TITLES ' + JSON.stringify({ w1: await titleOf(w1), w2: await titleOf(w2) }))
  } finally {
    if (w2 && w2.ws.readyState === 1) await w2.send('Page.close').catch(() => {})
    await sleep(600)
    fs.rmSync(WS, { recursive: true, force: true })
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
