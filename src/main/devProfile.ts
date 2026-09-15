import { app } from 'electron'
import { join } from 'path'

/**
 * ─── 开发态「可选隔离 profile」（LUMIN_DEV_PROFILE=1）─────────────────────────
 *
 * ### 为什么需要
 * `app.setName('Lumin')` 决定了 userData 是 `%APPDATA%\Lumin`，而打包版用的是同一个名字 ——
 * 于是**开发态与打包版共用同一份设置/会话/草稿，以及同一个单实例锁**。实测现象（见
 * docs/packaging-install-test.md 的 P5）：dev 实例在跑时双击 `.md`，请求会被转发给 dev 实例，
 * 根本测不到打包版自己的行为；反过来打包版也会读写 dev 的设置。
 *
 * ### 为什么是「开关」而不是直接改默认目录
 * 直接把开发态默认目录改掉，等于让用户（也就是我们自己）既有的开发数据「凭空消失」——
 * 那是比问题本身更糟的体验。所以默认行为**完全不变**，只有显式打开开关时才隔离。
 *
 * ### 用法
 * PowerShell：`$env:LUMIN_DEV_PROFILE=1; npm run dev`；Windows 上也可直接用便捷脚本
 * `npm run dev:isolated`（内部就是 `set LUMIN_DEV_PROFILE=1&& electron-vite dev --watch`）。
 *
 * ### 为什么放在这个模块里、并在 main/index.ts 的**第一行** import
 * `app.setPath('userData', …)` 必须早于任何读取 userData 的模块（例如 services/database 打开
 * SQLite 时就用它定位文件）。ESM 的 import 会被提升，所以「在 index.ts 里写一行 setPath」是
 * 来不及的 —— 必须让它成为**最先被求值**的模块（与 suppressWarnings 同样的手法）。
 */
export const devProfileDir: string | null = (() => {
  if (app.isPackaged) return null
  if (process.env['LUMIN_DEV_PROFILE'] !== '1') return null
  const dir = join(app.getPath('appData'), 'Lumin (dev)')
  app.setPath('userData', dir)
  return dir
})()
