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
