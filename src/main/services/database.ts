// ─── SQLite 持久层：文档元数据 + FTS5 全文索引 ────────────────────────────
// 使用 Electron 内置 Node 的 node:sqlite（DatabaseSync，含 FTS5），零原生依赖
import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import path from 'path'
import type {
  AppNotification,
  NotificationInput,
  NotificationLevel,
  NotificationListOptions,
  NotificationPatch
} from '../../shared/types'

/** 惰性加载 node:sqlite 的 DatabaseSync 构造函数。
 *  electron-vite(Rollup) 会把顶层 import 的 require 提升到 bundle 顶部、先于
 *  suppressWarnings 的 process.emitWarning 过滤器执行，导致 node:sqlite 的
 *  实验性警告提前打印。改为「函数内 require」后，真正加载发生在过滤器之后，
 *  警告即可被吞掉。 */
function requireDatabaseSync(): typeof import('node:sqlite')['DatabaseSync'] {
  // 主进程由 electron-vite 打包为 CommonJS，运行时存在模块级 require
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
}

export interface DocMeta {
  id: number
  path: string
  title: string
  content: string
  createdAt: number
  modifiedAt: number
  lastOpened: number
  wordCount: number
  tags: string[]
  isPinned: boolean
  isArchived: boolean
}

export interface SearchResult {
  path: string
  title: string
  titleSnippet: string
  bodySnippet: string
  modifiedAt: number
}

interface DocRow {
  id: number
  path: string
  title: string
  content: string
  created_at: number
  modified_at: number
  last_opened: number
  word_count: number
  tags: string
  is_pinned: number
  is_archived: number
}

interface NotificationRow {
  id: number
  level: string
  title: string
  body: string
  merge_key: string
  created_at: number
  closed_at: number | null
}

const NOTIFICATION_LEVELS: NotificationLevel[] = ['info', 'success', 'warning', 'error']

function rowToNotification(row: NotificationRow): AppNotification {
  const level = NOTIFICATION_LEVELS.includes(row.level as NotificationLevel)
    ? (row.level as NotificationLevel)
    : 'info'
  return {
    id: row.id,
    level,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null
  }
}

