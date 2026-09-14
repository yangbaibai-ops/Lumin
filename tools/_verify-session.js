// 验收：会话恢复（重启回到上次的文档 + 光标 + 滚动位置）
//
// 为什么用「页面 reload」当作重启：窗口的会话槽位是通过 additionalArguments
// （--lumin-session-slot=N）传给渲染进程的，reload 会原样重跑渲染进程的启动流程
// （preload 重新解析 argv → bootstrap → restoreSession），因此这正是会话恢复的
// 真实路径，且不必杀掉整个应用。
//
// 覆盖：
//  A. 槽位：新窗口自动领取槽位；路径/光标/滚动比例写进 SQLite kv
//  B. reload 后：文档、光标、滚动进度、路由全部恢复
//  C. 设置开关：restoreSession=false → reload 进欢迎页；重新打开 → 又恢复
//  D. 文件丢失：磁盘上删掉后 reload → 告警通知 + 不阻塞启动
//  E. 单独关窗：窗口关闭后它的槽位被清空（不参与下次启动的窗口重建）
//  F. 复原：会话表、夹具目录
const CDP = 'http://127.0.0.1:9222/json'
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR_NAME = 'lumin-verify-session'
const LINES = Array.from({ length: 160 }, (_, i) => `第 ${i + 1} 行内容，用于制造可滚动的长文档。`)
const MD = ['# 会话恢复验收', '', ...LINES, '', '结尾段落'].join('\n')

let DIR = ''
let DOC = ''
let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const appPages = async () =>
  (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && t.url.includes('5173'))

