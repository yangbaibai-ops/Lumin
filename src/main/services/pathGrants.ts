import path from 'path'
import { existsSync, realpathSync } from 'fs'
import { db } from './database'
import * as openDocs from './openDocs'
import * as session from './session'
import { isPathAllowed, type PathGrantsSnapshot } from './pathGrantPolicy'

/**
 * ─── 路径授权表：渲染层能读写哪些路径 ────────────────────────────────────────────
 *
 * 背景（审计 §4 / P1-2）：`file:read` / `file:write` / `file:exists` 此前只做
 * `path.resolve`，**没有任何范围限制** —— 渲染层任何一处注入就直接拿到"用户权限下的
 * 全盘任意读写"。授权表补上之后，又暴露出两个可自我扩权的口子：
 *   ① `file:authorizeUserPath`：渲染层传任意路径就会被登记为只读授权；
 *   ② `app:openFolderInNewWindow`：渲染层传任意目录就会 `grantStartup` 成工作区（可写）。
 * 本版把两者都收掉：**授权只能由主进程在用户手势之后写入**（原生对话框 / 启动参数 /
 * 会话恢复 / 真实链接点击），渲染层没有任何"申请授权"的通道。
 *
 * 授权来源（逐个登记，且写权限只给前四类）：
 *   1. **工作区根**（kv 里的 workspace.root）→ 整棵子树可读写；
 *   2. **用户通过对话框选过的东西**（打开/另存为/选文件夹）→ 精确文件或目录子树可读写；
 *   3. **启动参数**（`--lumin-open` / `--lumin-open-folder`、双击文件、跳转列表）→ 主进程解析；
 *   4. **当前打开的文档**（openDocs 注册表）→ 该文件可读写；它所在目录只读（正文图片用）；
 *   5. **会话里记录的文档/文件夹**（重启恢复）→ 只读；
 *   6. **以前打开过的文档**（documents 表）→ 只读（"最近文档"点进来的那条路）；
 *   7. **用户点了文档里的链接**（`links:resolve`）→ 目标只读（目录则整棵子树只读）；
 *   8. **测试期信任路径**（仅开发态 `LUMIN_TRUSTED_PATHS`，打包产物忽略）。
 *
 * ─── 为什么每一步都要 realpath ────────────────────────────────────────────────
 * 纯字符串前缀判定挡不住 junction / symlink / 8.3 短名：工作区里放一个指向
 * `C:\Windows` 的 junction，`link/win.ini` 在字符串上位于工作区内，实际读到的是系统文件
 * （审计实测：`file:read` 读到 win.ini、`lumin-file://` 读到工作区外的壁纸）。
 * 现在统一 `realpathDeep()`：目标与**每一条授权根**都解析成真实路径后再交给纯判据
 * `isPathAllowed()`（src/main/services/pathGrantPolicy.ts，有单测）。
 *
 * ⚠️ 它仍然不是能力沙箱（见审计原文）：挡的是"文档内容驱动的路径"与"渲染层静默的任意
 * 路径访问"，并把拒绝变成可审计的日志；真正的沙箱需要"主进程持句柄 + token"模型。
 */

