// ─── 数据库结构迁移（版本化）─────────────────────────────────────────────────
//
// 为什么要有这个文件（自查报告 S4）：`database.ts` 里原来是一段 163 行的**顺序幂等 DDL**
// （`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 探测 + `ALTER TABLE`），末尾还挂着
// 一次性迁移 `migrateFileEncodings()`。它能用，但**没有版本号**：
//   * 无法表达「这一步只在 v2→v3 时跑」；
//   * 看不出某个库落在哪一版；
//   * 将来做破坏性变更（改列 / 拆表 / 回填）时没有安全落点。
//
// 现在：整段原样收成 **migration 1**（保持幂等 ⇒ 对老库、新库都安全），跑完写
// `PRAGMA user_version = 1`；此后每个改动都追加成一个独立步骤，形如
//   `{ version: 2, up: (db) => { if (…) db.exec('ALTER TABLE …') } }`
// 并对**更老的库**天然生效（循环从 `user_version + 1` 开始）。
//
// ⚠️ 本文件**不许 import electron**：只吃 `node:sqlite` 的 db 句柄 —— 这样单测能直接建一个
// 临时库把它跑一遍（`tests/migrations.test.mjs`），不必启动应用。
//
// ⚠️ 迁移 1 里的 SQL **语义一字不改**：它是已经在真实用户库上跑过很多轮的语句
// （尤其 `DELETE FROM notifications WHERE scope = ''` 那条一次性清理），重排或"顺手优化"
// 只会让老库和新库走出不同的状态。

/** 当前 schema 版本。加一步迁移就 +1，并在 `MIGRATIONS` 末尾追加。 */
export const SCHEMA_VERSION = 3

/** 只依赖 `node:sqlite`，不依赖 electron */
type Db = import('node:sqlite').DatabaseSync

/** kv 表的读（JSON 反序列化；缺失/坏值回落 fallback）——与 `LuminDatabase.kvGet` 同语义 */
function kvGet<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

/** kv 表的写（JSON 序列化 + upsert）——与 `LuminDatabase.kvSet` 同语义 */
function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now())
}

/**
 * 一次性迁移：老的 kv `fileEncodings`（`{ [小写路径]: 编码 }`，插入序当 LRU）→ `documents` 表。
 * 迁完把 kv 键清掉并打标记，避免每次启动都扫一遍；取不到 documents 行（文件还没进索引）
 * 的条目保留在 kv 里作兜底 —— 宁可多留一点，也不要让用户手选的编码凭空丢。
 */
