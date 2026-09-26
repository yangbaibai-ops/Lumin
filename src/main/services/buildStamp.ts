import { app } from 'electron'
import { statSync } from 'fs'
import { appendLog, logPath } from './appLog'

/**
 * ─── 「本次跑的是哪份构建」自检 ────────────────────────────────────────────────
 * 为什么需要它：主进程/preload 是**构建产物**（不像渲染层那样热更新），所以经常出现
 * 「源码里明明有了、应用里却没有」的错配 —— 排查时第一件要确认的事就是**运行中的进程到底
 * 加载了哪份 out/main**。这里往 `<userData>/logs/app.log` 追加一行：
 *   - 进程启动时间、app 版本、Electron/Chrome 版本；
 *   - **主进程 bundle 的 mtime**（= 这份代码是什么时候构建的）；
 *   - 关键能力标记（encoding / taskbar 等），一眼看出这个进程有没有对应功能。
 *
 * 位置改过（审计 §4 P2）：以前写 `%TEMP%\lumin-build.log`（所有本机进程可读、无上限、
 * 打包态也写）。现在与其它运行日志一起落在 profile 目录里，按 `shared/logPolicy` 轮转。
 * 日志路径见 `logPath()` —— 诊断页与「打开日志目录」用的是同一个函数。
 */
export function recordBuildStamp(): void {
  if (app.isPackaged) return
  try {
    const bundle = __filename
    appendLog({
      kind: 'build-stamp',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      mainBundle: bundle,
      mainBuiltAt: (() => {
        try {
          return statSync(bundle).mtime.toISOString()
        } catch {
          return null
        }
      })(),
      features: {
        encoding: true,
        taskbar: true
      }
    })
  } catch {
    /* 自检失败不影响启动 */
  }
}

/**
 * 记录本次启动的「意图解析结果」到同一份日志。
 *
 * 为什么需要：启动参数解析是「静默失败」的重灾区 —— 关联注册了却双击没反应、路径写错、
 * 被 `--` 截断、把 Chromium 开关当成文件路径……这些如果只在内存里判断完就丢掉，用户和排查者
 * 都无从下手。这里把**解析出的意图**与**被忽略的参数及原因**落一行日志，问题一眼可见。
 *
 * 打包态也写（用户报「双击 .md 没反应」时，这一行就是第一手证据）。落点是 profile 里的
 * `logs/app.log`，不再写临时目录 —— 见 `main/services/appLog.ts` 的说明。
 */
export function recordLaunchIntent(record: {
  argv: string[]
  intent: {
    openFile: string | null
    openFolder: string | null
    newWindow: boolean
    noWorkspace: boolean
  }
  ignored: string[]
  cwd: string
  appPath: string
}): void {
  try {
    appendLog({
      kind: 'launch-intent',
      packaged: app.isPackaged,
      version: app.getVersion(),
      cwd: record.cwd,
      appPath: record.appPath,
      argv: record.argv,
      intent: record.intent,
      ignored: record.ignored
    })
  } catch {
    /* 自检失败不影响启动 */
  }
}

/** 便于别处（诊断页）直接引用日志位置，避免"说的和写的不是一个地方" */
export { logPath }
