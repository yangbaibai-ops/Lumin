// 验收（磁盘侧）：通知确实写进了 lumin.db（而不是只存在内存/会话里）
// 用 node:sqlite 直接读应用数据库文件，核对表结构、行内容与软关闭标记。
const path = require('path')
const os = require('os')
const { DatabaseSync } = require('node:sqlite')
const CDP = 'http://127.0.0.1:9222/json'
const DB = path.join(os.homedir(), 'AppData', 'Roaming', 'lumin', 'lumin.db')
const MARK = '磁盘持久化验校-' + Date.now()
let ws, id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) { return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value }

function readDbRows() {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const cols = db.prepare('PRAGMA table_info(notifications)').all().map((r) => r.name)
    const row = db.prepare('SELECT id, level, title, body, merge_key, created_at, closed_at FROM notifications WHERE title = ?').get(MARK)
    return { cols, row }
  } finally {
    db.close()
  }
}

;(async () => {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')

  const created = JSON.parse(await ev(`(async () => JSON.stringify(await window.luminAPI.notifications.add({ level: 'warning', title: ${JSON.stringify(MARK)}, body: '这条应当能从磁盘读到' })))()`))
  await sleep(400)
  const open = readDbRows()
  console.log('ROWS(open) ' + JSON.stringify({ cols: open.cols, row: open.row }))

  await ev(`window.luminAPI.notifications.close(${created.id})`)
  await sleep(400)
  const closed = readDbRows()
  console.log('ROWS(closed) ' + JSON.stringify({ closedAt: closed.row?.closed_at ?? null }))

  // 清理：硬删（通知中心里已关闭的行随后也会被 clearClosed 清掉）
  await ev(`(async () => { await window.luminAPI.notifications.remove(${created.id}); await window.luminAPI.notifications.clearClosed(); return 'ok' })()`)
  await sleep(300)
  const gone = readDbRows()
  const left = await ev(`(async () => (await window.luminAPI.notifications.list({ includeClosed: true })).length)()`)

  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('db-file-exists', open.cols.length > 0, DB)
  c('schema-complete', ['id', 'level', 'title', 'body', 'merge_key', 'created_at', 'closed_at'].every((x) => open.cols.includes(x)), JSON.stringify(open.cols))
  c('row-on-disk', open.row?.title === MARK && open.row?.level === 'warning' && open.row?.body === '这条应当能从磁盘读到', JSON.stringify(open.row))
  c('soft-close-on-disk', typeof closed.row?.closed_at === 'number' && closed.row.closed_at > 0, 'closed_at=' + closed.row?.closed_at)
  c('hard-delete-on-disk', !gone.row && left === 0, JSON.stringify({ gone: !!gone.row, left }))
  console.log(results.join('\n'))
  ws.close()
})().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
