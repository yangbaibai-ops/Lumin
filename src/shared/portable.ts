// ─── 便携版（免安装 + 数据随身）的数据目录判定（报告 §P2「功能缺口：便携版」）────
//
// 便携版的两种含义，必须分清（这是产品决策，不只是实现细节）：
//   * **免安装**：exe 双击就跑，不写注册表、不建开始菜单 —— 这是 electron-builder 的
//     `portable` target 给的（见 electron-builder.yml 的 portable 段）；
//   * **数据随身**：索引/草稿/设置/会话跟着 exe 走（插到别的机器上还是你那份）。
//     ⚠️ 这一条**不是**打包器给的：Electron 默认仍把 userData 放在 `%APPDATA%\<name>`，
//     所以"绿色版"如果只换打包 target，用户会以为数据在 U 盘里、其实留在本机
//     （换台机器打开就"全空了"，而旧机器上那份数据还在 —— 这类困惑最难排查）。
//
// 所以本模块负责第二条：electron-builder 的 portable target 运行时会设
// `PORTABLE_EXECUTABLE_DIR`（可执行文件所在目录），我们据此把 userData 改到 exe 旁边。
//
// 为什么是纯函数：判定只依赖环境变量字典，`node --test` 能直接钉住（见 tests/portable.test.mjs），
// 不用真去打一个便携包才能验证。
//
// ⚠️ 隐私提示（必须写进文档，也要在界面上留一句）：数据跟着 U 盘走 = **U 盘丢了数据就丢了**，
// 而且换到别人机器上打开时，你的笔记会出现在那台机器上。设置里可以关闭（见 main/index.ts 的口径）。

/** 便携模式下的数据目录名（放在 exe 同级，避免与用户的其它文件混在一起） */
export const PORTABLE_DATA_DIR_NAME = 'LuminData'

/** electron-builder 便携版运行时会注入的环境变量名 */
export const PORTABLE_DIR_ENV = 'PORTABLE_EXECUTABLE_DIR'

/**
 * 便携模式下 userData 应该用哪个目录。
 *
 * @param env 环境变量字典（通常传 `process.env`）
 * @returns 便携数据目录的绝对路径；**不是便携模式**时返回 `null`（调用方据此保持 Electron 默认）
 */
export function portableDataDir(env: Record<string, string | undefined>): string | null {
  const raw = env[PORTABLE_DIR_ENV]
  if (typeof raw !== 'string') return null
  const dir = raw.trim()
  if (!dir) return null
  // 统一分隔符：末尾斜杠去掉（Windows 上 'D:\Lumin\' 与 'D:\Lumin' 是同一个目录，
  // 留着会让拼出来的路径出现双斜杠，日志里看着像 bug）
  const trimmed = dir.replace(/[\\/]+$/, '')
  if (!trimmed) return null
  // 便携目录必须是可执行的**同级目录**；落在 asar 里说明调用方把环境变量搞错了，
  // 那种路径写不进去（只读），宁可不改 userData 也不要造一个必然失败的路径
  if (/\.asar($|[\\/])/i.test(trimmed)) return null
  const sep = trimmed.includes('\\') ? '\\' : '/'
  return `${trimmed}${sep}${PORTABLE_DATA_DIR_NAME}`
}
