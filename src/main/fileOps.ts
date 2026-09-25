// ─── 主进程：安全的文件系统操作 ────────────────────────────────────────────
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { shell } from 'electron'
import type { Dirent } from 'fs'
import { pathToFileURL } from 'url'
import { db } from './services/database'
import { decodeBuffer, encodeText } from './services/encoding'
import * as openDocs from './services/openDocs'
import type { FileNode, WorkspaceDoc } from '../shared/types'
import type { ConcreteEncoding, EncodingId } from '../shared/encodings'
import { detectEol, toEol, toLf, type Eol } from '../shared/eol'
import { isMediaExtension, isWithinAnyRoot } from '../shared/media'

export const MD_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i

/**
 * 该绝对路径能否经 `lumin-file://` 送出（两道闸，见 main/index.ts 的 protocol.handle 注释）：
 *  1. 扩展名在媒体白名单里；
 *  2. 位于「当前工作区」或「某个已打开文档所在目录」之内。
 * 两条规则本身是纯函数，在 shared/media.ts（可单测）；这里只负责取「当前的根」。
 */
export function isServableMedia(p: string): boolean {
  if (!isMediaExtension(p)) return false
  const workspaceRoot = db.kvGet<{ root: string | null }>('workspace', { root: null }).root
  const docDirs = openDocs.listOpenDocs().map((doc) => path.dirname(doc))
  return isWithinAnyRoot(p, [workspaceRoot, ...docDirs])
}

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
): Promise<{
  content: string
  mtimeMs: number
  encoding: ConcreteEncoding
  hadBom: boolean
  eol: Eol
}> {
  const stat = await fs.stat(filePath)
  const raw = await fs.readFile(filePath)
  const { text, encoding, hadBom } = decodeBuffer(raw, requested, remembered)
  // 行尾是**文档级元数据**：这里判定一次并归一内存形态（LF），
  // 写回时再由 writeFile 展开回去，见 shared/eol.ts
  const eol = detectEol(text)
  return { content: toLf(text), mtimeMs: stat.mtimeMs, encoding, hadBom, eol }
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
    .map((l) =>
      l
        .replace(/[`*_~[\]()!#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
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
  // 标签一次取全（`documents.tags`），扫描时逐条附着 —— 列表视图要按标签过滤，
  // 逐个文件查库在 4000 篇的工作区上是 4000 次查询。键统一小写比较：Windows 路径不区分大小写。
  const tagIndex = db.tagsByPath()

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
            preview: await readPreviewHead(p),
            tags: tagIndex[p.toLowerCase()] ?? []
          })
        } catch {
          /* 读取失败的条目跳过 */
        }
      }
    }
    // 并发遍历子目录（目录数通常有限）
    await Promise.all(
      dirs.map((d) =>
        walk(path.join(dir, d.name), relDir ? `${relDir}/${d.name}` : d.name, depth + 1)
      )
    )
  }

  await walk(root, '', 0)
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'zh-CN'))
  return docs
}

/**
 * 写文件：按指定编码编成字节再落盘（默认 UTF-8，保持旧行为）。
 * `hadBom` 为真时补回文件原有的 BOM——「原样写回」不该平白少一个 BOM。
 *
 * ─── 为什么是「临时文件 + fsync + rename」而不是直接 writeFile ──────────────────
 * 直接覆盖原文件时，**写入中途**断电/崩溃/磁盘满/被杀进程会把用户唯一的一份稿件截断或半写，
 * 而写作工具没有第二次机会。同目录 rename 在 Windows 与 POSIX 上都是原子的：
 * 磁盘上任何时刻只可能是「完整旧版」或「完整新版」。
 *
 * （本地历史早已落地，是**另一层**保护：写盘前把「即将被覆盖的那一版」留一份快照，
 *  见 `services/database.ts` 的历史表与 `ipc.ts` 的写盘钩子；两层的分工是
 *  「原子写 = 不产生坏文件」「历史快照 = 写错了还能回去」。）
 *
 * 三个细节：
 *  1. 临时文件与目标**同目录**（跨盘 rename 不是原子操作）；
 *  2. 先 `fsync` 再 rename —— 保证 rename 生效时数据已经落盘，而不是只改了目录项；
 *  3. 临时文件名带**随机后缀**（`<name>.<8位随机>.lumin-tmp`）：固定名在「同一文件被两个
 *     窗口同时写」时会让两个 fd 从偏移 0 互相覆盖、各自 rename，落盘的是 A 的头 + B 的尾。
 *     随机后缀下两个写入者各写各的临时文件，最后 rename 的是**完整**的一份
 *     （仍是"后到者胜"，但不会再产生混合内容）。残留由启动时的 `cleanStaleTempFiles` 扫掉。
 *     扩展名不在 `.md` 白名单里，也不会进文件树。
 *
 * @returns 写盘后磁盘上的**真实 mtimeMs** —— 渲染层据此把 `mtimeMs` 记成真实值，
 *   而不是用 `Date.now()` 冒充（冒充会让"外部是否改过"这类判断永远失效）。
 */
export async function writeFile(
  filePath: string,
  content: string,
  encoding: ConcreteEncoding = 'utf-8',
  hadBom = false,
  eol?: Eol
): Promise<number> {
  // 行尾在**这一层**统一展开：所有落盘路径（保存、另存为、导出走的都是这里）都不会漏。
  // eol 缺省 = 不做行尾处理（老调用方行为不变）。
  const text = eol ? toEol(content, eol) : content
  const bytes = encodeText(text, encoding, hadBom)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.lumin-tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, filePath)
  } catch (err) {
    // 失败时收拾干净并原样抛出：调用方（渲染层）负责把**原因**告诉用户
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  // rename 之后再 stat：此刻磁盘上的就是刚写进去的那一份
  const st = await fs.stat(filePath)
  return st.mtimeMs
}

/**
 * 写**二进制**（粘贴进编辑器的图片等）：与 `writeFile` 同一套原子写
 * （同目录临时文件 → fsync → rename，随机后缀），只是不碰编码与行尾。
 *
 * 为什么不让渲染层自己拼 `file:write`：那是**文本**通道（会做编码/行尾处理），
 * 把 PNG 字节塞进去等于先按 UTF-8 解读再编码，图必然坏。
 */
export async function writeBinary(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.lumin-tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, filePath)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * 生成不冲突的文件名（`note.png` → `note-1.png`），与「新建文件」同一套编号规则。
 * 只用于插入图片这类"给我一个能用的名字"的场景。
 */
export async function uniqueName(dir: string, name: string): Promise<string> {
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

/**
 * 把一张**外部图片**复制进目标目录（拖入 / 「选择文件…」都走这里），返回写入后的绝对路径。
 * 名字冲突时自动编号，绝不覆盖已有文件。
 */
export async function importImage(source: string, dir: string, baseName: string): Promise<string> {
  const target = await uniqueName(dir, baseName)
  await fs.copyFile(source, target)
  return target
}

/** 写盘临时文件名的后缀（`<name>.<8位随机>.lumin-tmp`）—— 清理扫描与文档口径共用一份 */
export const TEMP_SUFFIX_RE = /\.[0-9a-f]{8}\.lumin-tmp$/i

/**
 * 清理目录树里残留的写盘临时文件（打开工作区时跑一次）。
 *
 * 为什么必须有：崩溃/断电时临时文件不会被 catch 分支清掉，而它里面是**用户全文的副本**
 * （隐私 + 磁盘占用）。以前靠"下次写同一个文件时被覆盖"自愈 —— 改成随机名之后那条路没了，
 * 必须显式扫。跳过隐藏目录与 node_modules（它们不该有我们的临时文件，也不该被慢扫）。
 */
export async function cleanStaleTempFiles(root: string): Promise<number> {
  let removed = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        await walk(p)
      } else if (TEMP_SUFFIX_RE.test(e.name)) {
        await fs.rm(p, { force: true }).catch(() => {})
        removed += 1
      }
    }
  }
  await walk(root)
  return removed
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 删除文件/目录：**先走系统回收站**，而不是直接 `fs.rm`。
 *
 * 为什么：右键菜单里紧挨着「重命名」的就是这个不可逆动作，写作工具里"误删整个文件夹"
 * 是不可原谅的损失 —— 回收站是**系统已经内置**的撤销机制，没有理由自己再造一个。
 *
 * 降级策略是**明确告知**而不是静默兜底：部分位置（网络盘、FAT/exFAT 移动盘、
 * 组策略禁用回收站）`shell.trashItem` 会失败。这时仍然完成删除（否则用户在这些位置
 * 根本删不掉文件），但把 `trashed: false` 回报给渲染层，由它给一条"已永久删除"的提示。
 */
export async function removeEntry(p: string): Promise<{ trashed: boolean }> {
  try {
    await shell.trashItem(p)
    return { trashed: true }
  } catch {
    await fs.rm(p, { recursive: true, force: true })
    return { trashed: false }
  }
}

/**
 * 重命名。**目标已存在时拒绝**（抛 `TARGET_EXISTS`）——
 * 此前直接 `fs.rename` 在 Windows 上会静默替换目标文件（`MoveFileEx` 的替换语义），
 * 用户"把 a.md 改成 b.md"会毁掉 b.md，而且对 b.md 而言这是"新文件"，本地历史里也没有它。
 *
 * 只改大小写（`a.md` → `A.md`）不算冲突：Windows 文件系统大小写不敏感，
 * `exists()` 对这种目标永远为真，必须按"同一路径"放行，否则改大小写会永远失败。
 */
export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  const same =
    process.platform === 'win32'
      ? path.resolve(oldPath).toLowerCase() === path.resolve(newPath).toLowerCase()
      : path.resolve(oldPath) === path.resolve(newPath)
  if (!same && (await exists(newPath))) throw new Error('TARGET_EXISTS')
  await fs.rename(oldPath, newPath)
}

export function toFileUrl(p: string): string {
  return pathToFileURL(p).href
}
