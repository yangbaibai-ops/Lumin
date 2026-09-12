// ─── SQLite 持久层：文档元数据 + FTS5 全文索引 ────────────────────────────
// 使用 Electron 内置 Node 的 node:sqlite（DatabaseSync，含 FTS5），零原生依赖
import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import path from 'path'
import type {
  AppNotification,
  LinkActivateRecord,
  LinkHistoryEntry,
  LinkTargetKind,
  MenuUsageEntry,
  NotificationAction,
  NotificationInput,
  NotificationLevel,
  NotificationListOptions,
  NotificationPatch,
  NotificationPayload
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
  /** 窗口作用域（见 services/windowScope）；不进入渲染进程的 DTO */
  scope: string
  level: string
  title: string
  body: string
  merge_key: string
  created_at: number
  closed_at: number | null
  actions: string | null
  payload: string | null
}

interface MenuUsageRow {
  action_id: string
  count: number
  last_used: number
}

interface LinkHistoryRow {
  target: string
  kind: string
  resolved_path: string | null
  action: string
  created_entry: number
  count: number
  created_at: number
  last_used: number
}

const LINK_TARGET_KINDS: LinkTargetKind[] = ['url', 'file', 'relative', 'absolute']

function rowToLinkHistory(row: LinkHistoryRow): LinkHistoryEntry {
  return {
    target: row.target,
    kind: LINK_TARGET_KINDS.includes(row.kind as LinkTargetKind)
      ? (row.kind as LinkTargetKind)
      : 'file',
    path: row.resolved_path,
    action: row.action,
    created: row.created_entry === 1,
    count: row.count,
    createdAt: row.created_at,
    lastUsed: row.last_used
  }
}

const NOTIFICATION_LEVELS: NotificationLevel[] = ['info', 'success', 'warning', 'error']

/** JSON 列的安全解析（脏数据一律退化为空值，不影响通知可用性） */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToNotification(row: NotificationRow): AppNotification {
  const level = NOTIFICATION_LEVELS.includes(row.level as NotificationLevel)
    ? (row.level as NotificationLevel)
    : 'info'
  const actions = parseJson<NotificationAction[]>(row.actions, []).filter(
    (a) => a && typeof a.id === 'string' && typeof a.label === 'string'
  )
  const payload = parseJson<NotificationPayload | null>(row.payload, null)
  return {
    id: row.id,
    level,
    title: row.title,
    body: row.body,
    actions,
    payload: payload && typeof payload.kind === 'string' ? payload : null,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null
  }
}