function migrateFileEncodings(db: Db): void {
  if (kvGet<boolean>(db, 'fileEncodingsMigrated', false)) return
  const map = kvGet<Record<string, string> | null>(db, 'fileEncodings', null)
  if (map && typeof map === 'object') {
    const rows = db.prepare('SELECT path FROM documents').all() as unknown as { path: string }[]
    const byLower = new Map(rows.map((r) => [r.path.replace(/\//g, '\\').toLowerCase(), r.path]))
    const leftover: Record<string, string> = {}
    let migrated = 0
    for (const [key, enc] of Object.entries(map)) {
      const path = byLower.get(key)
      if (!path) {
        leftover[key] = enc
        continue
      }
      db.prepare("UPDATE documents SET encoding = ? WHERE path = ? AND encoding = ''").run(
        enc,
        path
      )
      migrated += 1
    }
    kvSet(db, 'fileEncodings', leftover)
    // 主进程 console 输出一律 ASCII（见 tests/mainConsoleAscii.test.mjs）
    console.log(
      `[db] encoding metadata migration: ${migrated} rows into documents, ${Object.keys(leftover).length} rows left in kv`
    )
  }
  kvSet(db, 'fileEncodingsMigrated', true)
}

/** 迁移 1：原 `database.ts` 的建表 / 加列 / 索引 / FTS / 一次性编码迁移（幂等） */
function migration1(db: Db): void {
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // 通知中心：跨会话保留（关闭用 closed_at 软删除，便于日后做历史面板）。
  // scope = 窗口作用域（services/windowScope）：通知属于「产生它的那个窗口」，
  // 多窗口各自独立，不会一条提示在所有窗口同时弹出。
  db.exec(`
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
  const notifCols = db.prepare('PRAGMA table_info(notifications)').all() as unknown as {
    name: string
  }[]
  const hasCol = (n: string): boolean => notifCols.some((c) => c.name === n)
  if (!hasCol('actions')) {
    db.exec("ALTER TABLE notifications ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'")
  }
  if (!hasCol('payload')) {
    db.exec("ALTER TABLE notifications ADD COLUMN payload TEXT NOT NULL DEFAULT ''")
  }
  if (!hasCol('scope')) {
    db.exec("ALTER TABLE notifications ADD COLUMN scope TEXT NOT NULL DEFAULT ''")
    // 旧库里的通知是「全局共享」时期的产物，无法归属到任何窗口，一次性清掉，
    // 否则它们会在所有窗口都查不到（查询按 scope 过滤）却永久占着表空间。
    db.exec("DELETE FROM notifications WHERE scope = ''")
  }
  // 索引必须等 scope 列确定存在后再建（旧库此时才刚 ALTER 出来）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notifications_scope_open
      ON notifications(scope, closed_at, created_at DESC);
  `)
  // 旧索引被 (scope, closed_at, created_at) 覆盖，去掉避免写放大
  db.exec('DROP INDEX IF EXISTS idx_notifications_open')
  // ── 文档级元数据（Wave 2）：编码 / 行尾 / BOM ──────────────────────────────
  // 以前编码活在这一进程的 current 上、再配一张 kv 表（fileEncodings），
  // 结果是「两个窗口开同一文件各说各话、重启后还得靠 kv 兜」。现在落进 documents：
  // 权威、可查、跟着文件走。空串 = 尚未记录（按判定链/默认值处理）。
  const docCols = db.prepare('PRAGMA table_info(documents)').all() as unknown as {
    name: string
  }[]
  const hasDocCol = (n: string): boolean => docCols.some((c) => c.name === n)
  if (!hasDocCol('encoding')) {
    db.exec("ALTER TABLE documents ADD COLUMN encoding TEXT NOT NULL DEFAULT ''")
  }
  if (!hasDocCol('eol')) {
    db.exec("ALTER TABLE documents ADD COLUMN eol TEXT NOT NULL DEFAULT ''")
  }
  if (!hasDocCol('had_bom')) {
    db.exec('ALTER TABLE documents ADD COLUMN had_bom INTEGER NOT NULL DEFAULT 0')
  }
  migrateFileEncodings(db)
  // 编辑器右键菜单的动作使用记录：驱动「最近使用」分区（跨会话保留）
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_usage (
      action_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      last_used INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_menu_usage_last_used ON menu_usage(last_used DESC);
  `)
  // 链接打开历史：设置面板可查看/删除/清空（跨会话保留，避免只活在 session 里）
  db.exec(`
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
  // 本地历史（Wave 2 数据安全）：每次写盘前把**即将被覆盖的那一版**留一份。
  // 为什么要有：现在保存成功就清草稿，一次误保存（全选删除后 Ctrl+S）无法挽回 ——
  // 对写作工具这是信誉问题。抽稀策略在 shared/history.ts（纯函数，有单测）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      encoding TEXT NOT NULL DEFAULT '',
      eol TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_history_path_saved
      ON documents_history(path, saved_at DESC);
  `)
  // FTS5：trigram 分词器（对中日韩文本支持子串匹配；支持片段高亮）
  const ftsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'")
    .get() as { sql: string } | undefined
  if (ftsRow && !ftsRow.sql.includes('trigram')) {
    db.exec('DROP TABLE documents_fts')
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content,
      tokenize = 'trigram case_sensitive 0'
    );
  `)
  // 已有文档重建索引（旧表被替换 / 首次迁移时）
  const indexed = db.prepare('SELECT COUNT(*) AS c FROM documents_fts').get() as unknown as {
    c: number
  }
  if (indexed.c === 0) {
    const rows = db.prepare('SELECT id, title, content FROM documents').all() as unknown as {
      id: number
      title: string
      content: string
    }[]
    const del = db.prepare('DELETE FROM documents_fts WHERE rowid = ?')
    const ins = db.prepare('INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)')
    for (const row of rows) {
      del.run(row.id)
      ins.run(row.id, row.title, row.content)
    }
  }
}

/**
 * 迁移 2：历史表加一列 `bytes`（UTF-8 字节数）。
 *
 * 为什么需要（审计 §2 P2「主进程同步 SQLite 在大库时会卡顿」）：
 * `pruneHistory` 每次保存都要知道每条历史**占多少字节**，而它原来现算
 * `LENGTH(content)` —— 那是对 TEXT 求字符数，SQLite 得把整篇正文解码一遍。
 * 实测（2000 条 × 30 万字符 ≈ 1.6GB 历史）：一次扫描 **2.3 秒**；按字节上限把历史
 * 压到 64MB 后仍有 ~90ms，而这是**每次保存**都要付的（主进程同步 API，直接卡住窗口）。
 *
 * 改成"写入时就记下字节数"之后，抽稀只需要读行头（id/path/saved_at/bytes），
 * 与正文体积无关。`size` 列保持原语义（字符数，界面显示用），不动它。
 *
 * 回填用 `LENGTH(CAST(content AS BLOB))`：只在这**一次**迁移里付一次全表扫描的代价。
 */
function migration2(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(documents_history)').all() as unknown as {
    name: string
  }[]
  if (!cols.some((c) => c.name === 'bytes')) {
    db.exec('ALTER TABLE documents_history ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0')
  }
  // 回填历史行：`bytes = 0` 只可能是"从没写过字节数"（空正文的真实字节数也是 0，
  // 回填成 0 无害）。已经有值的行不重算，避免每次启动都扫一遍正文。
  // ⚠️ SQLite 里字符串字面量只能用单引号：`""` 会被当成**标识符**（报 no such column）。
  db.exec(
    "UPDATE documents_history SET bytes = LENGTH(CAST(content AS BLOB)) WHERE bytes = 0 AND content <> ''"
  )
}

/**
 * 迁移 3：删除 `menu_usage` 表（右键菜单「最近使用」已下线）。
 *
 * 右键菜单只保留静态分区，不再记录/读取动作使用频次，因此这张表没有存在意义。
 * 用 `DROP TABLE IF EXISTS` 而不是只在启动时忽略：老库里的记录也一并清掉，
 * 避免"功能已删、数据还躺着"的残留。迁移 1 里的 CREATE 是历史步骤，按本文件
 * 的约定**不改**，让空库也走同一条可复现的路径。
 */
function migration3(db: Db): void {
  db.exec('DROP TABLE IF EXISTS menu_usage')
}

/** 迁移步骤表：**只许追加**，不许改已发布步骤的语义（见文件头注释） */
const MIGRATIONS: { version: number; up: (db: Db) => void }[] = [
  { version: 1, up: migration1 },
  { version: 2, up: migration2 },
  { version: 3, up: migration3 }
]

/** 读当前库的 schema 版本（无用户表时 SQLite 返回 0） */
export function readSchemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * 把库跑到最新版本：从 `user_version + 1` 开始依次执行未跑过的步骤。
 *
 * **整轮包在事务里**（审计 §2 P1：此前每步各自 exec，中途失败会留下
 * "表改了一半、user_version 还停在旧值"的库 —— 下次启动从头再跑一遍，
 * 对 ALTER TABLE 这类不可重入的步骤就是直接崩）。
 * `PRAGMA user_version` 在事务里同样生效（SQLite 允许），所以"结构改动 + 版本号"
 * 要么一起生效、要么一起回滚。注意：`VACUUM` 不能放进事务 —— 迁移列表里不要用它。
 *
 * 返回实际跑了哪些步骤，调用方可以据此打一行 ASCII 日志。
 */
export function runMigrations(db: Db): { from: number; to: number; ran: number[] } {
  const from = readSchemaVersion(db)
  const ran: number[] = []
  const pending = MIGRATIONS.filter((s) => s.version > from)
  if (!pending.length) return { from, to: SCHEMA_VERSION, ran }
  db.exec('BEGIN')
  try {
    for (const step of pending) {
      step.up(db)
      db.exec(`PRAGMA user_version = ${step.version}`)
      ran.push(step.version)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚也失败时保留原始错误 */
    }
    throw err
  }
  return { from, to: SCHEMA_VERSION, ran }
}
