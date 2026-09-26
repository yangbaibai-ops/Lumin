import path from 'path'
import { existsSync } from 'fs'
import { db } from './database'
import * as openDocs from './openDocs'
import * as session from './session'

/**
 * ─── 路径授权表：渲染层能读写哪些路径 ────────────────────────────────────────────
 *
 * 背景（审计 §4）：`file:read` / `file:write` / `file:exists` 此前只做 `path.resolve`，
 * **没有任何范围限制** —— 渲染层任何一处注入（或某个被污染的前端依赖）就直接拿到
 * "用户权限下的全盘任意读写"。渲染层本身是自有代码、且开着 contextIsolation/sandbox，
 * 所以这不是"现在可被利用的漏洞"，而是**最后一道防线缺失**。
 *
 * 口径（**只收窄，不改变任何正常流程**）。合法来源就那么几个，逐个登记：
 *   1. **工作区根**（kv 里的 workspace.root）→ 整棵子树可读写；
 *   2. **用户通过对话框选过的东西**（打开文件 / 另存为 / 选文件夹）→ 精确文件读写、目录子树读写；
 *   3. **启动参数**（`--lumin-open` / `--lumin-open-folder`、双击文件、跳转列表）→ 主进程自己解析的；
 *   4. **当前打开的文档**（openDocs 注册表）→ 该文件可读写；它所在目录只读（正文里的相对图片要用）；
 *   5. **会话里记录的文档/文件夹**（重启恢复）→ 同 2；
 *   6. **以前打开过的文档**（documents 表）→ 只读（"最近文档"列表点进来的那条路）；
 *   7. **用户拖进窗口的文件** → 只读，且必须已存在（见 `grantDroppedRead`）。
 *   8. **用户点了文档里的链接**（`links:resolve` 只由链接激活路径调用）→ 目标只读（目录则整棵子树），
 *      同样要求已存在。没有这一条，"打开工作区外的链接目标"会被第 9 条闸门一起挡掉。
 *
 * `shell:openPath`（把路径交给系统默认应用）现在也读这张表（清单 §4 P1）：它此前是"任意路径
 * 直通 OS"的入口，扩展名黑名单挡得住可执行/脚本，却挡不住"把任意文件交出去"这一类。
 *
 * ⚠️ **它不是什么**（写清楚免得误导后来者）：这不是能力沙箱。第 7/8 条那两条 IPC 是渲染层可调的，
 * 一个被完全控制的渲染层仍然能"先申请、再读/再打开"。它挡的是：
 *   * 文档内容驱动的路径（`![](../../../某文件)`、链接解析、会话/最近列表里的脏数据）；
 *   * 渲染层**静默**的任意路径访问（现在会以一个明确的错误暴露出来，可查、可断言）。
 * 真要做沙箱，得把文件访问整体改成"主进程持句柄 + 渲染层拿 token"的模型（另立里程碑）。
 */

/** 归一化：Windows 大小写不敏感 + 分隔符统一 + 去尾分隔符 */
function norm(p: string): string {
  return path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 精确授权的文件 → 'write' 表示读写，'read' 表示只读 */
const files = new Map<string, 'read' | 'write'>()
/** 授权目录（含整棵子树） */
const dirs = new Set<string>()

/** 用户通过对话框选了一个文件（要写它，例如"另存为"的目标） */
export function grantFileReadWrite(p: string): void {
  files.set(norm(p), 'write')
}

/** 用户拖进窗口的文件：只读，且**必须真实存在**（否则不给它留一个"将来会存在"的口子） */
export function grantDroppedRead(p: string): boolean {
  const key = norm(p)
  if (files.get(key) === 'write') return true
  if (!existsSync(p)) return false
  files.set(key, 'read')
  return true
}

/** 授权一个目录（整棵子树） */
export function grantDir(p: string): void {
  dirs.add(norm(p))
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

function isInside(dir: string, target: string): boolean {
  const d = norm(dir)
  const t = norm(target)
  return t === d || t.startsWith(d + '\\')
}

/**
 * 该路径是否被授权。`write` 比 `read` 严：只有"工作区 / 授权目录 / 用户选定的文件 /
 * 当前打开的文档"这几类能写 —— 只读来源（拖入、历史打开过的文档）不能升级成写。
 */
export function isAuthorized(target: string, mode: 'read' | 'write' = 'read'): boolean {
  const t = norm(target)
  const exact = files.get(t)
  if (exact === 'write') return true

  const root = workspaceRoot()
  if (root && isInside(root, t)) return true

  for (const d of dirs) {
    if (t === d || t.startsWith(d + '\\')) return true
  }

  // 当前打开的文档：文件本身可读写；它所在目录**只读**（正文里的相对图片要用）
  const open = openDocs.listOpenDocs()
  for (const doc of open) {
    if (norm(doc) === t) return true
  }
  if (mode === 'read') {
    if (exact === 'read') return true
    for (const doc of open) {
      if (isInside(path.dirname(doc), t)) return true
    }
    // 会话里记录的文档 / 文件夹（重启恢复那条路）：按"用户上次用过"授权
    for (const slot of session.readSession().slots) {
      if (!slot) continue
      if (slot.path && norm(slot.path) === t) return true
      if (slot.path && isInside(path.dirname(slot.path), t)) return true
      if (slot.folder && isInside(slot.folder, t)) return true
    }
    // 以前打开过的文档（documents 表）：最近文档 / 全局搜索结果的落点
    try {
      if (db.getDocument(target)) return true
    } catch {
      /* 库不可用时不因此拒绝：下面还有兜底 */
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

/** 校验入口（`read` / `write` 两种口径），不通过就抛 */
export function assertAuthorized(p: string, mode: 'read' | 'write' = 'read'): string {
  const abs = path.resolve(p)
  if (!isAuthorized(abs, mode)) throw new PathNotAuthorized(abs)
  return abs
}

/** 诊断用：当前授权范围快照（"导出诊断信息"与套件都会读它） */
export function grantedSnapshot(): { workspace: string | null; dirs: string[]; files: number } {
  return { workspace: workspaceRoot(), dirs: [...dirs], files: files.size }
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