/** 与渲染层一致的字数统计（中文字符 + 英文单词） */
export function countWords(content: string): number {
  // 字符集与原来完全一致，只是把 `-` 放到末尾（类内末尾的连字符无需转义）
  const text = content.replace(/[#>*`_~[\]()!|-]/g, ' ').trim()
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
    // 通知中心：跨会话保留（关闭用 closed_at 软删除，便于日后做历史面板）。
    // scope = 窗口作用域（services/windowScope）：通知属于「产生它的那个窗口」，
    // 多窗口各自独立，不会一条提示在所有窗口同时弹出。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        merge_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      );
    `)
    // 可交互通知：卡片上的操作按钮 + 负载（JSON 文本）。
    // 建表时已存在则走 ADD COLUMN（SQLite 不支持 IF NOT EXISTS 加列），
    // 旧库升级后历史行取默认值（纯消息通知，actions 为空数组）。
    const notifCols = this.db.prepare('PRAGMA table_info(notifications)').all() as unknown as {
      name: string
    }[]
    const hasCol = (n: string): boolean => notifCols.some((c) => c.name === n)
    if (!hasCol('actions')) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'")
    }
    if (!hasCol('payload')) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN payload TEXT NOT NULL DEFAULT ''")
    }
    if (!hasCol('scope')) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN scope TEXT NOT NULL DEFAULT ''")
      // 旧库里的通知是「全局共享」时期的产物，无法归属到任何窗口，一次性清掉，
      // 否则它们会在所有窗口都查不到（查询按 scope 过滤）却永久占着表空间。
      this.db.exec("DELETE FROM notifications WHERE scope = ''")
    }
    // 索引必须等 scope 列确定存在后再建（旧库此时才刚 ALTER 出来）
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_scope_open
        ON notifications(scope, closed_at, created_at DESC);
    `)
    // 旧索引被 (scope, closed_at, created_at) 覆盖，去掉避免写放大
    this.db.exec('DROP INDEX IF EXISTS idx_notifications_open')
    // 编辑器右键菜单的动作使用记录：驱动「最近使用」分区（跨会话保留）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS menu_usage (
        action_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_menu_usage_last_used ON menu_usage(last_used DESC);
    `)
    // 链接打开历史：设置面板可查看/删除/清空（跨会话保留，避免只活在 session 里）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS link_history (
        target TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'file',
        resolved_path TEXT,
        action TEXT NOT NULL DEFAULT 'external',
        created_entry INTEGER NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_link_history_last_used ON link_history(last_used DESC);
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
    // 目标路径可能残留在索引里（同名文件以前打开过、或在外部被删后索引未清），
    // 此时直接 UPDATE 会撞 documents.path 的 UNIQUE 约束、整个重命名失败。
    // 索引只是「打开过的文件」的缓存，先清掉旧的目标行（含其 FTS 行）再改路径。
    const stale = this.getRow(newPath)
    if (stale && stale.path !== oldPath) {
      this.db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(stale.id)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(stale.id)
    }
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

  // ── 通知中心（CRUD + 关闭/清理，按窗口作用域隔离）────────────────────────
  // 设计：单卡片通知中心只需要「未关闭」集合，故列表默认只查 closed_at IS NULL，
  // 但保留 includeClosed 供历史面板/调试使用；关闭是软删除（closed_at 打时间戳），
  // 硬删除交给 remove / clearClosed。行数上限由 prune 在写入后收紧，避免无限增长。
  // scope 由主进程按 IPC 发送方注入（渲染进程无法指定），所有读写都以它为前提条件。

  private static readonly NOTIFICATION_LIMIT = 200

  /** 新增（同作用域内 mergeKey 命中未关闭项时改为更新并置顶，按钮与负载一并刷新） */
  addNotification(scope: string, input: NotificationInput): AppNotification {
    const level: NotificationLevel = input.level ?? 'info'
    const title = input.title
    const body = input.body ?? ''
    const actions = JSON.stringify(input.actions ?? [])
    const payload = input.payload ? JSON.stringify(input.payload) : ''
    const mergeKey = input.mergeKey ?? `${level}\u0000${title}`
    const now = Date.now()
    const hit = this.db
      .prepare(
        'SELECT id FROM notifications WHERE scope = ? AND closed_at IS NULL AND merge_key = ?'
      )
      .get(scope, mergeKey) as { id: number } | undefined
    if (hit) {
      this.db
        .prepare(
          `UPDATE notifications
             SET level = ?, title = ?, body = ?, actions = ?, payload = ?, created_at = ?
           WHERE id = ?`
        )
        .run(level, title, body, actions, payload, now, hit.id)
      this.pruneNotifications(scope)
      const updated = this.getNotification(hit.id)
      if (updated) return updated
    }
    const info = this.db
      .prepare(
        `INSERT INTO notifications (scope, level, title, body, merge_key, actions, payload, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(scope, level, title, body, mergeKey, actions, payload, now)
    this.pruneNotifications(scope)
    const row = this.getNotification(Number(info.lastInsertRowid))
    if (!row) throw new Error('DB: addNotification failed')
    return row
  }

  getNotification(id: number): AppNotification | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
      NotificationRow | undefined
    return row ? rowToNotification(row) : null
  }

  /** 列表：只返回该窗口的通知；默认只含未关闭项，按时间倒序（最新在前） */
  listNotifications(scope: string, options: NotificationListOptions = {}): AppNotification[] {
    const limit = options.limit ?? LuminDatabase.NOTIFICATION_LIMIT
    const sql = options.includeClosed
      ? 'SELECT * FROM notifications WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : `SELECT * FROM notifications WHERE scope = ? AND closed_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(scope, limit) as unknown as NotificationRow[]
    return rows.map(rowToNotification)
  }

  /** 局部更新（标题/详情/级别）；跨窗口的 id 不生效 */
  updateNotification(scope: string, id: number, patch: NotificationPatch): AppNotification | null {
    const current = this.db
      .prepare('SELECT * FROM notifications WHERE id = ? AND scope = ?')
      .get(id, scope) as NotificationRow | undefined
    if (!current) return null
    const before = rowToNotification(current)
    this.db
      .prepare('UPDATE notifications SET level = ?, title = ?, body = ? WHERE id = ? AND scope = ?')
      .run(
        patch.level ?? before.level,
        patch.title ?? before.title,
        patch.body ?? before.body,
        id,
        scope
      )
    return this.getNotification(id)
  }

  /** 关闭单条（软删除：closed_at 打时间戳；已关闭则保持原时间） */
  closeNotification(scope: string, id: number): void {
    this.db
      .prepare(
        'UPDATE notifications SET closed_at = ? WHERE id = ? AND scope = ? AND closed_at IS NULL'
      )
      .run(Date.now(), id, scope)
  }

  /** 关闭该窗口全部通知，返回受影响条数 */
  closeAllNotifications(scope: string): number {
    const info = this.db
      .prepare('UPDATE notifications SET closed_at = ? WHERE scope = ? AND closed_at IS NULL')
      .run(Date.now(), scope)
    return Number(info.changes)
  }

  /** 物理删除单条（限本窗口） */
  removeNotification(scope: string, id: number): void {
    this.db.prepare('DELETE FROM notifications WHERE id = ? AND scope = ?').run(id, scope)
  }

  /** 清理该窗口已关闭记录，返回删除条数 */
  clearClosedNotifications(scope: string): number {
    const info = this.db
      .prepare('DELETE FROM notifications WHERE scope = ? AND closed_at IS NOT NULL')
      .run(scope)
    return Number(info.changes)
  }

  /**
   * 清空某个窗口作用域的全部通知（含已关闭）。
   * 用于「窗口关闭」与「槽位被新窗口复用」——通知随窗口生命周期存在，
   * 关掉窗口就不会把提示留给下一个占用这个槽位的窗口。
   */
  deleteNotificationsByScope(scope: string): number {
    const info = this.db.prepare('DELETE FROM notifications WHERE scope = ?').run(scope)
    return Number(info.changes)
  }

  /** 每个窗口作用域只保留最近 N 条（含已关闭），控制表体积 */
  private pruneNotifications(scope: string, keep = LuminDatabase.NOTIFICATION_LIMIT): void {
    this.db
      .prepare(
        `DELETE FROM notifications WHERE scope = ? AND id NOT IN (
           SELECT id FROM notifications WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ?
         )`
      )
      .run(scope, scope, keep)
  }

  // ── 编辑器右键菜单：动作使用记录（CRUD，驱动「最近使用」）───────────────
  // 只有「增/改（bump 累加）」与「查/删」两条路径，语义简单：
  // 每次从菜单执行动作就 bump 一次，菜单按 last_used 倒序取前 N 组成「最近使用」。

  bumpMenuUsage(actionId: string): MenuUsageEntry {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO menu_usage (action_id, count, last_used) VALUES (?, 1, ?)
         ON CONFLICT(action_id) DO UPDATE SET count = count + 1, last_used = excluded.last_used`
      )
      .run(actionId, now)
    const row = this.db
      .prepare('SELECT action_id, count, last_used FROM menu_usage WHERE action_id = ?')
      .get(actionId) as unknown as MenuUsageRow
    return { actionId: row.action_id, count: row.count, lastUsed: row.last_used }
  }

  listMenuUsage(limit = 8): MenuUsageEntry[] {
    const rows = this.db
      .prepare('SELECT action_id, count, last_used FROM menu_usage ORDER BY last_used DESC LIMIT ?')
      .all(limit) as unknown as MenuUsageRow[]
    return rows.map((r) => ({ actionId: r.action_id, count: r.count, lastUsed: r.last_used }))
  }

  forgetMenuUsage(actionId: string): void {
    this.db.prepare('DELETE FROM menu_usage WHERE action_id = ?').run(actionId)
  }

  resetMenuUsage(): number {
    const info = this.db.prepare('DELETE FROM menu_usage').run()
    return Number(info.changes)
  }

  // ── 链接打开历史（CRUD，SQLite 持久化）─────────────────────────────────
  // 以「链接文本」为主键做 upsert：同一个链接重复打开只累加计数并刷新时间，
  // 因此这里天然是「增/改」合一，配合 list（查）/ forget·clear（删）构成完整 CRUD。
  // 用途：设置面板「链接」页签里可查看并清理；也被用来记录用户放弃创建的链接。

  recordLinkOpen(input: LinkActivateRecord): LinkHistoryEntry {
    const now = Date.now()
    const created = input.created ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO link_history (target, kind, resolved_path, action, created_entry, count, created_at, last_used)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(target) DO UPDATE SET
           kind = excluded.kind,
           resolved_path = excluded.resolved_path,
           action = excluded.action,
           created_entry = MAX(link_history.created_entry, excluded.created_entry),
           count = link_history.count + 1,
           last_used = excluded.last_used`
      )
      .run(input.target, input.kind, input.path, input.action, created, now, now)
    const row = this.db
      .prepare(
        'SELECT target, kind, resolved_path, action, created_entry, count, created_at, last_used FROM link_history WHERE target = ?'
      )
      .get(input.target) as unknown as LinkHistoryRow
    return rowToLinkHistory(row)
  }

  listLinkHistory(limit = 50): LinkHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT target, kind, resolved_path, action, created_entry, count, created_at, last_used
         FROM link_history ORDER BY last_used DESC LIMIT ?`
      )
      .all(limit) as unknown as LinkHistoryRow[]
    return rows.map(rowToLinkHistory)
  }

  forgetLinkOpen(target: string): void {
    this.db.prepare('DELETE FROM link_history WHERE target = ?').run(target)
  }

  clearLinkHistory(): number {
    const info = this.db.prepare('DELETE FROM link_history').run()
    return Number(info.changes)
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
