// 验收：关窗再打开，回到刚才那篇文档（而不是一个不落在任何位置的未命名缓冲区）
//
// 背景：旧实现把「单独关窗」当成「清空这个窗口的会话槽位」。清掉之后重启只剩工作区
// 文件夹（它另记在全局 kv 里），文档没了 → 编辑器里是一个 Untitled-N.md 的空缓冲区。
//
// 期望（用户语义）：
//   A. 单独关掉唯一的窗口 → 再打开：回到关窗时那篇文档（工作区文件夹照旧）；
//   B. 多窗口挨个关掉 → 再打开：只回到**最后关掉的那个**窗口（更早关掉的是用户明确关掉的）；
//   C. 多窗口一起结束（崩溃/整体退出，这里用整进程被杀近似）→ 再打开：当时活着的窗口全部回来。
//
// 前置：先 `npm run build`（套件跑的是 out/ 里的构建产物，主进程改动不会热更新）。
// 跑法：`node tools/_verify-session-last-closed.js`（自起自灭 3 轮实例，独立 userData，不碰用户数据）
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const REPO = path.join(__dirname, '..')
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron.exe')
const PORT = 9222
const UD = path.join(os.tmpdir(), 'lumin-last-closed-userdata')
const WS = path.join(os.tmpdir(), 'lumin-last-closed-ws')
const FILE_A = path.join(WS, 'alpha.md')
const FILE_B = path.join(WS, 'beta.md')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
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
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__vt = { files: () => pinia._s.get('files') }
  return 'ok'
})()`

const SNAP = `JSON.stringify({
  slot: window.luminAPI.app.sessionSlot,
  root: window.__vt.files().root ?? null,
  doc: window.__vt.files().current?.path ?? null,
  name: window.__vt.files().current?.name ?? null
})`

async function waitForCdp(timeoutSteps = 80) {
  for (let i = 0; i < timeoutSteps; i++) {
    try {
      const list = await get('/json/list')
      const pages = list.filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
      if (pages.length) return pages
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  throw new Error('CDP 没起来')
}

/** 附着到一个页面并注入访问器 */
async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    const ok = await c.ev(SETUP).catch(() => 'err')
    if (ok === 'ok') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

function launch() {
  const env = { ...process.env, LUMIN_DEBUG_PORT: String(PORT) }
  // 隔离：不继承 dev server / dev profile（否则页面地址与 userData 都不是我们要的那份）
  delete env.ELECTRON_RENDERER_URL
  delete env.LUMIN_DEV_PROFILE
  return spawn(ELECTRON, [REPO, `--user-data-dir=${UD}`], { env, stdio: 'ignore' })
}

/** 等这一轮实例彻底退出（主进程退出码落地 + 端口松开） */
async function waitExit(child) {
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    if (child.exitCode !== null) break
  }
  await sleep(1200)
}

function killTree(child) {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 已经退了 */
  }
}

function rmrf(p) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch {
      // 刚杀掉的进程还会占一会儿句柄
      execFileSync('cmd', ['/c', 'ping -n 2 127.0.0.1 >NUL'], { stdio: 'ignore' })
    }
  }
}

/** 起一轮实例，等到窗口就绪；返回 { child, pages: [{conn, snap}] } */
async function boot(expectWindows, label) {
  const child = launch()
  const pages = await waitForCdp()
  const conns = []
  for (const p of pages) conns.push(await attach(p))
  // 多窗口时其余窗口在首帧之后才建：等窗口数到齐
  let deadline = Date.now() + 12000
  while (conns.length < expectWindows && Date.now() < deadline) {
    await sleep(400)
    const list = (await get('/json/list')).filter(
      (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
    )
    for (const p of list) {
      if (!conns.some((c) => c.id === p.id)) conns.push(await attach(p))
    }
  }
  // 会话恢复/位置落位都在这之后
  await sleep(2500)
  const snaps = []
  for (const c of conns) snaps.push(JSON.parse(await c.ev(SNAP)))
  return { child, conns, snaps, label }
}

function closeAll(conns) {
  for (const c of conns) c.ws.close()
}

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const docs = (snaps) => snaps.map((s) => s.doc).sort()
  const isUntitled = (s) => s.doc === null && /^Untitled-\d+\.md$/.test(String(s.name))

  rmrf(UD)
  rmrf(WS)
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(FILE_A, '# alpha\n\n关窗后应该回到我\n')
  fs.writeFileSync(FILE_B, '# beta\n')

  // 安全闸：本套件会**关掉**它连上的窗口。如果 9222 上已经有别人（用户自己的调试实例、
  // dev --watch 会话…）在跑，绝不能去动它 —— 直接退出，把话说清楚。
  const already = await get('/json/list').catch(() => null)
  const busy = (already ?? []).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  if (busy.length) {
    console.log(`SKIP: 9222 上已有 ${busy.length} 个页面在跑（不是本套件起的实例），不碰它`)
    return
  }

  let round
  try {
    // ── A. 单独关掉唯一的窗口 → 再打开：回到那篇文档
    round = await boot(1, 'A1')
    await round.conns[0].ev(
      `(async () => { await window.__vt.files().setRoot(${JSON.stringify(WS)}); await window.__vt.files().openPath(${JSON.stringify(FILE_A)}); return 'ok' })()`
    )
    await sleep(1500)
    const beforeA = JSON.parse(await round.conns[0].ev(SNAP))
    await round.conns[0].ev(`(window.luminAPI.app.close(), 'ok')`)
    await waitExit(round.child)
    closeAll(round.conns)

    round = await boot(1, 'A2')
    const afterA = round.snaps
    c('A-关窗前的文档', beforeA.doc === FILE_A, JSON.stringify(beforeA))
    c(
      'A-重开后回到那篇文档（不是虚空未命名缓冲区）',
      afterA.length === 1 && afterA[0].doc === FILE_A && !isUntitled(afterA[0]),
      JSON.stringify(afterA)
    )
    c('A-工作区文件夹照旧', afterA[0]?.root === WS, JSON.stringify(afterA[0]))

    // ── B. 多窗口挨个关掉 → 再打开：只回到最后关掉的那个
    const w1 = round.conns[0]
    c('B-第二轮开局读文件 A', round.snaps[0].doc === FILE_A, JSON.stringify(round.snaps[0]))
    await w1.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
    let deadline = Date.now() + 12000
    let pages = await get('/json/list')
    let w2page = null
    while (!w2page && Date.now() < deadline) {
      await sleep(400)
      pages = (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
      w2page = pages.find((p) => p.id !== w1.id) ?? null
    }
    if (!w2page) throw new Error('第二个窗口没有出现')
    const w2 = await attach(w2page)
    await w2.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(FILE_B)}); return 'ok' })()`)
    await sleep(1500)
    const beforeB = [JSON.parse(await w1.ev(SNAP)), JSON.parse(await w2.ev(SNAP))]
    // 先关 beta 那个，再关 alpha 那个 → 「最后关掉」= alpha
    await w2.ev(`(window.luminAPI.app.close(), 'ok')`)
    await sleep(1200)
    await w1.ev(`(window.luminAPI.app.close(), 'ok')`)
    await waitExit(round.child)
    closeAll([w1, w2])

    round = await boot(1, 'B2')
    const afterB = round.snaps
    c('B-关窗前两个窗口各有一篇', docs(beforeB).join('|') === [FILE_A, FILE_B].sort().join('|'), JSON.stringify(beforeB))
    c(
      'B-只回到最后关掉的那个窗口的文档',
      afterB.length === 1 && afterB[0].doc === FILE_A && !isUntitled(afterB[0]),
      JSON.stringify(afterB)
    )

    // ── C. 多窗口一起结束（整进程被杀）→ 再打开：活着的窗口全部回来
    const c1 = round.conns[0]
    await c1.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
    deadline = Date.now() + 12000
    let c2page = null
    while (!c2page && Date.now() < deadline) {
      await sleep(400)
      pages = (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
      c2page = pages.find((p) => p.id !== c1.id) ?? null
    }
    if (!c2page) throw new Error('第三个窗口没有出现')
    const c2 = await attach(c2page)
    await c2.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(FILE_B)}); return 'ok' })()`)
    await sleep(2000)
    const beforeC = [JSON.parse(await c1.ev(SNAP)), JSON.parse(await c2.ev(SNAP))]
    killTree(round.child)
    await waitExit(round.child)
    closeAll([c1, c2])

    round = await boot(2, 'C2')
    const afterC = round.snaps
    c('C-一起结束前两个窗口各有一篇', docs(beforeC).join('|') === [FILE_A, FILE_B].sort().join('|'), JSON.stringify(beforeC))
    c(
      'C-一起结束后两个窗口都回来',
      afterC.length === 2 && docs(afterC).join('|') === [FILE_A, FILE_B].sort().join('|'),
      JSON.stringify(afterC)
    )
  } finally {
    if (round) {
      killTree(round.child)
      closeAll(round.conns)
      await sleep(1500)
    }
    rmrf(UD)
    rmrf(WS)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
