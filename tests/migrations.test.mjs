// ─── 数据库版本化迁移（自查报告 S4）──────────────────────────────────────────
//
// 为什么单测要自己建库：`services/migrations.ts` 刻意**不 import electron**，只吃
// `node:sqlite` 的 db 句柄 —— 于是这里能用临时库把「空库 / 老库 / 重复跑 / 一次性数据迁移」
// 四种情形在毫秒级验完，不必启动应用、也不必碰用户真实库。
//
// 口径（与 tools/ 的约定一致）：**不许只打印不断言**；每个 test 都必须有 assert。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations
} from '../src/main/services/migrations.ts'

/** 建一个临时库文件（跑完删掉） */
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-mig-'))
  const db = new DatabaseSync(path.join(dir, 'lumin.db'))
  return {
    db,
    done() {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all()
    .map((r) => r.name)

const columnsOf = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)

const metaCols = (db) =>
  columnsOf(db, 'documents').filter((c) => ['encoding', 'eol', 'had_bom'].includes(c))

test('空库跑一遍：写到当前版本、六张表全在、FTS 用 trigram 分词器', () => {
  const t = tempDb()
  try {
    const res = runMigrations(t.db)
    assert.equal(res.from, 0, '空库的 user_version 应当是 0')
    // 空库要把**全部**步骤跑一遍（从 SCHEMA_VERSION 推，避免每加一步都来改这条断言）
    assert.deepEqual(
      res.ran,
      Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
      '空库应当从 migration 1 一路跑到当前版本'
    )
    assert.equal(readSchemaVersion(t.db), SCHEMA_VERSION)

    const names = tableNames(t.db)
    for (const name of [
      'documents',
      'kv',
      'notifications',
      'menu_usage',
      'link_history',
      'documents_history'
    ]) {
      assert.ok(names.includes(name), `缺表 ${name}（实有：${names.join(', ')}）`)
    }
    assert.ok(names.includes('documents_fts'), 'FTS 虚拟表应当建出来')
    const fts = t.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get()
    assert.match(fts.sql, /trigram/, 'FTS 必须用 trigram（中文子串匹配的前提）')
    assert.deepEqual(metaCols(t.db), ['encoding', 'eol', 'had_bom'], 'documents 的三列元数据')
    // migration 2：历史表的字节数列（抽稀不再现算 LENGTH(content)，见其注释）
    assert.ok(
      columnsOf(t.db, 'documents_history').includes('bytes'),
      'documents_history 应当有 bytes 列'
    )
  } finally {
    t.done()
  }
})

test('重复跑：幂等、不抛错、版本不变', () => {
  const t = tempDb()
  try {
    runMigrations(t.db)
    const again = runMigrations(t.db)
    assert.deepEqual(again.ran, [], '已是最新时不该再跑任何步骤')
    assert.equal(again.from, SCHEMA_VERSION)
    assert.equal(readSchemaVersion(t.db), SCHEMA_VERSION)
    // 应用每次启动都会调，多跑几次也必须安全
    runMigrations(t.db)
    runMigrations(t.db)
    assert.equal(readSchemaVersion(t.db), SCHEMA_VERSION)
  } finally {
    t.done()
  }
})

test('老库（只有 documents + kv，notifications 无 scope 列）：补齐列与各表', () => {
  const t = tempDb()
  try {
    t.db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL, word_count INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
        is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0
      );
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', merge_key TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      INSERT INTO notifications (level, title, created_at) VALUES ('info', 'old notice', 1);
    `)
    const res = runMigrations(t.db)
    assert.deepEqual(
      res.ran,
      Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
      '老库也要把没跑过的步骤全部补上'
    )

    const cols = columnsOf(t.db, 'notifications')
    for (const c of ['actions', 'payload', 'scope']) {
      assert.ok(cols.includes(c), `notifications 缺列 ${c}（实有：${cols.join(', ')}）`)
    }
    assert.deepEqual(metaCols(t.db), ['encoding', 'eol', 'had_bom'], '老库的 documents 也要补三列')
    // 语义：scope 那次 ALTER 会把「全局共享时期」的无归属老通知清掉（一次性清理）
    assert.equal(
      t.db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,
      0,
      '加 scope 列时必须删掉无归属老通知'
    )
    assert.ok(tableNames(t.db).includes('link_history'))
    // 老库里的 documents 行还在（清理只针对 notifications）
    assert.equal(t.db.prepare('SELECT COUNT(*) AS c FROM documents').get().c, 0)
  } finally {
    t.done()
  }
})

test('kv fileEncodings → documents.encoding：一次性、对不上的留 kv、打标记', () => {
  const t = tempDb()
  try {
    t.db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL, word_count INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
        is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0
      );
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO documents (path, title, created_at, modified_at, last_opened)
        VALUES ('D:\\notes\\a.md', 'a', 1, 1, 1), ('D:\\notes\\b.md', 'b', 1, 1, 1);
    `)
    // kv 的值统一用 JSON.stringify 生成，避免手写 SQL 转义出错
    t.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'fileEncodings',
      JSON.stringify({
        'd:\\notes\\a.md': 'gbk',
        'd:\\notes\\b.md': 'utf-8',
        'd:\\notes\\gone.md': 'big5'
      }),
      1
    )

    runMigrations(t.db)

    const enc = (p) => t.db.prepare('SELECT encoding FROM documents WHERE path = ?').get(p).encoding
    assert.equal(enc('D:\\notes\\a.md'), 'gbk', '路径按小写+反斜杠归一后应当对上并写入编码')
    assert.equal(enc('D:\\notes\\b.md'), 'utf-8')
    const leftover = JSON.parse(
      t.db.prepare("SELECT value FROM kv WHERE key = 'fileEncodings'").get().value
    )
    assert.deepEqual(Object.keys(leftover), ['d:\\notes\\gone.md'], '对不上的条目要留在 kv 里兜底')
    assert.equal(
      JSON.parse(
        t.db.prepare("SELECT value FROM kv WHERE key = 'fileEncodingsMigrated'").get().value
      ),
      true,
      '必须打标记，避免每次启动都重扫'
    )
    // 再跑一次不会把 leftover 覆盖掉（一次性迁移）
    runMigrations(t.db)
    assert.deepEqual(
      Object.keys(
        JSON.parse(t.db.prepare("SELECT value FROM kv WHERE key = 'fileEncodings'").get().value)
      ),
      ['d:\\notes\\gone.md']
    )
  } finally {
    t.done()
  }
})

