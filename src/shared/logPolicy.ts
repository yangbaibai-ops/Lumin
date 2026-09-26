// ─── 运行日志的策略（纯函数，可单测）────────────────────────────────────────────
//
// 背景（审计 §4 P2 / §9 P1）：应用此前把「本次跑的是哪份构建」与「启动意图」写进
// **`%TEMP%\lumin-build.log`** —— 打包态也写，内容是 cwd / appPath / argv（含用户文档路径），
// 而且**没有上限、没有轮转、关不掉**；诊断页还把 `%TEMP%` 列成"日志目录"。
// 临时目录是所有本机进程都能读的地方，写作类应用的"最近打开过哪些文件"不该躺在那里。
//
// 现在的口径：
//   * 位置：`<userData>/logs/app.log`（与设置/草稿/数据库同一个 profile 目录，权限一致）；
//   * 有界：单个文件超过 `MAX_LOG_BYTES` 就轮转成 `app.log.1`（只留一代，总量 ≤ 2×上限）；
//   * 写失败绝不影响功能（日志是辅助能力）。
//
// 这一层刻意是**纯函数**（`tests/appLog.test.mjs` 直接测），与 Electron 打交道的那半在
// `main/services/appLog.ts`。

/** 单个日志文件的上限：512KB（一代 512KB + 上一代 512KB，总量有界且够排查几次启动） */
export const MAX_LOG_BYTES = 512 * 1024

/** 日志文件名（轮转后的上一代是 `<name>.1`） */
export const LOG_FILE = 'app.log'

/** 尺寸是否到了该轮转的点（`>=` 而不是 `>`：正好等于上限也该换一份） */
export function shouldRotate(size: number, max: number = MAX_LOG_BYTES): boolean {
  return size >= max
}

/** 日志行：单行 JSON（带 ISO 时间戳）—— 便于 `Select-String` / `jq` 直接过滤 */
export function logLine(
  entry: Record<string, unknown>,
  at: string = new Date().toISOString()
): string {
  return JSON.stringify({ at, ...entry }) + '\n'
}
