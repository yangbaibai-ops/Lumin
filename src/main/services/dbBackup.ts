// ─── 主进程：SQLite 库的定时备份（审计 §2 P1）────────────────────────────────
//
// 问题原话：「历史库是唯一副本且它也在同一 userData」。本地历史（`documents_history`）
// 是"写错了还能回去"的最后一层，而它自己没有任何副本 —— 磁盘误删、勒索、同步盘回滚，
// 这一层跟着一起没。
//
// 做法刻意保持最小：**定时把库文件复制一份到另一个目录**，保留最近 7 份。
//   * 不导出 JSON：导出要走一遍全表序列化，而"复制文件"是内核搬字节，几秒的事；
//     而且库文件本身就是完整可打开的一份（用户拿 SQLite 工具能直接看，不需要我们解密/还原）；
//   * 不写增量：库不大（写作工具的元数据 + 历史正文），7 份全量是能接受的代价，
//     换来的是"任何一份都是自洽的"，不必担心链断了中间某一份没意义。
//
// 目录默认 `<userData>/backups`，但**用户可以指定到别的盘**：备份和原库同盘时，
// 一次磁盘/勒索事件会把两者一起带走，那就不叫备份了。
import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { db } from './database'
import * as fileOps from '../fileOps'
import { defaultSettings } from '../../shared/defaults'
import {
  BACKUP_KEEP,
  DEFAULT_BACKUP_SUBDIR,
  backupPolicy,
  dbBackupName,
  isBackupDue,
  isDbBackupName,
  planBackupPrune
} from '../../shared/backup'
import type { AppSettings, BackupFileInfo, BackupResult, BackupStatus } from '../../shared/types'

/**
 * kv 里记住"上次成功备份的时刻"，**按目录分开记**。
 *
 * 为什么要带目录：不区分目录时，从 A 盘换到 B 盘会读到 A 盘刚写的记录 → 判定"还没到点"，
 * 于是新目录**一份备份都没有**却要等一天（实测就是这么暴露的）。带上目录后，
 * 空目录一定是"该备"。
 */
const lastBackupKey = (dir: string): string => `backup:lastAt:${dir.toLowerCase()}`

/** 未指定目录时的落点 */
export function defaultBackupDir(): string {
  return path.join(app.getPath('userData'), DEFAULT_BACKUP_SUBDIR)
}

/** 当前生效的备份目录（设置里的优先） */
export function backupDir(): string {
  const settings = db.kvGet<AppSettings>('settings', defaultSettings)
  return backupPolicy(settings).dir ?? defaultBackupDir()
}

