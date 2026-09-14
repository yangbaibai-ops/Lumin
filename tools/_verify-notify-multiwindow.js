// 验收：通知按「窗口作用域」隔离 —— 一个窗口的提示只出现在它自己身上
//
// 背景（修复前的 bug）：通知表是全局的，主进程每次变更还广播给所有窗口，
// 于是在 A 窗口保存文件产生的提示会在 B/C 窗口同时弹出来。
// 现在：作用域由主进程按 IPC 发送方反查（w<会话槽位>），读写都带 scope 条件，
// 变更信号只回给发起窗口；窗口关闭 / 槽位被新窗口复用时清理该作用域。
//
// 本套件全程只使用自己新开的临时窗口（NEW_WINDOW），不读写用户已有窗口的通知；
// 结束时会关闭这些临时窗口（主进程随之清掉它们的作用域行）。
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')
const CDP = 'http://127.0.0.1:9222/json'
const DB = process.env.LUMIN_DB || path.join(os.homedir(), 'AppData', 'Roaming', 'lumin', 'lumin.db')
const STAMP = Date.now()
const T_A = '隔离验证-A-' + STAMP
const T_B = '隔离验证-B-' + STAMP
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const SETUP_VT = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
  window.__vt = { ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications') }
  return 'ok'
})()`
const SNAP = `(() => JSON.stringify({
  store: window.__vt.notif().items.map((n) => n.title),
  cards: document.querySelectorAll('.ntf-card').length,
  slot: window.luminAPI.app.sessionSlot
}))()`

function dbRows(title) {
  let db
  try {
    db = new DatabaseSync(DB, { readOnly: true })
    return db
      .prepare('SELECT id, scope, level, title, body, closed_at FROM notifications WHERE title = ?')
      .all(title)
  } finally {
    db?.close()
  }
}

async function pages() {
  return (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && t.url.includes('5173'))
}

/** 用「id 集合差」找出新开的窗口（不依赖顺序，也不碰已有窗口） */
async function openScratch(fromPage, seenIds, label) {
  await fromPage.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    const fresh = (await pages()).find((p) => !seenIds.has(p.id))
    if (fresh) {
      const c = connect(fresh.webSocketDebuggerUrl)
      await c.ready
      await c.send('Page.enable')
      for (let j = 0; j < 80; j++) {
        await sleep(300)
        if ((await c.ev(SETUP_VT)) === 'ok' && (await c.ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
      }
      await c.ev(SETUP_VT)
      await sleep(500)
      c.id = fresh.id
      c.label = label
      return c
    }
  }
  throw new Error('临时窗口未出现: ' + label)
}

const notify = (win, title, extra = '') =>
  win.ev(
    `(async () => { await window.__vt.notif().notify({ level: 'warning', title: ${JSON.stringify(title)}, body: '仅本窗口可见'${extra} }); return 'ok' })()`
  )

async function main() {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口（dev server / app 未启动？）')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const host = connect(all[0].webSocketDebuggerUrl)
  await host.ready
  await host.send('Page.enable')
  await host.ev(SETUP_VT)

  // 用户已有窗口的通知快照（全程必须保持不变）
  const userBefore = []
  for (const p of all) {
    const w = connect(p.webSocketDebuggerUrl)
    await w.ready
    await w.ev(SETUP_VT)
    userBefore.push({ id: p.id, snap: await w.ev(SNAP) })
    w.ws.close()
  }

  let a = null
  let b = null
  let cw = null
  try {
    a = await openScratch(host, seen, 'A')
    seen.add(a.id)
    b = await openScratch(host, seen, 'B')
    seen.add(b.id)

    const a0 = JSON.parse(await a.ev(SNAP))
    const b0 = JSON.parse(await b.ev(SNAP))
    console.log('SCRATCH A=' + JSON.stringify(a0) + ' B=' + JSON.stringify(b0))
    c('scratch-windows-have-distinct-slots', a0.slot !== b0.slot, `A=${a0.slot} B=${b0.slot}`)
    c('scratch-start-clean', a0.cards === 0 && b0.cards === 0, JSON.stringify({ a: a0.store, b: b0.store }))

    // ── A 产生通知：只有 A 看得到 ──
    await notify(a, T_A)
    await sleep(1200)
    const a1 = JSON.parse(await a.ev(SNAP))
    const b1 = JSON.parse(await b.ev(SNAP))
    console.log('AFTER-A A=' + JSON.stringify(a1) + ' B=' + JSON.stringify(b1))
    c('created-in-A-shows-in-A', a1.store.includes(T_A) && a1.cards === 1, JSON.stringify(a1))
    c('created-in-A-not-mirrored-in-B', !b1.store.includes(T_A) && b1.cards === 0, JSON.stringify(b1))

    // ── 落库证据：行的 scope 就是 A 窗口的作用域 ──
    const rowsA = dbRows(T_A)
    const scopeA = 'w' + a1.slot
    console.log('DB(A) ' + JSON.stringify(rowsA))
    c('A-row-persisted', rowsA.length === 1 && rowsA[0].body === '仅本窗口可见', JSON.stringify(rowsA))
    c('A-row-scoped-to-window', rowsA[0]?.scope === scopeA, `scope=${rowsA[0]?.scope} expect=${scopeA}`)
    c('no-unscoped-rows', rowsA.every((r) => r.scope), JSON.stringify(rowsA.map((r) => r.scope)))

    // ── B 产生通知：两边各自一条，互不干扰 ──
    await notify(b, T_B)
    await sleep(1200)
    const a2 = JSON.parse(await a.ev(SNAP))
    const b2 = JSON.parse(await b.ev(SNAP))
    console.log('AFTER-B A=' + JSON.stringify(a2) + ' B=' + JSON.stringify(b2))
    c('created-in-B-shows-in-B', b2.store.includes(T_B) && b2.cards === 1, JSON.stringify(b2))
    c('created-in-B-not-mirrored-in-A', !a2.store.includes(T_B) && a2.store.includes(T_A) && a2.cards === 1, JSON.stringify(a2))
    const rowsB = dbRows(T_B)
    c('B-row-scoped-differently', rowsB[0]?.scope === 'w' + b2.slot && rowsB[0].scope !== rowsA[0].scope, JSON.stringify(rowsB.map((r) => r.scope)))

    // ── 同 mergeKey（默认 = level+title）合并只发生在自己的窗口内 ──
    await notify(a, T_A)
    await sleep(900)
    const a3 = JSON.parse(await a.ev(SNAP))
    const b3 = JSON.parse(await b.ev(SNAP))
    c('merge-stays-in-own-window', a3.store.filter((t) => t === T_A).length === 1 && a3.cards === 1 && b3.cards === 1, JSON.stringify({ a: a3, b: b3 }))
    c('merge-one-row-per-window', dbRows(T_A).length === 1 && dbRows(T_B).length === 1, JSON.stringify({ a: dbRows(T_A).length, b: dbRows(T_B).length }))

    // ── A 关闭全部 / 清理：只影响 A ──
    await a.ev(`(async () => { window.__vt.notif().closeAll(); return 'ok' })()`)
    await sleep(900)
    const a4 = JSON.parse(await a.ev(SNAP))
    const b4 = JSON.parse(await b.ev(SNAP))
    c('closeAll-scoped-to-A', a4.cards === 0 && a4.store.length === 0 && b4.store.includes(T_B) && b4.cards === 1, JSON.stringify({ a: a4, b: b4 }))
    const closedA = dbRows(T_A)
    const openB = dbRows(T_B)
    c('closeAll-soft-closed-A-only', closedA[0]?.closed_at > 0 && openB[0]?.closed_at === null, JSON.stringify({ a: closedA[0]?.closed_at, b: openB[0]?.closed_at }))

    await a.ev(`(async () => { await window.luminAPI.notifications.clearClosed(); return 'ok' })()`)
    await sleep(700)
    c('clearClosed-scoped-to-A', dbRows(T_A).length === 0 && dbRows(T_B).length === 1, JSON.stringify({ a: dbRows(T_A).length, b: dbRows(T_B).length }))

    // ── 关掉 B：它的作用域整体销毁（不给下一个占槽位的窗口留提示）──
    const bSlot = b2.slot
    await b.send('Page.close').catch(() => {})
    await sleep(1500)
    c('window-close-purges-own-scope', dbRows(T_B).length === 0, 'rows=' + dbRows(T_B).length)

    // ── 新窗口：独立且干净（不会捡到任何上一个窗口的提示）──
    cw = await openScratch(host, seen, 'C')
    const c0 = JSON.parse(await cw.ev(SNAP))
    console.log('SCRATCH C=' + JSON.stringify(c0))
    c('new-window-clean', c0.cards === 0 && c0.store.length === 0, JSON.stringify(c0))
    c('new-window-has-own-slot', c0.slot !== a1.slot && c0.slot !== bSlot, `C=${c0.slot} A=${a1.slot} B=${bSlot}`)
    c('closed-scope-stays-purged', dbRows(T_B).length === 0, 'rows=' + dbRows(T_B).length)
  } finally {
    for (const w of [a, b, cw]) {
      if (w && w.ws && w.ws.readyState === 1) await w.send('Page.close').catch(() => {})
    }
    await sleep(1200)
  }

  // ── 用户已有窗口的通知保持原样 ──
  const after = await pages()
  let untouched = true
  for (const prev of userBefore) {
    const p = after.find((x) => x.id === prev.id)
    if (!p) {
      untouched = false
      results.push('FAIL user-window-missing | ' + prev.id)
      continue
    }
    const w = connect(p.webSocketDebuggerUrl)
    await w.ready
    await w.ev(SETUP_VT)
    const now = await w.ev(SNAP)
    w.ws.close()
    if (now !== prev.snap) {
      untouched = false
      results.push('FAIL user-window-untouched | ' + prev.id + ' before=' + prev.snap + ' after=' + now)
    }
  }
  c('user-windows-untouched', untouched, 'checked=' + userBefore.length)

  // 临时窗口都应已关闭
  const leftScratch = (await pages()).filter((p) => !userBefore.some((u) => u.id === p.id))
  c('scratch-windows-closed', leftScratch.length === 0, 'left=' + leftScratch.length)

  host.ws.close()
  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
}

main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
