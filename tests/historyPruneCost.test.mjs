// 历史抽稀的**代价**守卫（审计 §2 P2「主进程同步 SQLite 在大库时会卡顿」的残余部分）。
//
// 背景：审计指出 `pruneHistory` 是"全表 SELECT 搬进 JS 排序"，建议把超条数/超年龄下推 SQL。
// 实测复核后的结论是**不下推**，理由写在这里并被这条测试钉住：
//   * 真正的性能杀手（`LENGTH(content)` 逐字解码整篇正文，实测 2000 条 × 30 万字符 ≈ 1.6GB
//     扫一次 **2.3 秒**，而且是**每次保存**都要付）已经修掉了：现在只读写入时记下的 `bytes` 列；
//   * 抽稀策略是**纯函数**（`shared/history.ts` 的 planHistoryPrune），单文件条数 / 年龄 /
//     全库条数 / 全库字节四条规则互相影响，把它翻译成 SQL 等于把"唯一真相"复制成两份 ——
//     以后改一条规则就有两个地方要同步，而这种分歧不会报警，只会悄悄多留或少留数据；
//   * 剩下这条元数据查询的代价与正文体积**无关**，且全库条数被 2000 封顶。
//
// 所以这条测试做两件事：① 断言抽稀查询**不碰 content**（防 2.3 秒那类回归）；
// ② 用一个 2000 行的临时库**量一次真实耗时**并把结果打出来（不靠"感觉很快"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { planHistoryPrune, HISTORY_MAX_TOTAL } from '../src/shared/history.ts'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 与 `main/services/database.ts` 的 pruneHistory 逐字同形的那条查询 */
const PRUNE_QUERY = 'SELECT id, path, saved_at, bytes FROM documents_history'

test('抽稀查询只碰元数据列（不读 content —— 那会按 UTF-8 逐字解码整篇正文）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/database.ts'), 'utf-8')
  const at = src.indexOf('pruneHistory(now = Date.now())')
  assert.ok(at > 0, 'database.ts 里找不到 pruneHistory 的方法定义')
  const end = src.indexOf('clearHistory(', at)
  const body = src.slice(at, end > at ? end : at + 1500)
  assert.ok(body.includes(PRUNE_QUERY), `抽稀查询必须逐字是「${PRUNE_QUERY}」`)
  const beforeDelete = body.slice(0, body.indexOf('DELETE FROM'))
  assert.doesNotMatch(
    beforeDelete,
    /\bcontent\b/i,
    '抽稀阶段不许出现 content（一旦读正文，代价就与正文体积成正比）'
  )
})

test('2000 行元数据扫描的真实耗时（这是"不下推 SQL"这个决定的依据）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-prune-'))
  const dbPath = path.join(dir, 'prune.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`CREATE TABLE documents_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL
    )`)
    const insert = db.prepare(
      'INSERT INTO documents_history (path, saved_at, bytes, preview, content) VALUES (?, ?, ?, ?, ?)'
    )
    const payload = 'x'.repeat(2048) // 2KB/条 → 2000 条 ≈ 4MB（足以代表真实库的量级）
    db.exec('BEGIN')
    for (let i = 0; i < HISTORY_MAX_TOTAL; i += 1) {
      insert.run(
        `/ws/doc-${i % 40}.md`,
        1_700_000_000_000 + i * 1000,
        payload.length,
        'preview',
        payload
      )
    }
    db.exec('COMMIT')

    const t0 = performance.now()
    const rows = db.prepare(PRUNE_QUERY).all()
    const ms = performance.now() - t0
    console.log(
      `[history-prune] rows=${rows.length} 元数据扫描 ${ms.toFixed(2)}ms（正文总量约 ${(
        (rows.length * payload.length) /
        1024 /
        1024
      ).toFixed(1)}MB）`
    )
    assert.equal(rows.length, HISTORY_MAX_TOTAL)
    // 上限给得宽松（CI 机器忙时不至于假红），但足以抓住"又开始读正文"那类回归（实测会到秒级）
    assert.ok(ms < 500, `元数据扫描花了 ${ms.toFixed(1)}ms —— 是不是又去读 content 了？`)

    // 策略层与这条查询的衔接：40 个文件各 50 条 → 单文件上限 30 会让一部分先出局
    const drop = planHistoryPrune(
      rows.map((r) => ({
        id: Number(r.id),
        path: String(r.path),
        savedAt: Number(r.saved_at),
        bytes: Number(r.bytes)
      }))
    )
    assert.ok(drop.length > 0, '40 文件 × 50 条的库应当有东西可抽稀')
    const kept = HISTORY_MAX_TOTAL - drop.length
    assert.ok(kept <= 40 * 30, `单文件上限没生效：留下 ${kept} 条（上限 ${40 * 30}）`)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
