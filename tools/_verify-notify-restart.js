// 验收（跨重启持久化 + 隔离）：在临时窗口里产生的通知，硬杀进程重启后
// 回到**同一个窗口**（按会话槽位重建），且不会出现在别的窗口。
//
// 两阶段执行（重启由外部完成，套件不自己杀进程）：
//   node tools/_verify-notify-restart.js seed     # 建临时窗口 + 造一条通知
//   <杀掉 electron 并重启 dev server>
//   node tools/_verify-notify-restart.js check    # 复核恢复结果并清理
//
// 不读写用户已开窗口的通知；清理阶段会关掉临时窗口（主进程随之清掉其作用域）。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { DatabaseSync } = require('node:sqlite')
const CDP = 'http://127.0.0.1:9222/json'
const DB = path.join(os.homedir(), 'AppData', 'Roaming', 'lumin', 'lumin.db')
const STATE = path.join(os.tmpdir(), 'lumin-notify-restart.json')
/** 临时窗口里要打开的文档：用工作区里已存在、且已在最近文档里的文件（只读打开，不写盘） */
const USER_DOC = 'D:\\code_workspace\\Lumin-test-workspace\\000.md'
const PHASE = process.argv[2]
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
  const pinia = app._context.provides[sym]
  window.__vt = { ui: () => pinia._s.get('ui'), notif: () => pinia._s.get('notifications'), files: () => pinia._s.get('files') }
  return 'ok'
})()`
const SNAP = `(() => JSON.stringify({
  slot: window.luminAPI.app.sessionSlot,
  doc: window.__vt.files ? window.__vt.files().current?.path ?? null : null,
  store: window.__vt.notif().items.map((n) => n.title),
  cards: document.querySelectorAll('.ntf-card').length,
  cardTitle: document.querySelector('.ntf-card p')?.textContent?.trim() ?? null
}))()`

const pages = async () =>
  (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && t.url.includes('5173'))

function dbRows(title) {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    return db.prepare('SELECT id, scope, title, closed_at FROM notifications WHERE title = ?').all(title)
  } finally {
    db.close()
  }
}

async function attachAll() {
  const out = []
  for (const p of await pages()) {
    const c = connect(p.webSocketDebuggerUrl)
    await c.ready
    await c.send('Page.enable')
    for (let i = 0; i < 60; i++) {
      if ((await c.ev(SETUP_VT)) === 'ok') break
      await sleep(300)
    }
    c.id = p.id
    out.push(c)
  }
  return out
}

/** 读 kv.session 的槽位占用（用来确认「重启前槽位确实落盘了」） */
function kvSlot(index) {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'session'").get()
    const state = row ? JSON.parse(row.value) : { slots: [] }
    return state.slots[index] ?? null
  } finally {
    db.close()
  }
}

async function seed() {
  const all = await attachAll()
  if (!all.length) throw new Error('没有可用窗口')
  const seen = new Set(all.map((x) => x.id))
  const host = all[0]
  const title = '重启持久化验证-' + Date.now()
  await host.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  let page = null
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    page = (await pages()).find((p) => !seen.has(p.id))
    if (page) break
  }
  if (!page) throw new Error('临时窗口未出现')
  const w = connect(page.webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    if ((await w.ev(SETUP_VT)) === 'ok' && (await w.ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready') break
  }
  await w.ev(SETUP_VT)
  await sleep(600)
  // 先在临时窗口里打开一份已存在的文档：会话跟踪只在「文档/光标变化」时才落盘，
  // 一个完全没动过的空白窗口本来就没有会话可恢复（这是既有语义，不是本次改动）。
  const docOpened = await w.ev(
    `(async () => { const app = document.querySelector('#app').__vue_app__; const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)'); const f = app._context.provides[sym]._s.get('files'); return String(await f.openPath(${JSON.stringify(USER_DOC)})); })()`
  )
  await sleep(1800)
  await w.ev(
    `(async () => { await window.__vt.notif().notify({ level: 'info', title: ${JSON.stringify(title)}, body: '重启后应回到这个窗口' }); return 'ok' })()`
  )
  await sleep(1200)
  const snap = JSON.parse(await w.ev(SNAP))
  const rows = dbRows(title)
  const kv = kvSlot(snap.slot)
  fs.writeFileSync(STATE, JSON.stringify({ slot: snap.slot, title, windowId: page.id, doc: USER_DOC }, null, 2))
  console.log('SEEDED ' + JSON.stringify({ slot: snap.slot, title, cards: snap.cards, row: rows[0], kvSlot: kv }))
  const ok =
    docOpened === 'true' &&
    snap.store.includes(title) &&
    snap.cards === 1 &&
    rows.length === 1 &&
    rows[0].scope === 'w' + snap.slot &&
    kv?.path === USER_DOC
  console.log((ok ? 'PASS' : 'FAIL') + ' seed-notification-and-slot-persisted | ' + JSON.stringify({ docOpened, snap, rows, kv }))
  // 临时窗口保持开着（不要关！关掉会清槽位与作用域），交给重启流程
  for (const c of all) c.ws.close()
  w.ws.close()
  if (!ok) process.exit(1)
}

async function check() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const { slot, title } = state
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  const all = await attachAll()
  const snaps = []
  for (const w of all) snaps.push({ id: w.id, ...JSON.parse(await w.ev(SNAP)) })
  console.log('SNAPS ' + JSON.stringify(snaps))

  const target = snaps.find((s) => s.slot === slot)
  c('window-restored-with-same-slot', !!target, `slot=${slot} windows=${JSON.stringify(snaps.map((s) => s.slot))}`)
  c('document-restored-too', target?.doc === USER_DOC, JSON.stringify(target?.doc ?? null))
  c('notification-restored-in-that-window', !!target && target.store.includes(title) && target.cards === 1, JSON.stringify(target))
  c('other-windows-not-showing-it', snaps.filter((s) => s.slot !== slot).every((s) => !s.store.includes(title)), JSON.stringify(snaps.filter((s) => s.slot !== slot).map((s) => s.store)))
  c('row-still-scoped', dbRows(title)[0]?.scope === 'w' + slot, JSON.stringify(dbRows(title)))

  // 清理：关掉临时窗口 → 槽位与通知作用域一起销毁
  const tw = all.find((w) => w.id === target?.id)
  if (tw) await tw.send('Page.close').catch(() => {})
  await sleep(1500)
  c('rows-purged-after-close', dbRows(title).length === 0, 'rows=' + dbRows(title).length)
  for (const w of all) if (w !== tw) w.ws.close()
  fs.rmSync(STATE, { force: true })

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  if (failed) process.exit(1)
}

const phase = PHASE === 'seed' ? seed : PHASE === 'check' ? check : null
if (!phase) {
  console.error('用法: node tools/_verify-notify-restart.js seed|check')
  process.exit(1)
}
phase().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
