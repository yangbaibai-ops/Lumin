// ─── 主进程：安全的文件系统操作 ────────────────────────────────────────────
import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { db } from './services/database'
import type { FileNode } from '../shared/types'

export const MD_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i

export function normalize(p: string): string {
  return path.normalize(p)
}

export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 校验工作区内的路径（防路径遍历） */
export function assertWorkspacePath(p: string): string {
  // 工作区根目录的唯一数据源是 SQLite kv（workspace:setRoot/getRoot 读写于此），
  // 不能用 electron-store 的 workspaceStore（其值仅在启动迁移时同步一次，之后
  // setRoot 只写 SQLite 不再回写 electron-store，导致校验使用过期根目录 →
  // 新打开的文件夹被判定为「工作区之外」而列表为空）。
  const root = db.kvGet<{ root: string | null }>('workspace', { root: null }).root
  if (!root) throw new Error('WORKSPACE_NOT_OPEN')
  const resolved = path.resolve(p)
  if (!isInside(root, resolved)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  return resolved
}

export async function readFileInfo(filePath: string): Promise<{ content: string; mtimeMs: number }> {
  const stat = await fs.stat(filePath)
  const raw = await fs.readFile(filePath, 'utf-8')
  // 剥离 UTF-8 BOM，避免影响 Markdown 解析
  const content = raw.replace(/^\uFEFF/, '')
  return { content, mtimeMs: stat.mtimeMs }
}

export async function readDir(dir: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nodes = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || MD_EXT_RE.test(e.name)))
      .map(async (e): Promise<FileNode> => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) return { name: e.name, path: p, type: 'directory' }
        await fs.stat(p)
        return { name: e.name, path: p, type: 'file' }
      })
  )
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return nodes
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/** 生成不冲突的文件名：base.md → base-1.md */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = path.join(dir, `${stem}${ext}`)
  let i = 1
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`)
    i += 1
  }
  return candidate
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function removeEntry(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  await fs.rename(oldPath, newPath)
}

export function toFileUrl(p: string): string {
  return pathToFileURL(p).href
}
