// 验收（磁盘侧）：通知确实写进了 lumin.db（而不是只存在内存/会话里），
// 并且带上产生它的窗口作用域（scope = w<会话槽位>）。
// 用 node:sqlite 直接读应用数据库文件，核对表结构、行内容、作用域与软关闭标记。
// 全程在自建临时窗口里进行，不打扰用户已开的窗口。
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')
const CDP = 'http://127.0.0.1:9222/json'
const DB = process.env.LUMIN_DB || path.join(os.homedir(), 'AppData', 'Roaming', 'lumin', 'lumin.db')
const MARK = '磁盘持久化验校-' + Date.now()
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

function readDbRows() {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const cols = db.prepare('PRAGMA table_info(notifications)').all().map((r) => r.name)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications'")
      .all()
      .map((r) => r.name)
    const row = db
      .prepare('SELECT id, scope, level, title, body, merge_key, created_at, closed_at FROM notifications WHERE title = ?')
      .get(MARK)
    return { cols, indexes, row }
  } finally {
    db.close()
  }
}

async function pages() {
  return (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
}

;(async () => {
  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const host = connect(all[0].webSocketDebuggerUrl)
  await host.ready
  await host.send('Page.enable')

  // 自建临时窗口：用户窗口不会被写入任何通知
  await host.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
  let page = null
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    const fresh = (await pages()).find((p) => !seen.has(p.id))
    if (fresh) {
      page = fresh
      break
    }
  }
  if (!page) {
    console.log('SKIP: 临时窗口未出现')
    host.ws.close()
    return
  }
  const w = connect(page.webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    if (await w.ev(`document.querySelector('#app')?.__vue_app__ ? 'ok' : 'no-app'`)) {
      if ((await w.ev(`window.luminAPI?.notifications ? 'ok' : 'no'`)) === 'ok') break
    }
  }
  const slot = await w.ev(`window.luminAPI.app.sessionSlot`)
  await sleep(600)

  const created = JSON.parse(await w.ev(`(async () => JSON.stringify(await window.luminAPI.notifications.add({ level: 'warning', title: ${JSON.stringify(MARK)}, body: '这条应当能从磁盘读到' })))()`))
  await sleep(400)
  const open = readDbRows()
  console.log('ROWS(open) ' + JSON.stringify({ cols: open.cols, row: open.row }))

  await w.ev(`window.luminAPI.notifications.close(${created.id})`)
  await sleep(400)
  const closed = readDbRows()
  console.log('ROWS(closed) ' + JSON.stringify({ closedAt: closed.row?.closed_at ?? null }))

  // 清理：硬删（通知中心里已关闭的行随后也会被 clearClosed 清掉）
  await w.ev(`(async () => { await window.luminAPI.notifications.remove(${created.id}); await window.luminAPI.notifications.clearClosed(); return 'ok' })()`)
  await sleep(300)
  const gone = readDbRows()
  const left = await w.ev(`(async () => (await window.luminAPI.notifications.list({ includeClosed: true })).length)()`)

  // 关掉临时窗口：该窗口作用域的行应被整体清掉（通知跟着窗口走）
  await w.send('Page.close').catch(() => {})
  await sleep(1500)
  const afterClose = readDbRows()
  host.ws.close()

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('db-file-exists', open.cols.length > 0, DB)
  c('schema-complete', ['id', 'scope', 'level', 'title', 'body', 'merge_key', 'created_at', 'closed_at'].every((x) => open.cols.includes(x)), JSON.stringify(open.cols))
  c('scope-index-exists', open.indexes.includes('idx_notifications_scope_open'), JSON.stringify(open.indexes))
  c('row-on-disk', open.row?.title === MARK && open.row?.level === 'warning' && open.row?.body === '这条应当能从磁盘读到', JSON.stringify(open.row))
  c('row-scoped-to-window', open.row?.scope === 'w' + slot, `scope=${open.row?.scope} slot=${slot}`)
  c('soft-close-on-disk', typeof closed.row?.closed_at === 'number' && closed.row.closed_at > 0, 'closed_at=' + closed.row?.closed_at)
  c('hard-delete-on-disk', !gone.row && left === 0, JSON.stringify({ gone: !!gone.row, left }))
  c('rows-purged-on-window-close', !afterClose.row, JSON.stringify(afterClose.row ?? null))
  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
