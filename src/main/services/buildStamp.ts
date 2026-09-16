import { app } from 'electron'
import { appendFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * ─── 开发态「本次跑的是哪份构建」自检 ─────────────────────────────────────────
 * 为什么需要它：主进程/preload 是**构建产物**（不像渲染层那样热更新），所以经常出现
 * 「源码里明明有了、应用里却没有」的错配 —— 排查时第一件要确认的事就是**运行中的进程到底
 * 加载了哪份 out/main**。这里在开发态往 %TEMP%\lumin-build.log 追加一行：
 *   - 进程启动时间、app 版本、Electron/Chrome 版本；
 *   - **主进程 bundle 的 mtime**（= 这份代码是什么时候构建的）；
 *   - 关键能力标记（encoding / taskbar 等），一眼看出这个进程有没有对应功能。
 * 打包态不写（用户机器上不该留这种东西）。
 */
export function recordBuildStamp(): void {
  if (app.isPackaged) return
  try {
    const bundle = __filename
    const stamp = {
      startedAt: new Date().toISOString(),
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
    }
    appendFileSync(join(tmpdir(), 'lumin-build.log'), JSON.stringify(stamp) + '\n')
  } catch {
    /* 自检失败不影响启动 */
  }
}

/**
 * 记录本次启动的「意图解析结果」到同一份自检日志。
 *
 * 为什么需要：启动参数解析是「静默失败」的重灾区 —— 关联注册了却双击没反应、路径写错、
 * 被 `--` 截断、把 Chromium 开关当成文件路径……这些如果只在内存里判断完就丢掉，用户和排查者
 * 都无从下手。这里把**解析出的意图**与**被忽略的参数及原因**落一行日志，问题一眼可见。
 *
 * 打包态也写：用户报「双击 .md 没反应」时，这一行就是第一手证据（路径在 %TEMP%\lumin-build.log）。
 * 只追加一行、不含任何隐私内容（路径除外，那正是要排查的东西）。
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
    const line = {
      launchedAt: new Date().toISOString(),
      packaged: app.isPackaged,
      version: app.getVersion(),
      cwd: record.cwd,
      appPath: record.appPath,
      argv: record.argv,
      intent: record.intent,
      ignored: record.ignored
    }
    appendFileSync(join(tmpdir(), 'lumin-build.log'), JSON.stringify(line) + '\n')
  } catch {
    /* 自检失败不影响启动 */
  }
}
