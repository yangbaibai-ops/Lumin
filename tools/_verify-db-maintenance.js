'use strict'
// 验收：数据库维护入口（审计 §2 P1：全仓无 VACUUM / integrity_check / 重建索引入口）
//
// 判据：
//   1. `db.integrityCheck()` 在真实库上返回 ok（结构完好）；
//   2. `db.rebuildIndex()` 能把 FTS 全量重建，且重建后**搜索仍然命中**（不是把索引清空了事）；
//   3. `db.vacuum()` 返回压缩前/后字节数（before > 0、after > 0、saved ≥ 0）——
//      并顺手证明 `wal_checkpoint` 也在链路里（压缩后 -wal 不该还很大）；
//   4. `history.stats()` 现在带 `bytes`（字节口径，配合历史抽稀的字节上限）；
//   5. 设置页那三个按钮真的在（不能只做 IPC 不做入口）。
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')
const os = require('os')
const path = require('path')
const fs = require('fs')

const MD = '# 维护验收\n\n这段正文里有个独特词 zephyr-maint-4471。\n'

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('数据库维护：完整性检查 / 重建索引 / 压缩')
  const { ev } = app

  // 造一篇已保存的文档（要有 documents 行，重建索引才有东西可建）
  const ws = path.join(os.tmpdir(), 'lumin-maint-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  const doc = path.join(ws, 'maint.md')
  fs.writeFileSync(doc, MD, 'utf-8')
  await ev(
    `(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`
  )
  await sleep(700)
  await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(doc)}); return 'ok' })()`
  )
  await sleep(900)
  await ev(`(async () => { await window.__L.files().save(); return 'ok' })()`)
  await sleep(1200)

  // ① 完整性检查
  const check = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.db.integrityCheck()))()`))
  )
  report.check('integrity-check-ok', check.ok === true, JSON.stringify(check).slice(0, 160))

  // ② 重建索引 + 重建后仍能搜到
  const before = JSON.parse(
    String(
      await ev(
        `(async () => JSON.stringify(await window.luminAPI.db.search('zephyr-maint-4471', 5)))()`
      )
    )
  )
  const rebuild = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.db.rebuildIndex()))()`))
  )
  const after = JSON.parse(
    String(
      await ev(
        `(async () => JSON.stringify(await window.luminAPI.db.search('zephyr-maint-4471', 5)))()`
      )
    )
  )
  report.check(
    'rebuild-index-rewrites-and-keeps-search-working',
    rebuild.rebuilt >= 1 && before.length >= 1 && after.length >= 1,
    JSON.stringify({ rebuilt: rebuild.rebuilt, before: before.length, after: after.length })
  )

  // ③ 压缩：返回真实字节数
  const vacuum = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.db.vacuum()))()`))
  )
  report.check(
    'vacuum-reports-bytes',
    vacuum.before > 0 && vacuum.after > 0 && vacuum.saved >= 0,
    JSON.stringify(vacuum)
  )
  // 压缩后 -wal 不该还很大（wal_checkpoint 真的跑了）
  const dbPath = path.join(process.env.LUMIN_ISOLATED_USERDATA || '', 'lumin.db')
  const walBytes = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0
  report.check(
    'vacuum-checkpoints-wal',
    walBytes < 512 * 1024,
    JSON.stringify({ walBytes, dbPath })
  )

  // ④ 历史占用带字节
  const hist = JSON.parse(
    String(await ev(`(async () => JSON.stringify(await window.luminAPI.history.stats()))()`))
  )
  report.check(
    'history-stats-include-bytes',
    typeof hist.bytes === 'number' && hist.entries >= 0 && hist.files >= 0,
    JSON.stringify(hist)
  )

  // ⑤ 设置页的入口
  const buttons = JSON.parse(
    String(
      await ev(`(async () => {
        window.__L.ui().openSettings('general')
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 150))
          if (document.querySelector('[data-db-check]')) break
        }
        const ids = ['check', 'reindex', 'vacuum']
        const found = ids.filter((id) => !!document.querySelector('[data-db-' + id + ']'))
        window.__L.ui().closeSettings()
        return JSON.stringify({ found })
      })()`)
    )
  )
  report.check(
    'settings-has-db-maintenance-entries',
    buttons.found.length === 3,
    JSON.stringify(buttons)
  )

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
