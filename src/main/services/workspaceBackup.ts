// ─── 主进程：工作区快照（打成 zip 导出到别处）────────────────────────────────
//
// 审计 §2 P1 要的另一半：「导出工作区快照（zip）」。库备份只兜住历史与元数据，
// 而**文档正文的权威副本在磁盘上** —— 工作区被误删/被同步盘回滚/被勒索加密时，
// 用户需要的是"把我的文件夹整体拷出来一份"，而不是一篇一篇另存。
//
// 三个刻意的取舍：
//   1. **不全量照抄**：跳过隐藏目录（`.git`/`.obsidian`）、`node_modules`、
//      我们自己的写盘临时文件（半写状态的全文副本），以及单个超大的二进制
//      —— 备份不该把构建产物和几十 GB 视频一起搬走；
//   2. **有总量上限**（`SNAPSHOT_MAX_TOTAL_BYTES`）：到顶后**如实报告**跳过了哪些，
//      而不是偷偷少收录（用户以为备份完整、真出事时才发现少了一半）；
//   3. 先扫完再写：zip 在内存里组装，扫描与写入分开做才不会一边写一边把自己也扫进去。
import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { zipDeflate, type ZipEntry } from '../zip'
import * as fileOps from '../fileOps'
import { testOutputDir } from '../testPaths'
import {
  SNAPSHOT_MAX_TOTAL_BYTES,
  snapshotEntryName,
  snapshotSkipReason,
  workspaceSnapshotName
} from '../../shared/backup'
import type { SnapshotResult, SnapshotSkipped } from '../../shared/types'

/** 扫描深度上限（与 `scanWorkspace` 一致）：软链接环 / 病态目录树不至于把栈跑爆 */
const MAX_DEPTH = 32

/**
 * 扫描工作区，产出 zip 条目。
 * 目录条目**不写进 zip**：ZIP 允许不建目录直接放 `a/b/c.md`，解压工具会自动建目录，
 * 少写一堆条目。符号链接不跟随（`withFileTypes` 下它既不是 file 也不是 directory），
 * 避免一个指向父目录的链接把整棵树拉成环。
 */
async function collectEntries(
  root: string,
  excludeName: string | null
): Promise<{ entries: ZipEntry[]; bytes: number; skipped: SnapshotSkipped }> {
  const entries: ZipEntry[] = []
  const skipped: SnapshotSkipped = { hidden: 0, temp: 0, huge: 0, overflow: 0 }
  let bytes = 0
  let full = false

  const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || full) return
    let dirents: import('fs').Dirent[]
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 读不了的目录跳过（权限/已删除），不中断整次快照
    }
    for (const dirent of dirents) {
      const name = dirent.name
      const abs = path.join(dir, name)
      if (dirent.isDirectory()) {
        const reason = snapshotSkipReason(name, 0, true)
        if (reason) {
          skipped.hidden += 1
          continue
        }
        await walk(abs, snapshotEntryName(relDir, name), depth + 1)
        continue
      }
      if (!dirent.isFile()) continue // 符号链接 / 设备文件：不跟随
      if (name === excludeName && relDir === '') continue // 不把将要写出的那一份扫进来
      let size: number
      try {
        size = (await fs.stat(abs)).size
      } catch {
        continue
      }
      const reason = snapshotSkipReason(name, size)
      if (reason) {
        skipped[reason] += 1
        continue
      }
      if (bytes + size > SNAPSHOT_MAX_TOTAL_BYTES) {
        full = true
        skipped.overflow += 1
        continue
      }
      try {
        const data = await fs.readFile(abs)
        entries.push({ name: snapshotEntryName(relDir, name), data })
        bytes += data.length
      } catch {
        /* 读失败的文件跳过 */
      }
    }
  }

  await walk(root, '', 0)
  return { entries, bytes, skipped }
}

/**
 * 把工作区打成 zip。
 * @param root 工作区根目录
 * @param destPath 目标路径；不给就走「另存为」对话框（取消时返回 null）
 */
export async function snapshotWorkspace(
  root: string,
  destPath?: string
): Promise<SnapshotResult | null> {
  const stat = await fs.stat(root).catch(() => null)
  if (!stat?.isDirectory()) throw new Error('WORKSPACE_NOT_OPEN')

  let dest = destPath ?? null
  if (!dest) {
    const name = workspaceSnapshotName(new Date())
    const testDir = testOutputDir()
    const picked = testDir
      ? { canceled: false, filePath: path.join(testDir, name) }
      : await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
          defaultPath: name,
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        })
    if (picked.canceled || !picked.filePath) return null
    dest = picked.filePath
  }

  // 目标文件若就在工作区里，扫描时按名字跳过（否则上一次的快照会被打进这一次）
  const exclude =
    path.dirname(path.resolve(dest)) === path.resolve(root) ? path.basename(dest) : null
  const { entries, bytes, skipped } = await collectEntries(root, exclude)
  if (!entries.length) throw new Error('WORKSPACE_EMPTY')

  const data = zipDeflate(entries)
  await fileOps.writeBinary(dest, data)
  console.log(`[backup] workspace snapshot: ${entries.length} file(s)`)
  return { path: dest, files: entries.length, bytes, zipBytes: data.length, skipped }
}