/** 目录里的库备份（新的在前）。只认我们自己命名的文件，别人的文件一概不碰 */
export async function listBackups(dir: string = backupDir()): Promise<BackupFileInfo[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // 目录还不存在 = 没有备份（不是错误）
  }
  const out: BackupFileInfo[] = []
  for (const name of names) {
    if (!isDbBackupName(name)) continue
    try {
      const st = await fs.stat(path.join(dir, name))
      if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 读不到的条目跳过 */
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

/**
 * 这个目录里最近一次备份的时刻。三级判据，顺序很重要：
 *   1. **目录里一份都没有** → null（该备）。不管 kv 说什么 —— 用户可能刚把目录清空/换盘；
 *   2. 有我们自己的记录 → 用记录。它是我们写的，不受同步盘/复制工具改 mtime 的影响；
 *   3. 没有记录（换机器、kv 被重置）→ 退回文件 mtime。保守：可能因此少备一次，
 *      但不会因为一个假信号把轮换顺序搞乱。
 */
export async function lastBackupMs(
  dir: string = backupDir(),
  files?: BackupFileInfo[]
): Promise<number | null> {
  const list = files ?? (await listBackups(dir))
  if (!list.length) return null
  const stored = Number(db.kvGet<number>(lastBackupKey(dir), 0))
  if (Number.isFinite(stored) && stored > 0) return stored
  return Math.max(...list.map((f) => f.mtimeMs))
}

/** 状态快照（设置界面显示目录 / 份数 / 上次时间） */
export async function backupStatus(): Promise<BackupStatus> {
  const settings = db.kvGet<AppSettings>('settings', defaultSettings)
  const policy = backupPolicy(settings)
  const dir = policy.dir ?? defaultBackupDir()
  const files = await listBackups(dir)
  return {
    dir,
    isDefaultDir: !policy.dir,
    auto: policy.auto,
    keep: BACKUP_KEEP,
    lastMs: await lastBackupMs(dir, files),
    files
  }
}

/**
 * 立刻备份一次。
 *
 * 顺序很重要：先 `flushFtsIndex()`（搜索索引还在 2s 节流队列里，不清空就把索引落下一截）
 * 再 `checkpoint()`（WAL 里的新数据合并进主库文件并截断 WAL）——做完这两步，
 * **主库文件单独一份就是完整的**（否则复制出来的库缺最近的写入，还会留下不匹配的 -wal）。
 *
 * 复制失败不抛出：备份是后台行为，调用方（启动路径）不该因为它挂掉；
 * 原因放在返回值里，手动触发时由界面提示。
 */
export async function runBackup(kind: 'auto' | 'manual' = 'manual'): Promise<BackupResult> {
  const dir = backupDir()
  const base: BackupResult = { ok: false, path: null, bytes: 0, dir, kept: 0, removed: 0, kind }
  try {
    await fs.mkdir(dir, { recursive: true })
    const dest = path.join(dir, dbBackupName(new Date()))
    db.flushFtsIndex()
    db.checkpoint()
    await fileOps.copyFileAtomic(db.path, dest)

    const files = await listBackups(dir)
    const removed = await pruneBackups(dir, files)
    const kept = await listBackups(dir)
    const bytes = kept.find((f) => f.name === path.basename(dest))?.size ?? 0
    db.kvSet(lastBackupKey(dir), Date.now())
    // 主进程 console 一律 ASCII（tests/mainConsoleAscii.test.mjs）
    console.log(`[backup] ${kind} ok: ${kept.length} file(s), pruned ${removed}`)
    return { ...base, ok: true, path: dest, bytes, kept: kept.length, removed }
  } catch (err) {
    console.log(`[backup] ${kind} failed`)
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 按"保留最近 N 份"删掉多余的（只删我们自己命名的文件） */
async function pruneBackups(dir: string, files: BackupFileInfo[]): Promise<number> {
  const doomed = planBackupPrune(
    files.map((f) => f.name),
    BACKUP_KEEP
  )
  let removed = 0
  for (const name of doomed) {
    try {
      await fs.rm(path.join(dir, name), { force: true })
      removed += 1
    } catch {
      /* 删不掉就算了：下次备份还会再试，库本身已经安全落盘 */
    }
  }
  return removed
}

/** 到点才备份（启动时与每 6 小时各调一次，判断很便宜） */
export async function maybeAutoBackup(): Promise<void> {
  const settings = db.kvGet<AppSettings>('settings', defaultSettings)
  if (!backupPolicy(settings).auto) return
  if (!isBackupDue(await lastBackupMs(), Date.now())) return
  await runBackup('auto')
}

/** 每 6 小时看一眼：应用可能连开好几天，只在启动时判断的话"定时"就成了空话 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 启动自动备份：**延迟 20 秒**再跑第一次，别和建窗/恢复会话抢那几百毫秒。
 * 之后每 6 小时查一次（不是每 6 小时备一次：`maybeAutoBackup` 自己按 24 小时判）。
 */
export function startAutoBackup(): void {
  setTimeout(() => {
    void maybeAutoBackup()
  }, 20_000)
  const timer = setInterval(() => {
    void maybeAutoBackup()
  }, AUTO_CHECK_INTERVAL_MS)
  // 不因为这个定时器让进程活着（Electron 有自己的生命周期）
  timer.unref?.()
}
