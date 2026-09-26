import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { LOG_FILE, logLine, shouldRotate } from '../../shared/logPolicy'

/**
 * ─── 运行日志落盘（审计 §4 P2 / §9 P1）────────────────────────────────────────
 *
 * 为什么需要它：本文件取代了原来直接写 `%TEMP%\lumin-build.log` 的写法 —— 那个位置
 * **所有本机进程都能读**，而内容里带着 cwd / appPath / argv（含用户文档路径），
 * 打包态也照写，且没有上限、没有轮转。现在的落点是 `<userData>/logs/app.log`：
 * 与设置/草稿/数据库同一个 profile 目录，权限一致；超过 `MAX_LOG_BYTES` 轮转成 `app.log.1`。
 *
 * 写日志失败**绝不影响功能**：整段包在 try/catch 里，任何一步异常都静默跳过。
 */

/** 日志目录（`app:openLogDir` 与诊断页都用它，避免"说的和写的不是一个地方"） */
export function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

/** 某个日志文件的绝对路径 */
export function logPath(name: string = LOG_FILE): string {
  return join(logDir(), name)
}

/**
 * 追加一行日志（JSON 单行）。超过上限时先轮转：`app.log` → `app.log.1`（覆盖上一代）。
 * 轮转放在**写之前**判断，保证单文件不会长过上限。
 */
export function appendLog(entry: Record<string, unknown>, name: string = LOG_FILE): void {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const file = logPath(name)
    try {
      if (existsSync(file) && shouldRotate(statSync(file).size)) renameSync(file, file + '.1')
    } catch {
      /* 轮转失败就继续追加：总比丢日志强 */
    }
    appendFileSync(file, logLine(entry))
  } catch {
    /* 日志是辅助能力：写不进去也不该影响启动/编辑/保存 */
  }
}

/** 主进程未捕获异常 / 未处理 rejection 的落盘（保持"崩溃就是崩溃"，只是留下证据） */
export function recordFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const e = err as { message?: string; stack?: string } | undefined
  appendLog({
    level: 'fatal',
    kind,
    message: e?.message ?? String(err),
    // 栈只留前 4KB：一份栈足够定位，又不至于把日志顶爆
    stack: typeof e?.stack === 'string' ? e.stack.slice(0, 4096) : undefined,
    version: (() => {
      try {
        return app.getVersion()
      } catch {
        return undefined
      }
    })(),
    packaged: (() => {
      try {
        return app.isPackaged
      } catch {
        return undefined
      }
    })()
  })
}
