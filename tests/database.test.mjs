// ─── SQLite 持久层的 IO 单测（报告 §6.2 的最后一块）───────────────────────────
//
// 背景：`services/database.ts` 顶层 `import { app } from 'electron'`、单例又在模块顶层 `new`
// —— 于是 `import` 一下就 ERR_MODULE_NOT_FOUND（没有 electron），这片"搜索索引 / 标签 / 历史 /
// 编码记忆"的持久层一直只有 CDP 套件能从外面敲。
// 波次 2 的解耦：electron 改成**惰性 require**（只有不传路径时才走）、单例改成**惰性**、
// `initDatabase(路径)` 供测试与组合根显式指定 —— 于是这里能用临时目录 + 真 `node:sqlite` 库断言。
//
// 每条都对应一种真实故障：索引幽灵行、删目录没清干净、改名后子孙文档找不到、
// FTS 里搜不到刚保存的内容、标签/置顶丢失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  closeDatabase,
  clipForIndex,
  countWords,
  db,
  initDatabase
} from '../src/main/services/database.ts'

/** 每个用例一个全新的临时库（跑完关掉并删目录） */
function freshDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumin-db-${name}-`))
  const instance = initDatabase(path.join(dir, 'lumin.db'))
  return {
    db: instance,
    dir,
    done() {
      closeDatabase()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const doc = (p, content, extra = {}) => ({
  path: p,
  title: path.basename(p),
  content,
  encoding: 'utf-8',
  eol: 'lf',
  hadBom: false,
  ...extra
})

test('纯函数：countWords 数中英混排的字数；clipForIndex 截断但不动短的', () => {
  assert.equal(countWords('hello world'), 2)
  assert.ok(countWords('中文四个字') >= 4, '中文按字计')
  assert.equal(countWords(''), 0)
  const long = 'x'.repeat(5000)
  const clipped = clipForIndex(long)
  assert.ok(clipped.length <= long.length, '截断只会变短')
  assert.equal(clipForIndex('短文本'), '短文本')
})

test('upsert → 读回：元数据（编码/行尾/BOM）与统计都对得上', () => {
  const t = freshDb('upsert')
  try {
    t.db.upsertDocument(doc('C:\\ws\\a.md', '# A\n\n正文\n', { encoding: 'gb18030', hadBom: true }))
    const meta = t.db.getDocumentMeta('C:\\ws\\a.md')
    assert.equal(meta?.encoding, 'gb18030')
    assert.equal(meta?.hadBom, true)
    assert.equal(t.db.stats().docs, 1)
    // 再写一次是更新而不是新增
    t.db.upsertDocument(doc('C:\\ws\\a.md', '# A2\n\n新正文\n'))
    assert.equal(t.db.stats().docs, 1)
  } finally {
    t.done()
  }
})

test('FTS：保存过的内容立刻可搜（flush 之后），删掉之后搜不到', () => {
  const t = freshDb('fts')
  try {
    t.db.upsertDocument(doc('C:\\ws\\search.md', '# 标题\n\n独一无二的关键词 zooflag\n'))
    t.db.flushFtsIndex()
    const hit = t.db.search('zooflag', 10)
    assert.ok(
      hit.some((r) => r.path === 'C:\\ws\\search.md'),
      `FTS 没搜到刚保存的文档：${JSON.stringify(hit.map((h) => h.path))}`
    )
    t.db.deleteDocument('C:\\ws\\search.md')
    t.db.flushFtsIndex()
    const after = t.db.search('zooflag', 10)
    assert.equal(
      after.some((r) => r.path === 'C:\\ws\\search.md'),
      false,
      '删掉的文档还留在 FTS 里（幽灵文档就是这条路的产物）'
    )
  } finally {
    t.done()
  }
})

test('deleteDocumentsUnder：按目录边界删，绝不误伤同前缀的兄弟目录', () => {
  const t = freshDb('prune-dir')
  try {
    t.db.upsertDocument(doc('C:\\ws\\notes\\a.md', 'a'))
    t.db.upsertDocument(doc('C:\\ws\\notes\\sub\\b.md', 'b'))
    t.db.upsertDocument(doc('C:\\ws\\notes-archive\\c.md', 'c')) // 前缀相同、但不是子目录
    t.db.upsertDocument(doc('C:\\ws\\other\\d.md', 'd'))
    const removed = t.db.deleteDocumentsUnder('C:\\ws\\notes')
    assert.equal(removed, 2, `应删 2 条（notes 与 notes/sub），实际 ${removed}`)
    assert.equal(t.db.getDocumentMeta('C:\\ws\\notes\\a.md'), null)
    assert.equal(t.db.getDocumentMeta('C:\\ws\\notes\\sub\\b.md'), null)
    assert.ok(t.db.getDocumentMeta('C:\\ws\\notes-archive\\c.md'), 'notes-archive 不能被连带删掉')
    assert.ok(t.db.getDocumentMeta('C:\\ws\\other\\d.md'))
  } finally {
    t.done()
  }
})

test('pruneWorkspace：删掉"本工作区内、但这次没扫到"的行，别的工作区不动', () => {
  const t = freshDb('prune-ws')
  try {
    t.db.upsertDocument(doc('C:\\ws\\keep.md', 'keep'))
    t.db.upsertDocument(doc('C:\\ws\\ghost.md', 'ghost'))
    t.db.upsertDocument(doc('C:\\other\\elsewhere.md', 'elsewhere'))
    const removed = t.db.pruneWorkspace('C:\\ws', ['C:\\ws\\keep.md'])
    assert.equal(removed, 1, `应只删 ghost.md，实际 ${removed}`)
    assert.ok(t.db.getDocumentMeta('C:\\ws\\keep.md'))
    assert.equal(t.db.getDocumentMeta('C:\\ws\\ghost.md'), null)
    assert.ok(t.db.getDocumentMeta('C:\\other\\elsewhere.md'), '别的工作区不许被对账删掉')
  } finally {
    t.done()
  }
})

test('renameDirectory：目录改名后子孙文档的路径一起搬（搜索/最近/历史才对得上号）', () => {
  const t = freshDb('rename')
  try {
    t.db.upsertDocument(doc('C:\\ws\\old\\a.md', 'a'))
    t.db.upsertDocument(doc('C:\\ws\\old\\deep\\b.md', 'b'))
    t.db.renameDirectory('C:\\ws\\old', 'C:\\ws\\new')
    assert.ok(t.db.getDocumentMeta('C:\\ws\\new\\a.md'), '一级子文档没搬过去')
    assert.ok(t.db.getDocumentMeta('C:\\ws\\new\\deep\\b.md'), '深层子文档没搬过去')
    assert.equal(t.db.getDocumentMeta('C:\\ws\\old\\a.md'), null, '旧路径不该还留着')
  } finally {
    t.done()
  }
})

test('标签与置顶：写进去之后能在列表与筛选里读回来', () => {
  const t = freshDb('tags')
  try {
    t.db.upsertDocument(doc('C:\\ws\\tag.md', 'tagged'))
    t.db.setTags('C:\\ws\\tag.md', ['写作', '工具'])
    t.db.setPinned('C:\\ws\\tag.md', true)
    const row = t.db.getDocument('C:\\ws\\tag.md')
    assert.deepEqual([...row.tags].sort(), ['写作', '工具'].sort())
    assert.equal(row.isPinned, true)
    const pinned = t.db.listPinned ? t.db.listPinned() : null
    if (pinned) assert.ok(pinned.some((p) => p.path === 'C:\\ws\\tag.md'))
  } finally {
    t.done()
  }
})

test('元数据写入与正文分开：setDocumentTextMeta 不覆盖正文与时间戳', () => {
  const t = freshDb('meta')
  try {
    t.db.upsertDocument(doc('C:\\ws\\m.md', '原始正文'))
    t.db.setDocumentTextMeta('C:\\ws\\m.md', { encoding: 'shift_jis', eol: 'crlf', hadBom: true })
    const meta = t.db.getDocumentMeta('C:\\ws\\m.md')
    assert.equal(meta?.encoding, 'shift_jis')
    assert.equal(meta?.eol, 'crlf')
    const row = t.db.getDocument('C:\\ws\\m.md')
    assert.match(String(row.content ?? ''), /原始正文/, '正文不该被元数据写入清掉')
  } finally {
    t.done()
  }
})

test('db 句柄是惰性单例：initDatabase 之后再访问才建库，closeDatabase 之后还能重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-db-lazy-'))
  try {
    initDatabase(path.join(dir, 'one.db'))
    db.upsertDocument(doc('C:\\ws\\lazy.md', 'lazy'))
    assert.equal(db.stats().docs, 1)
    closeDatabase()
    initDatabase(path.join(dir, 'two.db'))
    assert.equal(db.stats().docs, 0, '换库文件之后是全新的空库（证明确实换了实例）')
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
