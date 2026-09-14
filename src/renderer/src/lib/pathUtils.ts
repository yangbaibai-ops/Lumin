/**
 * ─── 路径工具（渲染层共用）──────────────────────────────────────────────────
 * 「同一个文件」「是否在某个文件夹里」这两件事在主进程（services/openDocs）与渲染层
 * （lib/openFile、stores/files）都要判，因此抽成独立模块，避免 store ↔ lib 互相 import
 * 形成环，也保证两边判据完全一致（Windows 大小写不敏感 + 分隔符归一 + 目录边界）。
 */

/** 路径归一：正反斜杠统一、去掉尾部分隔符、Windows 下转小写 */
export function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 两个路径是否指向同一个文件 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

/** p 是否位于 dir 之内（含 dir 自身）；按目录边界比较，`C:\Docs` 不会把 `C:\Docs2` 判成内部 */
export function isInside(dir: string | null | undefined, p: string): boolean {
  if (!dir) return false
  const d = normPath(dir)
  const t = normPath(p)
  return t === d || t.startsWith(d + '\\')
}

/** 取父目录（与主进程 path.dirname 等价，避免为了算父目录再走一次 IPC） */
export function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (i < 0) return ''
  if (i === 2 && /^[a-zA-Z]:/.test(trimmed)) return trimmed.slice(0, 3) // `C:\x` → `C:\`
  return trimmed.slice(0, i)
}

/** 从 root 到 p 的父目录链（含 root 与 p 的父目录），用于在侧栏里逐级展开到某个文件 */
export function ancestorDirs(root: string, p: string): string[] {
  if (!isInside(root, p)) return []
  const out: string[] = []
  let cur = parentDir(p)
  const rootNorm = normPath(root)
  while (cur && normPath(cur).length >= rootNorm.length) {
    out.unshift(cur)
    if (normPath(cur) === rootNorm) break
    const next = parentDir(cur)
    if (!next || next === cur) break
    cur = next
  }
  return out
}
