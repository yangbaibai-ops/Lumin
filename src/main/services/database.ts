// ─── SQLite 持久层：文档元数据 + FTS5 全文索引 ────────────────────────────
// 使用 Electron 内置 Node 的 node:sqlite（DatabaseSync，含 FTS5），零原生依赖
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import path from 'path'

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
    this.db = new DatabaseSync(dbPath)
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
