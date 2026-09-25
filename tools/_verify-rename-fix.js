// 验收：重命名时 documents.path UNIQUE 冲突修复
//
// 背景（用户实际遇到）：把 A 文件重命名为 B 时，若 B 这个路径**在索引里还留着旧行**
// （同名文件以前打开过、或在外部被删除后索引没清），`UPDATE documents SET path=?`
// 会撞 path 的 UNIQUE 约束 → 整个重命名失败，界面弹「重命名失败」。
// 修复：索引只是「打开过的文件」的缓存，改路径前先清掉目标路径的旧行（含其 FTS 行）。
//
// 用例：造出「目标路径有陈旧索引行」的真实场景 → 重命名必须成功 →
//       磁盘内容正确迁移 → 索引里只剩一行且全文检索可用。
const CDP = 'http://127.0.0.1:9222/json'
const fs = require('fs')
const path = require('path')
const os = require('os')

// 夹具必须放在**工作区内**：file:rename 走 assertWorkspacePath（防路径遍历），
// 工作区外的路径会被正确拒绝（PATH_OUTSIDE_WORKSPACE），那是另一条规则。
const DIR_NAME = 'lumin-verify-rename'
let DIR = ''
let A = ''
let B = ''
const CONTENT = '# 重命名验收\n\n正文内容 ABC\n'

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
    return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }
  return r.result?.result?.value
}
const rowsFor = (p) =>
  `(async () => JSON.stringify(await window.luminAPI.db.getDocument(${JSON.stringify(p)})))()`