/** 归一化：Windows 大小写不敏感 + 分隔符统一 + 去尾分隔符 */
function norm(p: string): string {
  return path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * 解析到**真实路径**：路径本身不存在时，向上找到最近的已存在祖先，把它 realpath 之后
 * 再把剩余段拼回去。
 *
 * 为什么不能只对已存在目标 realpath：另存为的目标文件还不存在；`C:\ws\link\new.md`
 * 里的 `new.md` 不存在，但 `link` 是 junction —— 只查字符串会允许写到 `C:\Windows\new.md`。
 * 逐级向上解析就能挡住这一整类"尚不存在"的逃逸。
 */
export function realpathDeep(p: string): string {
  const abs = path.resolve(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs // 盘符根都解析不了（网络盘离线等）：退回字面绝对路径
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/** 精确授权的文件：'write' 读写，'read' 只读 */
const files = new Map<string, { mode: 'read' | 'write'; path: string }>()
/** 授权目录（整棵子树可写） */
const dirs = new Map<string, string>()
/** 只读目录（整棵子树只读：链接目标目录 / 会话文件夹等） */
const readDirs = new Map<string, string>()

/** 用户通过对话框选了一个文件（要写它，例如"另存为"的目标） */
export function grantFileReadWrite(p: string): void {
  files.set(norm(p), { mode: 'write', path: p })
}

/**
 * 只读文件授权（用户点了文档里的链接 / 以前打开过的文件）。
 * **必须是已存在的真实路径**：不给"将来会存在"的口子留授权。
 */
export function grantFileRead(p: string): boolean {
  const key = norm(p)
  const existing = files.get(key)
  if (existing?.mode === 'write') return true
  if (!existsSync(p)) return false
  files.set(key, { mode: 'read', path: p })
  return true
}

/** 授权一个目录（整棵子树可写；只用于对话框/启动参数这类用户明确动作） */
export function grantDir(p: string): void {
  dirs.set(norm(p), p)
}

/** 授权一个目录（整棵子树**只读**；链接目标、会话文件夹用这个） */
export function grantDirRead(p: string): void {
  const key = norm(p)
  if (dirs.has(key)) return
  readDirs.set(key, p)
}

/** 启动参数里的文件/目录（主进程解析出来的，天然可信） */
export function grantStartup(file?: string | null, folder?: string | null): void {
  if (file) grantFileReadWrite(file)
  if (folder) grantDir(folder)
}

/** 工作区根（kv 是唯一真相源，动态读，不缓存） */
export function workspaceRoot(): string | null {
  return db.kvGet<{ root: string | null }>('workspace', { root: null }).root
}

/**
 * 组装当前授权快照（**所有路径先 realpath**）。这是 `isPathAllowed` 的唯一输入，
 * 也是"fs 读取与 `lumin-file://` 走同一个校验函数"的落点。
 */
export function snapshot(): PathGrantsSnapshot {
  const root = workspaceRoot()
  const readFiles = new Set<string>()
  const writeFiles = new Set<string>()
  const readDirSet = new Set<string>()
  const writeDirSet = new Set<string>()

  if (root) writeDirSet.add(realpathDeep(root))
  for (const d of dirs.values()) writeDirSet.add(realpathDeep(d))
  for (const d of readDirs.values()) readDirSet.add(realpathDeep(d))
  for (const f of files.values()) {
    const real = realpathDeep(f.path)
    if (f.mode === 'write') writeFiles.add(real)
    else readFiles.add(real)
  }
  // 当前打开的文档：文件读写；所在目录只读（正文里的相对图片要用）
  for (const doc of openDocs.listOpenDocs()) {
    readFiles.add(realpathDeep(doc))
    writeFiles.add(realpathDeep(doc))
    readDirSet.add(realpathDeep(path.dirname(doc)))
  }
  // 会话里记录的文档 / 文件夹（重启恢复那条路）：只读
  for (const slot of session.readSession().slots) {
    if (!slot) continue
    if (slot.path) {
      readFiles.add(realpathDeep(slot.path))
      readDirSet.add(realpathDeep(path.dirname(slot.path)))
    }
    if (slot.folder) readDirSet.add(realpathDeep(slot.folder))
  }
  return {
    workspace: root ? realpathDeep(root) : null,
    dirs: [...writeDirSet],
    files: [...writeFiles],
    readDirs: [...readDirSet],
    readFiles: [...readFiles]
  }
}

/**
 * 该路径是否被授权。
 *
 * 判据顺序：先 realpath，再用纯函数 `isPathAllowed` 判范围；最后才看 documents 表里的
 * **精确历史路径**（那是"最近文档"的正常入口，只给读）。
 *
 * 历史文档为什么用 `abs` 而不是 realpath 查：库里的路径就是用户上次打开时的那一条
 * （可能是 junction/短名）。它本身就是用户意图的登记；而它指向的**真实位置**已经由
 * `realpathDeep(abs)` 算出来并参与范围判定 —— 不存在"库里有记录就能读任意目标"。
 */
export function isAuthorized(target: string, mode: 'read' | 'write' = 'read'): boolean {
  const abs = path.resolve(target)
  const real = realpathDeep(abs)
  if (isPathAllowed(real, snapshot(), mode)) return true
  if (mode === 'read') {
    try {
      if (db.getDocument(abs)) return true
    } catch {
      /* 库不可用时不因此拒绝：范围判定已经做完 */
    }
  }
  return false
}

/** 拒绝时抛的错误（渲染层会把它显示给用户；也便于套件断言） */
export class PathNotAuthorized extends Error {
  constructor(p: string) {
    super(`PATH_NOT_AUTHORIZED: ${p}`)
    this.name = 'PathNotAuthorized'
  }
}

/** 拒绝日志：**ASCII**（Windows 控制台按代码页解读），一行一条，便于取证 */
function logDenied(p: string, mode: 'read' | 'write'): void {
  // 路径里的非 ASCII 用 encodeURI 转义，console 永远只看到 ASCII
  console.warn(`[path-grant] denied ${mode}: ${encodeURI(p)}`)
}

/** 校验入口（`read` / `write` 两种口径），不通过就抛并记日志 */
export function assertAuthorized(p: string, mode: 'read' | 'write' = 'read'): string {
  const abs = path.resolve(p)
  if (!isAuthorized(abs, mode)) {
    logDenied(abs, mode)
    throw new PathNotAuthorized(abs)
  }
  return abs
}

/**
 * 校验通过后返回**真实路径**（已解析 junction/symlink）。
 * `lumin-file://` 与导出读图用它去 `fs`/`net.fetch`，避免"检查的是字符串、读的是链接"。
 */
export function assertAuthorizedReal(p: string, mode: 'read' | 'write' = 'read'): string {
  const abs = assertAuthorized(p, mode)
  return realpathDeep(abs)
}

/**
 * `openFolderInNewWindow` 的专属校验：**要当工作区打开的目录**。
 *
 * 比 `read` 更严一档：必须是已授权目录（工作区 / 对话框选过 / 会话文件夹），并且
 * 真实存在且是目录。仅"最近列表里出现过"的目录也认（那是用户上次的选择）。
 */
export function canOpenFolderAsWorkspace(p: string): boolean {
  const abs = path.resolve(p)
  const real = realpathDeep(abs)
  if (isPathAllowed(real, snapshot(), 'read')) return true
  return false
}

/**
 * **开发/测试专用**的信任路径（环境变量 `LUMIN_TRUSTED_PATHS`，`path.delimiter` 分隔）。
 *
 * 为什么需要它：CDP 套件大量使用"自己造一份夹具文件、再直接 `openPath(临时路径)`"的手法，
 * 而那条路径在生产里必然来自某个入口（对话框 / 拖入 / 启动参数 / 会话 / 最近列表 / 工作区）——
 * 套件绕过了这些入口，于是会被授权闸拦下（实测 `_verify-session` 8/17 红）。
 * 与其去改二十多个套件（并把"每个入口都要授权"这个契约糊掉），不如把"测试期的信任范围"
 * 显式声明出来：`tools/run-suites.js` 与 `tools/start-isolated.ps1` 都会把它设成 `%TEMP%`。
 *
 * ⚠️ **只在 `is.dev`（未打包）时生效**：打包产物永远忽略这个变量 —— 否则任何启动器
 * 都能用一行环境变量把授权表打开（那才是真的后门）。
 */
export function grantTrustedPathsFromEnv(dev: boolean, raw: string | undefined): number {
  if (!dev || !raw) return 0
  let granted = 0
  for (const part of raw.split(path.delimiter)) {
    const p = part.trim()
    if (!p || !existsSync(p)) continue
    grantDir(p)
    granted += 1
  }
  return granted
}