test('migration 2：历史表补 bytes 列并回填 UTF-8 字节数（字符数 ≠ 字节数）', () => {
  const t = tempDb()
  try {
    // 造一个"v1 时期的库"：历史表已经存在，但没有 bytes 列
    t.db.exec(`
      CREATE TABLE documents_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL, saved_at INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
        preview TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        encoding TEXT NOT NULL DEFAULT '', eol TEXT NOT NULL DEFAULT ''
      );
    `)
    const zh = '中文正文一二三' // 7 个字符 / UTF-8 21 字节
    const ins = t.db.prepare(
      'INSERT INTO documents_history (path, saved_at, size, preview, content) VALUES (?, ?, ?, ?, ?)'
    )
    ins.run('D:\\ws\\a.md', 1000, zh.length, 'p', zh)
    ins.run('D:\\ws\\b.md', 2000, 0, '', '') // 空正文：字节数 0，不该被"回填"成别的值

    runMigrations(t.db)
    assert.equal(readSchemaVersion(t.db), SCHEMA_VERSION)
    const rows = t.db
      .prepare('SELECT path, size, bytes FROM documents_history ORDER BY saved_at')
      .all()
    assert.equal(rows[0].bytes, Buffer.byteLength(zh, 'utf8'), 'bytes 必须是 UTF-8 字节数')
    assert.ok(rows[0].bytes > rows[0].size, `中文字节数应当大于字符数：${JSON.stringify(rows[0])}`)
    assert.equal(rows[0].size, zh.length, 'size 列保持原语义（字符数），迁移不许改它')
    assert.equal(rows[1].bytes, 0, '空正文的字节数是 0')

    // 再跑一次：不许重算（回填条件里有 bytes = 0，非空行不会被反复扫）
    runMigrations(t.db)
    assert.equal(
      t.db.prepare('SELECT bytes FROM documents_history WHERE path = ?').get('D:\\ws\\a.md').bytes,
      Buffer.byteLength(zh, 'utf8')
    )
  } finally {
    t.done()
  }
})
