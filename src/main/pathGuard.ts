// ─── 主进程的路径护栏：**会解析 `..`** 的 isInside ────────────────────────────
//
// 为什么单独成文件（而不是留在 `fileOps.ts` 里）：
//   ① 审计 §10 点名"`isInside` 是工作区逃逸护栏，主进程那份**不被任何测试引用**" ——
//      `fileOps.ts` 引了 electron（`shell`），单测 import 不了它；抽到这里就没有 electron 依赖，
//      可以直接被 `tests/pathGuard.test.mjs` 钉住；
//   ② 纯字符串版本（`shared/paths.ts`）**不解析 `..`**，`C:\ws\sub\..\..\evil` 会被它判成
//      "在 ws 之内"。护栏必须用这一份。
//
// 只依赖 node:path（没有 electron / 没有 fs），所以既能在主进程用，也能被单测直接 import。
import path from 'node:path'

/**
 * p 是否位于 dir 之内（含 dir 自身）。
 *
 * 判据是 `path.relative`：它会先 **resolve**（吃掉 `.` / `..`、补绝对路径、统一分隔符、
 * Windows 上忽略大小写），再看相对结果是不是"往上跳"或又变成了绝对路径。
 * 因此 `C:\ws\..\evil`、`C:\ws\a\..\..\evil`、`C:\ws2`（前缀相同但不是子目录）都能正确拒绝。
 */
export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 两个路径是不是**同一个位置**（Windows 口径的字符串判据）。
 *
 * 为什么不能直接用 `shared/paths.ts` 的 `samePath`：那份是**纯字符串**（只统一分隔符 /
 * 去尾分隔符 / 折叠大小写），**不解析 `.` 与 `..`** —— `C:\ws\pkg\sub\..` 与 `C:\ws\pkg`
 * 在它眼里是两个地方。它自己的注释也写着"需要解析 `..` 的那一半在主进程这份里"。
 *
 * 判据 = `path.win32.resolve` 两侧（吃 `.`/`..`、补绝对路径、统一分隔符、去掉尾分隔符）
 *  + 大小写折叠（Windows 大小写不敏感）。**只做字符串层**，所以：
 *   * 符号链接 / junction：需要 `fs.realpath`，见主进程 `fileOps.isSamePath` 的第二段；
 *   * 8.3 短名（`YANGBA~1`，资源管理器拖进来的路径就是这种）：同样要靠 realpath 展开；
 *   * 相对 / 驱动相对路径（`C:foo`）不该出现在这条链上（两边都是绝对路径），
 *     真出现了 `resolve` 也会把它变成一个确定的绝对路径，不会抛。
 *
 * 为什么显式写 `path.win32` 而不是环境自带的 `path`：应用只发 Windows（见 electron-builder 的
 * win target），而显式 win32 让**单测在任何机器/CI 上跑同一套口径** —— 否则在 POSIX 上跑，
 * `D:\ws` 只是个普通字符串，`..` 也不会被吃掉，测试会得到与产品不同的语义（假绿/假红都有）。
 */
export function sameResolvedPath(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  // 只有空白 = 没给路径：不能拿它去 `resolve`（那样两侧都会变成 cwd，于是"什么都没给"会被判成"相同"）
  if (!a || !b || !a.trim() || !b.trim()) return false
  return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase()
}