async function attach(page) {
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = rej
  })
  let n = 0
  const waiters = new Map()
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m)
      waiters.delete(m.id)
    }
  }
  const s = (method, params) =>
    new Promise((r) => {
      const i = ++n
      waiters.set(i, r)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  const e = async (expr) => {
    const r = await s('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200)
    return r.result?.result?.value
  }
  return { sock, send: s, ev: e }
}

/** 页面侧注入便捷访问器（reload 会清掉，需在每次 reload 后重新注入） */
const INJECT = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'NO_APP'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
  window.__L = {
    files: () => pinia._s.get('files'),
    settings: () => pinia._s.get('settings'),
    notifications: () => pinia._s.get('notifications'),
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`

/** 等启动完成（#app 挂载 + 骨架屏结束）后重新注入访问器 */
async function settle(e, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await e(`(() => {
      const app = document.querySelector('#app')?.__vue_app__
      if (!app) return false
      const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
      return app._context.provides[sym]._s.get('ui').booting === false
    })()`)
    if (ok === true) {
      await e(INJECT)
      return true
    }
    await sleep(200)
  }
  return false
}

/** 页面侧状态：路由、文档、PM 光标、滚动进度、槽位、开关 */
const STATE = `(() => {
  const f = window.__L.files()
  const ed = window.__L.ed()
  const el = ed?.view?.dom ? ed.view.dom.closest('.editor-scroll') : null
  const max = el ? el.scrollHeight - el.clientHeight : 0
  return JSON.stringify({
    hash: location.hash,
    path: f.current?.path ?? null,
    dirty: !!f.dirty,
    pos: ed ? ed.state.selection.from : null,
    size: ed ? ed.state.doc.content.size : null,
    scrollRatio: el && max > 0 ? Number((el.scrollTop / max).toFixed(3)) : 0,
    slot: window.luminAPI.app.sessionSlot,
    restoreSession: window.__L.settings().restoreSession
  })
})()`

/** 直读 SQLite 用的库路径：默认用户真实 userData；用 --user-data-dir 起隔离实例时
 *  用 LUMIN_DB 指定，套件才能跑在隔离数据上（不碰用户正在用的库）。 */
const DB_PATH = process.env.LUMIN_DB || path.join(process.env.APPDATA, 'lumin', 'lumin.db')
function readKvSession() {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = db.prepare("SELECT value FROM kv WHERE key = 'session'").get()
  db.close()
  return row ? JSON.parse(row.value) : { slots: [] }
}
function writeKvSession(state) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES ('session', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(JSON.stringify(state), Date.now())
  db.close()
}

async function main() {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const before = await appPages()
  if (!before.length) {
    console.log('NO-APP-PAGE')
    return
  }
  const sessionBackup = readKvSession()
  console.log('SESSION-BACKUP ' + JSON.stringify(sessionBackup).slice(0, 200))

  // 夹具放工作区内（与用户环境一致；无工作区则退回系统临时目录）
  const opener = await attach(before[0])
  // 打开夹具会把路径写进 recentFiles，跑完要还原（否则用户「最近文档」被测试数据污染）
  const recentBackup = await opener.ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'null'
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    return JSON.stringify(app._context.provides[sym]._s.get('settings').recentFiles ?? [])
  })()`)
  const root = await opener.ev(`(async () => await window.luminAPI.workspace.getRoot())()`)
  DIR = path.join(typeof root === 'string' && root ? root : os.tmpdir(), DIR_NAME)
  DOC = path.join(DIR, 'long.md')
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(DOC, MD, 'utf-8')
  console.log('FIXTURE ' + DOC)

  // 开新窗口（自动领取槽位）
  const known = before.map((p) => p.id)
  await opener.send('Runtime.evaluate', {
    expression: '(window.luminAPI.app.newWindow(), "ok")',
    returnByValue: true
  })
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(400)
    page = (await appPages()).find((p) => !known.includes(p.id)) ?? null
  }
  opener.sock.close()
  if (!page) {
    console.log('SKIP: 第二个窗口未出现')
    return
  }
  console.log('（在第二个窗口里验收，用户窗口不受影响）')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
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
  await send('Page.enable')
  await send('Page.bringToFront')
  await settle(ev)

  const s0 = JSON.parse(await ev(STATE))
  console.log('A0 ' + JSON.stringify(s0))
  c('new-window-has-slot', typeof s0.slot === 'number' && s0.slot >= 0, 'slot=' + s0.slot)

  // ── A. 打开文档 → 落光标/滚动 → 节流写回槽位 ─────────────────────────────
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(500)
  await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(DOC)}); return 'ok' })()`
  )
  await sleep(1300)
  const placed = JSON.parse(
    await ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const size = ed.state.doc.content.size
      const target = Math.round(size * 0.5)
      ed.commands.setTextSelection(target)
      const el = ed.view.dom.closest('.editor-scroll')
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.round(max * 0.6)
      el.dispatchEvent(new Event('scroll'))
      return JSON.stringify({ target, size, max, scrollTop: Math.round(el.scrollTop) })
    })()`)
  )
  console.log('A1 ' + JSON.stringify(placed))
  await sleep(1500) // 超过 800ms 节流
  const slot = readKvSession().slots[s0.slot]
  console.log('A2-slot ' + JSON.stringify(slot))
  c('slot-saved-path', slot?.path === DOC, JSON.stringify({ want: DOC, got: slot?.path }))
  c(
    'slot-saved-cursor-near-middle',
    typeof slot?.pos === 'number' && Math.abs(slot.pos - placed.target) < placed.size * 0.1,
    JSON.stringify({ pos: slot?.pos, target: placed.target })
  )
  c(
    'slot-saved-scroll-ratio',
    typeof slot?.scrollRatio === 'number' && Math.abs(slot.scrollRatio - 0.6) < 0.15,
    'ratio=' + slot?.scrollRatio
  )

  // ── B. reload（= 渲染进程重启）后恢复 ────────────────────────────────────
  await send('Page.reload')
  await sleep(1500)
  await settle(ev)
  await sleep(1000)
  const s1 = JSON.parse(await ev(STATE))
  console.log('B ' + JSON.stringify(s1))
  c('restore-opens-document', s1.path === DOC, String(s1.path))
  c('restore-keeps-route', s1.hash.includes('/editor'), s1.hash)
  c(
    'restore-cursor-position',
    typeof s1.pos === 'number' &&
      Math.abs(s1.pos - placed.target) < Math.max(60, placed.size * 0.06),
    JSON.stringify({ pos: s1.pos, want: placed.target })
  )
  c(
    'restore-scroll-position',
    Math.abs(s1.scrollRatio - 0.6) < 0.18,
    JSON.stringify({ got: s1.scrollRatio, want: 0.6 })
  )
  c(
    'tracking-installed-after-restore',
    s1.restoreSession === true,
    'restoreSession=' + s1.restoreSession
  )

  // ── C. 开关：关 → 进欢迎页；开着时打开文档 → 再打开开关 → 又恢复 ─────────
  // 语义（主流同款）：会话记录的是「当前状态」。关掉恢复后应用停在欢迎页/未命名
  // 缓冲区，该窗口的会话随之被写成「无文档」——所以「关→开」不会凭空找回旧文档；
  // 要验证开关另一向，需先打开文档（会话随即记录）再把开关打开，然后 reload。
  await ev(`(() => { window.__L.settings().set('restoreSession', false); return 'ok' })()`)
  await sleep(600)
  await send('Page.reload')
  await sleep(1500)
  await settle(ev)
  await sleep(700)
  const s2 = JSON.parse(await ev(STATE))
  console.log('C-off ' + JSON.stringify(s2))
  c('toggle-off-shows-welcome', s2.path === null, String(s2.path))

  await ev(
    `(async () => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; await new Promise((r) => setTimeout(r, 400)); await window.__L.files().openPath(${JSON.stringify(DOC)}); return 'ok' })()`
  )
  await sleep(1500)
  const slotWhileOff = readKvSession().slots[s0.slot]
  await ev(`(() => { window.__L.settings().set('restoreSession', true); return 'ok' })()`)
  await sleep(600)
  await send('Page.reload')
  await sleep(1500)
  await settle(ev)
  await sleep(1000)
  const s3 = JSON.parse(await ev(STATE))
  console.log(
    'C-on ' + JSON.stringify({ slotWhileOff: slotWhileOff?.path ?? null, state: s3.path })
  )
  c('session-recorded-while-disabled', slotWhileOff?.path === DOC, String(slotWhileOff?.path))
  c('toggle-on-restores-again', s3.path === DOC, String(s3.path))

  // ── D. 文件丢失：告警 + 不阻塞启动 ───────────────────────────────────────
  fs.rmSync(DOC, { force: true })
  await send('Page.reload')
  await sleep(1500)
  await settle(ev)
  await sleep(1000)
  const s4 = JSON.parse(await ev(STATE))
  const notif = await ev(
    `(() => JSON.stringify(window.__L.notifications().items.map((n) => n.level + ':' + n.title)))()`
  )
  console.log('D ' + JSON.stringify({ path: s4.path, notif: String(notif).slice(0, 160) }))
  c('missing-file-does-not-open', s4.path !== DOC, String(s4.path))
  c(
    'missing-file-notifies',
    String(notif).includes('无法恢复上次的文档'),
    String(notif).slice(0, 120)
  )

  // ── E. 单独关窗 → 槽位清空 ───────────────────────────────────────────────
  const cur = readKvSession()
  const slots = cur.slots.slice()
  while (slots.length <= s0.slot) slots.push(null)
  slots[s0.slot] = { path: DOC, pos: 10, len: 20, scrollRatio: 0.5, savedAt: Date.now() }
  writeKvSession({ slots })
  const slotBefore = readKvSession().slots[s0.slot]
  const closer = await attach(page)
  await closer.send('Page.close').catch(() => {})
  await sleep(1000)
  closer.sock.close()
  const slotAfter = readKvSession().slots[s0.slot] ?? null
  console.log('E ' + JSON.stringify({ before: slotBefore?.path ?? null, after: slotAfter }))
  c(
    'closing-window-clears-slot',
    slotBefore !== null && slotAfter === null,
    JSON.stringify(slotAfter)
  )

  // ── F. 复原 ──────────────────────────────────────────────────────────────
  writeKvSession(sessionBackup)
  fs.rmSync(DIR, { recursive: true, force: true })
  // 还原 recentFiles（用用户窗口的 store 写回，顺带清掉夹具条目）
  if (recentBackup && recentBackup !== 'null') {
    const o = await attach(before[0])
    await o.ev(`(() => {
      const app = document.querySelector('#app')?.__vue_app__
      if (!app) return 'ok'
      const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
      app._context.provides[sym]._s.get('settings').set('recentFiles', ${recentBackup})
      return 'ok'
    })()`)
    o.sock.close()
    await sleep(500)
  }
  for (const p of await appPages()) {
    const o = await attach(p)
    await o.ev(`(async () => {
      const app = document.querySelector('#app')?.__vue_app__
      if (!app) return 'ok'
      const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
      const store = app._context.provides[sym]._s.get('notifications')
      for (const n of store.items.filter((x) => x.title.includes('无法恢复上次的文档'))) {
        await window.luminAPI.notifications.close(n.id)
      }
      await store.hydrate()
      return 'ok'
    })()`)
    o.sock.close()
  }
  const restored = readKvSession()
  console.log('F-restored ' + JSON.stringify(restored).slice(0, 160))
  c(
    'session-table-restored',
    JSON.stringify(restored) === JSON.stringify(sessionBackup),
    JSON.stringify(restored).slice(0, 120)
  )

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`)
  ws.close()
  if (failed) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