async function main() {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const targets = (await (await fetch(CDP)).json()).filter(
    (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
  )
  if (!targets.length) {
    console.log('NO-APP-PAGE')
    return
  }
  const opener = targets[0]
  // 另开窗口跑，避免碰用户窗口里正在编辑的文档
  const tmp = new WebSocket(opener.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    tmp.onopen = res
    tmp.onerror = rej
  })
  let oid = 0
  const opending = new Map()
  tmp.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && opending.has(m.id)) {
      opending.get(m.id)(m)
      opending.delete(m.id)
    }
  }
  const osend = (method, params) =>
    new Promise((r) => {
      const i = ++oid
      opending.set(i, r)
      tmp.send(JSON.stringify({ id: i, method, params }))
    })
  await osend('Runtime.evaluate', {
    expression: '(window.luminAPI.app.newWindow(), "ok")',
    returnByValue: true
  })
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(400)
    const list = (await (await fetch(CDP)).json()).filter(
      (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
    )
    page = list.find((p) => p.id !== opener.id) ?? null
  }
  tmp.close()
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
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }

  // ── 夹具目录：必须落在工作区内（file:rename 有工作区校验）────────────────
  // 没开工作区就**自己开一个**（夹具放 %TEMP% 下）：原来直接 SKIP → 0 断言 →
  // 运行器记 NOASSERT（"没产出断言等于没测"）。套件要自足，不能赌上一条套件的状态。
  let root = await ev(`(async () => await window.luminAPI.workspace.getRoot())()`)
  if (!root || typeof root !== 'string') {
    root = path.join(os.tmpdir(), 'lumin-verify-rename-ws')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    await ev(
      `(async () => { await window.luminAPI.workspace.setRoot(${JSON.stringify(root)}); return 'ok' })()`
    )
    await sleep(600)
    const check = await ev(`(async () => await window.luminAPI.workspace.getRoot())()`)
    if (check !== root) {
      console.log(`SKIP: 工作区无法建立（file:rename 受工作区校验保护）；getRoot=${check}`)
      await send('Page.close').catch(() => {})
      ws.close()
      return
    }
  }
  DIR = path.join(root, DIR_NAME)
  A = path.join(DIR, 'a-source.md')
  B = path.join(DIR, 'b-target.md')
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(A, CONTENT, 'utf-8')
  console.log('WORKSPACE ' + root)
  console.log('FIXTURES ' + DIR)

  const queryDb = (fn) => {
    const { DatabaseSync } = require('node:sqlite')
    // 同 _verify-editor-menu-extras：路径要跟着被测实例走（运行器把真实路径放在 LUMIN_DB）
    const dbPath = process.env.LUMIN_DB || path.join(process.env.APPDATA, 'lumin', 'lumin.db')
    const db = new DatabaseSync(dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }
  const dumpIndex = () =>
    queryDb((db) => ({
      rows: db
        .prepare("SELECT id, path FROM documents WHERE path LIKE '%lumin-verify-rename%'")
        .all(),
      fts: db
        .prepare(
          "SELECT rowid, title FROM documents_fts WHERE title LIKE '%source%' OR title LIKE '%target%'"
        )
        .all()
    }))

  // ── 造场景：源与目标都进过索引，随后目标文件被外部删除 ───────────────────
  // 真实的报错场景：A 行（正在编辑/打开过的文件）+ B 行（同名文件以前打开过、
  // 文件已被删除但索引没清）。此时 UPDATE documents SET path=B WHERE path=A
  // 就会撞 documents.path 的 UNIQUE 约束。
  fs.writeFileSync(B, '# 旧内容\n', 'utf-8')
  await ev(`window.luminAPI.file.read(${JSON.stringify(A)}).then(() => 'ok')`)
  await ev(`window.luminAPI.file.read(${JSON.stringify(B)}).then(() => 'ok')`)
  await sleep(400)
  fs.rmSync(B, { force: true })
  const before = dumpIndex()
  console.log('index-before ' + JSON.stringify(before))
  c(
    'both-rows-indexed',
    before.rows.length === 2,
    JSON.stringify(before.rows.map((r) => r.path.split('\\').pop()))
  )
  c('target-file-absent', fs.existsSync(B) === false)

  // ── 机制证明：用事务模拟「不加处理的直接改路径」，必须撞 UNIQUE（跑完回滚）──
  const rawConflict = queryDb((db) => {
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE documents SET path = ? WHERE path = ?').run(B, A)
      return 'no-conflict'
    } catch (e) {
      return 'UNIQUE: ' + String(e.message).slice(0, 80)
    } finally {
      db.exec('ROLLBACK')
    }
  })
  console.log('raw-conflict ' + rawConflict)
  c('raw-update-conflicts', rawConflict.startsWith('UNIQUE'), rawConflict)

  // ── 重命名：修复前这里会抛 UNIQUE constraint failed ─────────────────────
  const renameResult = await ev(
    `(async () => { try { await window.luminAPI.file.rename(${JSON.stringify(A)}, ${JSON.stringify(B)}); return 'ok' } catch (e) { return 'ERR ' + (e?.message ?? String(e)) } })()`
  )
  console.log('rename ' + JSON.stringify(renameResult))
  console.log('index-after-rename ' + JSON.stringify(dumpIndex()))
  c('rename-succeeds', renameResult === 'ok', String(renameResult))

  // ── 磁盘与索引状态 ───────────────────────────────────────────────────────
  const onDisk = fs.existsSync(B) && fs.readFileSync(B, 'utf-8') === CONTENT
  const oldGone = fs.existsSync(A) === false
  const rowB = (await ev(rowsFor(B))) || ''
  const rowA = (await ev(rowsFor(A))) || ''
  const all =
    (await ev(`(async () => JSON.stringify(await window.luminAPI.db.listRecent(200)))()`)) || '[]'
  const dupes = JSON.parse(String(all)).filter((d) => d.path === B).length
  console.log(
    'after ' +
      JSON.stringify({
        onDisk,
        oldGone,
        rowB: String(rowB).slice(0, 80),
        rowA: String(rowA).slice(0, 40),
        dupes
      })
  )
  c('content-moved-on-disk', onDisk === true)
  c('old-path-gone-on-disk', oldGone === true)
  c(
    'index-has-new-path-only',
    String(rowB).includes('b-target.md') && rowA === 'null',
    `A=${String(rowA).slice(0, 40)}`
  )
  c('index-has-no-duplicate-rows', dupes === 1, 'dupes=' + dupes)

  // 全文检索：重命名后再保存一次，索引必须能检索到新路径（证明 FTS 行没被写坏/重复）
  await ev(
    `window.luminAPI.file.write(${JSON.stringify(B)}, ${JSON.stringify(CONTENT)}).then(() => 'ok')`
  )
  await sleep(400)
  const search =
    (await ev(
      `(async () => JSON.stringify(await window.luminAPI.db.search('重命名验收', 5)))()`
    )) || '[]'
  console.log('search ' + String(search).slice(0, 200))
  c('fts-works-after-rename', String(search).includes('b-target.md'), String(search).slice(0, 160))

  // ── 复原 ─────────────────────────────────────────────────────────────────
  await ev(`window.luminAPI.db.deleteDocument(${JSON.stringify(B)}).catch(() => {})`)
  await ev(`window.__vt?.notifications?.().closeAll?.()`).catch?.()
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await send('Page.close').catch(() => {})
  await sleep(400)
  fs.rmSync(DIR, { recursive: true, force: true })
  ws.close()

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`)
  if (failed) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
