// ─── 主进程：安全的文件系统操作 ────────────────────────────────────────────
import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { db } from './services/database'
import { decodeBuffer, encodeText } from './services/encoding'
import type { FileNode, WorkspaceDoc } from '../shared/types'
import type { ConcreteEncoding, EncodingId } from '../shared/encodings'

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

/**
 * 读文件（**原始字节**，不做任何编码假设）。
 * 编码判定放在 services/encoding（判定链 + 每文件记忆），这里只负责把字节交出去。
 */
export async function readFileInfo(
  filePath: string,
  requested: EncodingId = 'auto',
  remembered?: EncodingId | null
): Promise<{ content: string; mtimeMs: number; encoding: ConcreteEncoding; hadBom: boolean }> {
  const stat = await fs.stat(filePath)
  const raw = await fs.readFile(filePath)
  const { text, encoding, hadBom } = decodeBuffer(raw, requested, remembered)
  return { content: text, mtimeMs: stat.mtimeMs, encoding, hadBom }
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

/** 把一段 Markdown 文本转成纯文本预览（去符号、去行首标记、折叠空白） */
function toPlainPreview(text: string, max = 140): string {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|>|-{3,}|\*{3,}|```)/.test(l) && l.trim())
    .map((l) => l.replace(/[`*_~\[\]()!#>]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const plain = lines.join(' ').trim()
  return plain.length > max ? plain.slice(0, max).trimEnd() + '…' : plain
}

/** 读取文件头部的预览文本（只读前 ~1KB，避免大文件全量读取） */
async function readPreviewHead(filePath: string, bytes = 1024): Promise<string> {
  try {
    const fh = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      return toPlainPreview(buf.subarray(0, bytesRead).toString('utf8'))
    } finally {
      await fh.close()
    }
  } catch {
    return ''
  }
}

/** 递归扫描工作区根目录下的全部 Markdown 文章，返回扁平条目。
    用于侧边栏「列表」视图（Typora 式）：展示每篇的修改时间与正文预览。
    - 只统计 md/markdown/mdown/mkd/txt；
    - 跳过隐藏目录（.git/.obsidian 等）以提速并避免噪音；
    - 并发受限 + 行数上限，超大工作区也能安全返回。 */
export async function scanWorkspace(root: string): Promise<WorkspaceDoc[]> {
  const docs: WorkspaceDoc[] = []
  const MAX_DOCS = 4000
  const MAX_DEPTH = 24
  let cancelled = false

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (cancelled || depth > MAX_DEPTH) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs: import('fs').Dirent[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        dirs.push(e)
      } else if (e.isFile() && MD_EXT_RE.test(e.name)) {
        if (docs.length >= MAX_DOCS) {
          cancelled = true
          return
        }
        try {
          const stat = await fs.stat(p)
          docs.push({
            name: e.name,
            relPath: relDir,
            path: p,
            mtimeMs: stat.mtimeMs,
            preview: await readPreviewHead(p)
          })
        } catch {
          /* 读取失败的条目跳过 */
        }
      }
    }
    // 并发遍历子目录（目录数通常有限）
    await Promise.all(
      dirs.map((d) => walk(path.join(dir, d.name), relDir ? `${relDir}/${d.name}` : d.name, depth + 1))
    )
  }

  await walk(root, '', 0)
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'zh-CN'))
  return docs
}

/**
 * 写文件：按指定编码编成字节再落盘（默认 UTF-8，保持旧行为）。
 * `hadBom` 为真时补回文件原有的 BOM——「原样写回」不该平白少一个 BOM。
 */
export async function writeFile(
  filePath: string,
  content: string,
  encoding: ConcreteEncoding = 'utf-8',
  hadBom = false
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, encodeText(content, encoding, hadBom))
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
