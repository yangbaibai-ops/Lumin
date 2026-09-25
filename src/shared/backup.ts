// ─── 备份策略（纯函数，可单测）──────────────────────────────────────────────
//
// 审计 §2 P1 的原话是「没有任何自动备份 / 工作区级导出」：历史库是**唯一副本**，
// 而它和文档一起躺在同一个 `%APPDATA%\Lumin` 里 —— 磁盘误删、勒索、同步盘回滚，
// 应用层没有任何兜底。这里放两层备份里**与平台无关**的那部分判断：
//
//   1. **库备份**（`main/services/dbBackup.ts`）：定时把 SQLite 文件复制到用户指定目录，
//      按"保留最近 N 份"轮换；
//   2. **工作区快照**（`main/services/workspaceBackup.ts`）：把整个工作区打成 zip。
//
// 留在 shared 的理由和 `shared/history.ts` 一样：抽稀规则写错的后果是**删掉用户唯一的数据**，
// 这种代码必须能在单测里直接喂输入、看输出，而不是只有真跑一遍应用才知道。
import type { AppSettings } from './types.ts'
import { isTempFileName } from './tempName.ts'

/** 保留多少份库备份（一天一份 ≈ 一周） */
export const BACKUP_KEEP = 7
/** 两次自动备份之间的最小间隔 */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单个文件超过这么大就不进工作区快照（几十 MB 的视频/归档塞进 zip 只会把内存吃光） */
export const SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024
/**
 * 一次快照收录的源字节总量上限：到顶后不再收录，**如实报告**跳过了多少。
 * 定 256MB 是因为 ZIP 是在内存里拼出来的（原始条目 + 压缩结果同时在）。
 * 真到顶时宁可少一份快照也不要让主进程被 OOM 掉 —— 那会连正在写的稿子一起没。
 */
export const SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
/** 未指定备份目录时的落点：`<userData>/backups`（用子目录名，避免和库文件混在一起） */
export const DEFAULT_BACKUP_SUBDIR = 'backups'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * 本地时间戳 `YYYYMMDD-HHmm`。
 * 用**本地**时间而不是 UTC：文件名是给人看的，用户按自己的钟找"昨天那份"。
 * 格式可字典序排序，`planBackupPrune` 直接靠它定新旧（不需要读 mtime）。
 */
export function backupStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  )
}

/** 库备份文件名：`lumin-20260924-1530.db` */
export function dbBackupName(d: Date): string {
  return `lumin-${backupStamp(d)}.db`
}

/** 工作区快照文件名：`lumin-workspace-20260924-1530.zip` */
export function workspaceSnapshotName(d: Date): string {
  return `lumin-workspace-${backupStamp(d)}.zip`
}

/** 库备份文件名的严格形状（用来把"我们生成的"和用户自己丢进去的文件分开） */
export const DB_BACKUP_RE = /^lumin-\d{8}-\d{4}\.db$/

/** 是不是我们自己生成的库备份 */
export function isDbBackupName(name: string): boolean {
  return DB_BACKUP_RE.test(name)
}

/**
 * 轮换：保留最新的 `keep` 份，返回**要删掉**的文件名（从旧到新）。
 *
 * 为什么"要删的"由名字算而不是 mtime：文件名里已经是可排序的时间戳，
 * 而 mtime 会被复制/同步工具改写（用户把备份目录丢进网盘后，mtime 就不再是备份时间）。
 * 非我们命名的文件一律不碰 —— 备份目录可能是用户自己选的现有目录。
 */
export function planBackupPrune(names: string[], keep: number = BACKUP_KEEP): string[] {
  const mine = names.filter(isDbBackupName).sort()
  const excess = mine.length - Math.max(0, Math.floor(keep))
  return excess > 0 ? mine.slice(0, excess) : []
}

/**
 * 现在该不该自动备份。
 * 时钟被往回调（`lastMs > nowMs`）时判为**不该**：否则每启动一次都会多出一份，
 * 而文件名戳会在未来，轮换顺序也会乱。
 */
export function isBackupDue(
  lastMs: number | null | undefined,
  nowMs: number,
  intervalMs: number = BACKUP_INTERVAL_MS
): boolean {
  if (!lastMs || !Number.isFinite(lastMs) || lastMs <= 0) return true
  if (lastMs > nowMs) return false
  return nowMs - lastMs >= intervalMs
}

/**
 * 从设置里取出备份口径。
 * 特意**不信任**存下来的类型：设置是一整块 JSON 存在 kv 里，老 profile 里没有这两个键，
 * 用户手改文件也可能写进一个字符串 —— 备份路径写错的后果是往奇怪的地方写文件。
 */
export function backupPolicy(s: Partial<AppSettings> | null | undefined): {
  dir: string | null
  auto: boolean
} {
  const raw = s?.backupDir
  const dir = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  // 只有显式 `false` 才是关：老 profile 里没有这个键，缺省应当是**开**（数据安全优先）
  return { dir, auto: s?.backupAuto !== false }
}

/** 快照跳过原因（null = 收录） */
export type SnapshotSkip = 'hidden' | 'temp' | 'huge'

/**
 * 这个条目该不该进工作区快照。
 *
 * 跳过三类：
 *   * `hidden`：`.git`/`.obsidian`/`.DS_Store` …… 不属于用户的稿件；
 *   * `temp`：我们自己的写盘临时文件（`<name>.<8位>.lumin-tmp`）—— 里面是半写状态的
 *     全文副本，收进归档只会在恢复时把人搞糊涂；
 *   * `huge`：单个文件过大（见 `SNAPSHOT_MAX_FILE_BYTES`）。
 * 另外 `node_modules` 一律跳过（目录维度）：那是构建产物，不是内容。
 */
export function snapshotSkipReason(name: string, size: number, isDir = false): SnapshotSkip | null {
  if (name.startsWith('.')) return 'hidden'
  if (isDir) return name === 'node_modules' ? 'hidden' : null
  if (isTempFileName(name)) return 'temp'
  if (size > SNAPSHOT_MAX_FILE_BYTES) return 'huge'
  return null
}

/**
 * ZIP 里条目的名字。**必须**是正斜杠：ZIP 规范用 `/`，Windows 的 `path.join` 会给反斜杠，
 * 于是解压出来会变成一个字面量叫 `a\b.md` 的文件（单测钉住这条）。
 */
export function snapshotEntryName(relDir: string, name: string): string {
  return relDir ? `${relDir}/${name}` : name
}

/** 字节数 → 人读（设置界面与提示共用一份；渲染层也用它） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
