/**
 * ─── 路径工具（渲染层共用）──────────────────────────────────────────────────
 * 「同一个文件」「是否在某个文件夹里」这两件事在主进程与渲染层都要判，因此**纯字符串**
 * 的那半边收在 `src/shared/paths.ts`（一份实现、一份单测；审计 §10「重复实现」），
 * 这里只做渲染层自己的两件事：目录链计算（`ancestorDirs`）与对外保持原有 API。
 *
 * ⚠️ 这里的 `isInside` 是**字面**比较（不解析 `..`）。要防"工作区逃逸"请用主进程那份
 * （`src/main/pathGuard.ts`，会 resolve）。
 */
import { isInsideByString, normPath, parentDir, samePath } from '../../../shared/paths.ts'

export { normPath, samePath, parentDir }

/** p 是否**字面上**位于 dir 之内（含 dir 自身）；按目录边界比较，`C:\Docs` 不包含 `C:\Docs2` */
export function isInside(dir: string | null | undefined, p: string): boolean {
  return isInsideByString(dir, p)
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