/** 与渲染层一致的字数统计（中文字符 + 英文单词） */
export function countWords(content: string): number {
  const text = content.replace(/[#>*`\-_~\[\]()!|]/g, ' ').trim()
  if (!text) return 0
  const zh = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const words = (text.match(/[a-zA-Z0-9_]+(?:['’-][a-zA-Z0-9_]+)*/g) || []).length
  return zh + words
}

class LuminDatabase {
  private db: DatabaseSync

  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'lumin.db')
    const DatabaseSyncCtor = requireDatabaseSync()
    this.db = new DatabaseSyncCtor(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        last_opened INTEGER NOT NULL,
        word_count INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        is_pinned INTEGER DEFAULT 0,
        is_archived INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_documents_last_opened ON documents(last_opened);
    `)
    // 应用状态键值表：设置 / 工作区等 UI 状态持久化（JSON 值）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    // 全局通知中心：跨会话保留（关闭用 closed_at 软删除，便于日后做历史面板）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        merge_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_open
        ON notifications(closed_at, created_at DESC);
    `)
    // FTS5：trigram 分词器（对中日韩文本支持子串匹配；支持片段高亮）
    const ftsRow = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .get() as { sql: string } | undefined
    if (ftsRow && !ftsRow.sql.includes('trigram')) {
      this.db.exec('DROP TABLE documents_fts')
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, content,
        tokenize = 'trigram case_sensitive 0'
      );
    `)
    // 已有文档重建索引（旧表被替换 / 首次迁移时）
    const indexed = this.db
      .prepare('SELECT COUNT(*) AS c FROM documents_fts')
      .get() as unknown as { c: number }
    if (indexed.c === 0) {
      const rows = this.db.prepare('SELECT id, title, content FROM documents').all() as unknown as {
        id: number
        title: string
        content: string
      }[]
      const del = this.db.prepare('DELETE FROM documents_fts WHERE rowid = ?')
      const ins = this.db.prepare(
        'INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)'
      )
      for (const row of rows) {
        del.run(row.id)
        ins.run(row.id, row.title, row.content)
      }
    }
  }

  /** 保存/打开文档时同步元数据与全文索引（UPSERT） */
  upsertDocument(meta: {
    path: string
    title: string
    content: string
    tags?: string[]
    isPinned?: boolean
  }): DocMeta {
    const now = Date.now()
    const existing = this.getRow(meta.path)
    const tags = JSON.stringify(
      meta.tags ?? (existing ? this.parseTags(existing.tags) : [])
    )
    this.db
      .prepare(
        `INSERT INTO documents
           (path, title, content, created_at, modified_at, last_opened, word_count, tags, is_pinned, is_archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           modified_at = excluded.modified_at,
           word_count = excluded.word_count,
           last_opened = excluded.last_opened`
      )
      .run(
        meta.path,
        meta.title,
        meta.content,
        existing?.created_at ?? now,
        now,
        existing?.last_opened ?? now,
        countWords(meta.content),
        tags,
        meta.isPinned !== undefined ? (meta.isPinned ? 1 : 0) : (existing?.is_pinned ?? 0),
        existing?.is_archived ?? 0
      )
    const row = this.getRow(meta.path)
    if (!row) throw new Error('DB: upsert failed')
    // 同步 FTS 索引
    this.db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(row.id)
    this.db
      .prepare('INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)')
      .run(row.id, row.title, row.content)
    return this.rowToMeta(row)
  }

  getDocument(filePath: string): DocMeta | null {
    const row = this.getRow(filePath)
    return row ? this.rowToMeta(row) : null
  }

  touchOpened(filePath: string, title?: string): void {
    const now = Date.now()
    this.db.prepare('UPDATE documents SET last_opened = ? WHERE path = ?').run(now, filePath)
    if (title) {
      this.db.prepare('UPDATE documents SET title = ? WHERE path = ?').run(title, filePath)
    }
  }

  deleteDocument(filePath: string): void {
    const row = this.getRow(filePath)
    if (row) this.db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(row.id)
    this.db.prepare('DELETE FROM documents WHERE path = ?').run(filePath)
  }

  renameDocument(oldPath: string, newPath: string): void {
    this.db
      .prepare('UPDATE documents SET path = ?, title = ? WHERE path = ?')
      .run(newPath, path.basename(newPath), oldPath)
  }

  setPinned(filePath: string, pinned: boolean): void {
    this.db.prepare('UPDATE documents SET is_pinned = ? WHERE path = ?').run(pinned ? 1 : 0, filePath)
  }

  setTags(filePath: string, tags: string[]): void {
    this.db.prepare('UPDATE documents SET tags = ? WHERE path = ?').run(JSON.stringify(tags), filePath)
  }

  listRecent(limit = 30): DocMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE is_archived = 0 ORDER BY last_opened DESC LIMIT ?')
      .all(limit) as unknown as DocRow[]
    return rows.map((r) => this.rowToMeta(r))
  }

  /** FTS5 全文搜索（trigram 分词 + 短语匹配 + 片段高亮；短词回退 LIKE） */
  search(query: string, limit = 30): SearchResult[] {
    const q = query.trim()
    if (!q) return []
    const likePattern = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`
    const fallbackRows = this.db
      .prepare(
        `SELECT d.path, d.title, d.modified_at, '' AS title_snippet, '' AS body_snippet
         FROM documents d
         WHERE d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\'
         ORDER BY d.modified_at DESC
         LIMIT ?`
      )
      .all(likePattern, likePattern, limit) as unknown as {
      path: string
      title: string
      title_snippet: string
      body_snippet: string
      modified_at: number
    }[]
    // trigram 分词器要求查询 ≥ 3 字符；短查询直接走 LIKE
    if (q.length < 3) {
      return fallbackRows.map((r) => this.toResult(r))
    }
    const escaped = q
      .split(/\s+/)
      .map((t) => '"' + t.replace(/"/g, '""') + '"')
      .join(' AND ')
    try {
      const rows = this.db
        .prepare(
          `SELECT d.path, d.title, d.modified_at,
                  snippet(documents_fts, 0, '<em>', '</em>', '…', 10) AS title_snippet,
                  snippet(documents_fts, 1, '<em>', '</em>', '…', 18) AS body_snippet
           FROM documents_fts
           JOIN documents d ON d.rowid = documents_fts.rowid
           WHERE documents_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(escaped, limit) as unknown as {
        path: string
        title: string
        title_snippet: string
        body_snippet: string
        modified_at: number
      }[]
      const results = rows.map((r) => this.toResult(r))
      // FTS 无结果时兜底 LIKE（如标点/特殊字符查询）
      return results.length ? results : fallbackRows.map((r) => this.toResult(r))
    } catch {
      return fallbackRows.map((r) => this.toResult(r))
    }
  }

  private toResult(r: {
    path: string
    title: string
    title_snippet: string
    body_snippet: string
    modified_at: number
  }): SearchResult {
    return {
      path: r.path,
      title: r.title,
      titleSnippet: r.title_snippet,
      bodySnippet: r.body_snippet,
      modifiedAt: r.modified_at
    }
  }

  stats(): { docs: number; fts: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS docs FROM documents')
      .get() as unknown as { docs: number }
    const fts = this.db
      .prepare('SELECT COUNT(*) AS c FROM documents_fts')
      .get() as unknown as { c: number }
    return { docs: row.docs, fts: fts.c }
  }

  // ── 全局通知中心（CRUD + 关闭/清理）─────────────────────────────────────
  // 设计：单卡片通知中心只需要「未关闭」集合，故列表默认只查 closed_at IS NULL，
  // 但保留 includeClosed 供历史面板/调试使用；关闭是软删除（closed_at 打时间戳），
  // 硬删除交给 remove / clearClosed。行数上限由 prune 在写入后收紧，避免无限增长。

  private static readonly NOTIFICATION_LIMIT = 200

  /** 新增（mergeKey 命中未关闭项时改为更新并置顶） */
  addNotification(input: NotificationInput): AppNotification {
    const level: NotificationLevel = input.level ?? 'info'
    const title = input.title
    const body = input.body ?? ''
    const mergeKey = input.mergeKey ?? `${level}\u0000${title}`
    const now = Date.now()
    const hit = this.db
      .prepare('SELECT id FROM notifications WHERE closed_at IS NULL AND merge_key = ?')
      .get(mergeKey) as { id: number } | undefined
    if (hit) {
      this.db
        .prepare('UPDATE notifications SET level = ?, title = ?, body = ?, created_at = ? WHERE id = ?')
        .run(level, title, body, now, hit.id)
      this.pruneNotifications()
      const updated = this.getNotification(hit.id)
      if (updated) return updated
    }
    const info = this.db
      .prepare(
        `INSERT INTO notifications (level, title, body, merge_key, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(level, title, body, mergeKey, now)
    this.pruneNotifications()
    const row = this.getNotification(Number(info.lastInsertRowid))
    if (!row) throw new Error('DB: addNotification failed')
    return row
  }

  getNotification(id: number): AppNotification | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
      | NotificationRow
      | undefined
    return row ? rowToNotification(row) : null
  }

  /** 列表：默认只返回未关闭项，按时间倒序（最新在前） */
  listNotifications(options: NotificationListOptions = {}): AppNotification[] {
    const limit = options.limit ?? LuminDatabase.NOTIFICATION_LIMIT
    const sql = options.includeClosed
      ? 'SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM notifications WHERE closed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
    const rows = this.db.prepare(sql).all(limit) as unknown as NotificationRow[]
    return rows.map(rowToNotification)
  }

  /** 局部更新（标题/详情/级别） */
  updateNotification(id: number, patch: NotificationPatch): AppNotification | null {
    const current = this.getNotification(id)
    if (!current) return null
    this.db
      .prepare('UPDATE notifications SET level = ?, title = ?, body = ? WHERE id = ?')
      .run(
        patch.level ?? current.level,
        patch.title ?? current.title,
        patch.body ?? current.body,
        id
      )
    return this.getNotification(id)
  }

  /** 关闭单条（软删除：closed_at 打时间戳；已关闭则保持原时间） */
  closeNotification(id: number): void {
    this.db
      .prepare('UPDATE notifications SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(Date.now(), id)
  }

  /** 全部关闭，返回受影响条数 */
  closeAllNotifications(): number {
    const info = this.db
      .prepare('UPDATE notifications SET closed_at = ? WHERE closed_at IS NULL')
      .run(Date.now())
    return Number(info.changes)
  }

  /** 物理删除单条 */
  removeNotification(id: number): void {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id)
  }

  /** 清理已关闭记录，返回删除条数 */
  clearClosedNotifications(): number {
    const info = this.db.prepare('DELETE FROM notifications WHERE closed_at IS NOT NULL').run()
    return Number(info.changes)
  }

  /** 只保留最近 N 条（含已关闭），控制表体积 */
  private pruneNotifications(keep = LuminDatabase.NOTIFICATION_LIMIT): void {
    this.db
      .prepare(
        `DELETE FROM notifications WHERE id NOT IN (
           SELECT id FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?
         )`
      )
      .run(keep)
  }

  // ── 应用状态 kv（设置 / 工作区持久化，JSON 序列化）──

  kvGet<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  kvSet(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), Date.now())
  }

  kvHas(key: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM kv WHERE key = ?').get(key)
    return !!row
  }

  kvDelete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  private getRow(filePath: string): DocRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE path = ?').get(filePath) as
      | DocRow
      | undefined
  }

  private parseTags(raw: string): string[] {
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  private rowToMeta(row: DocRow): DocMeta {
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      lastOpened: row.last_opened,
      wordCount: row.word_count,
      tags: this.parseTags(row.tags),
      isPinned: !!row.is_pinned,
      isArchived: !!row.is_archived
    }
  }

  close(): void {
    this.db.close()
  }
}

export const db = new LuminDatabase()
