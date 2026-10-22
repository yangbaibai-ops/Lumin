// ─── 路径授权的**纯判据**（审计 P1-2）───────────────────────────────────────
//
// 为什么把这一点逻辑单独抽出来：授权表（pathGrants）要读 kv / openDocs / 会话，
// 那些依赖 electron 与 SQLite，进不了 `node --test`。而"一个**已经 realpath 过的**
// 路径是否落在授权集合内"是完全纯的字符串判定 —— 它恰恰是安全边界本身，必须被单测
// 钉住（`..`、大小写、尾随分隔符、UNC、盘符根、同前缀不同目录）。
//
// ⚠️ 调用方必须传**已解析符号链接/junction** 的路径（`realpathDeep`）。本函数只做
// 字符串层判定：`C:\ws\link\win.ini` 在字符串上位于 `C:\ws` 内，只有 realpath 之后
// 才知道它其实是 `C:\Windows\win.ini`。
import path from 'node:path'

/** 一份授权快照（所有路径都应当是 realpath 之后的绝对路径） */
export interface PathGrantsSnapshot {
  /** 工作区根：整棵子树可读写 */
  workspace?: string | null
  /** 整棵子树可写的目录（用户通过对话框选过 / 启动参数 / 会话记住的文件夹） */
  dirs?: readonly string[]
  /** 精确可读写文件 */
  files?: readonly string[]
  /** 整棵子树**只读**（当前打开文档所在目录、会话文档目录、链接目标目录等） */
  readDirs?: readonly string[]
  /** 精确**只读**文件（打开中的文档、会话/历史文档、链接目标） */
  readFiles?: readonly string[]
}

/** 大小写折叠 + 统一分隔符 + 解析 `.`/`..` + 去尾分隔符（盘符根与 UNC 根保留） */
export function canonicalPath(p: string): string {
  let s = path.win32.resolve(String(p ?? '').replace(/\//g, '\\'))
  // 去尾分隔符；但 `C:\` 与 `\\server\share\` 这类根保留一个
  const withoutTrailing = s.replace(/\\+$/, '')
  if (/^[a-zA-Z]:$/.test(withoutTrailing)) s = withoutTrailing + '\\'
  else if (withoutTrailing) s = withoutTrailing
  return s.toLowerCase()
}

/** target 是否位于 dir 之内（含 dir 自身）；两侧都先 canonical */
export function isInsideDir(dir: string, target: string): boolean {
  const d = canonicalPath(dir)
  const t = canonicalPath(target)
  if (!d || !t) return false
  const rel = path.win32.relative(d, t)
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel))
}

/** 精确匹配（大小写不敏感、分隔符/尾随分隔符归一） */
function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

/**
 * 这个（已 realpath 的）路径是否被授权。
 *
 * `write` 比 `read` 严：只读来源（打开中的文档目录、会话/历史文档、链接目标）
 * 不能升级成写。工作区、用户选定目录、精确选定文件三类可写。
 *
 * @param realTarget 已经 `realpath` 过的绝对路径（见文件头说明）
 * @param grants     授权快照（`pathGrants.snapshot()` 组装）
 * @param mode       read / write
 */
export function isPathAllowed(
  realTarget: string,
  grants: PathGrantsSnapshot,
  mode: 'read' | 'write' = 'read'
): boolean {
  const t = canonicalPath(realTarget)
  if (!t) return false
  if (grants.workspace && isInsideDir(grants.workspace, t)) return true
  for (const d of grants.dirs ?? []) if (isInsideDir(d, t)) return true
  for (const f of grants.files ?? []) if (samePath(f, t)) return true
  if (mode === 'write') return false
  for (const d of grants.readDirs ?? []) if (isInsideDir(d, t)) return true
  for (const f of grants.readFiles ?? []) if (samePath(f, t)) return true
  return false
}
