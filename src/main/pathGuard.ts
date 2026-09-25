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
