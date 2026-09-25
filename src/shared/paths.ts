// ─── 跨进程共用的**纯字符串**路径工具（可单测、不依赖 node:path / electron）────
//
// 为什么要有这个文件（审计 §10「重复实现」）：
//   `isInside` / `samePath` 此前**三份**：主进程 `fileOps.ts`（用 node:path）、
//   主进程 `launchIntent.ts`（自己一份 norm）、渲染层 `lib/pathUtils.ts`（第三份）。
//   渲染层那份有单测，主进程两份**不被任何测试引用** —— 而 `isInside` 正是
//   「工作区逃逸」护栏（`assertWorkspacePath` 用它）。三份漂移不会被任何门禁发现。
//
// 这里放纯字符串那一半（渲染层也要用，不能引 node:path）；
// 需要**解析 `..`** 的那一半在主进程 `src/main/pathGuard.ts`（它引 node:path，另有单测）。
//
// ⚠️ 纯字符串版本**不做 `..` 解析**：`C:\ws\sub\..\..\evil` 会被它判成"在 ws 之内"。
//    凡是"用户可控路径 + 要防逃逸"的场景，必须用主进程那份 `pathGuard.isInside`。
/** 路径归一：正反斜杠统一、去掉尾部分隔符、小写（Windows 大小写不敏感） */
export function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 两个路径是否指向同一个文件（大小写与分隔符不敏感） */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

/**
 * p 是否**字面上**位于 dir 之内（含 dir 自身）；按目录边界比较，
 * `C:\Docs` 不会把 `C:\Docs2` 判成内部。**不做 `..` 解析**（见文件头说明）。
 */
export function isInsideByString(dir: string | null | undefined, p: string): boolean {
  if (!dir) return false
  const d = normPath(dir)
  const t = normPath(p)
  return t === d || t.startsWith(d + '\\')
}

/** 取父目录（不引 node:path，渲染层也能用） */
export function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (i < 0) return ''
  if (i === 2 && /^[a-zA-Z]:/.test(trimmed)) return trimmed.slice(0, 3) // `C:\x` → `C:\`
  return trimmed.slice(0, i)
}
