import { app } from 'electron'
import fs from 'fs'

/**
 * ─── 单实例锁：第二个实例**立刻干净退出** ─────────────────────────────────────
 *
 * ### 为什么不能照抄文档里的 `if (!lock) app.quit()`
 * Electron 文档给的写法是：
 *     if (!app.requestSingleInstanceLock()) app.quit()
 * 但 `app.quit()` 在 `ready` **之前**只是「标记要退出」：ready 一到，`app.whenReady()` 的
 * 回调照常执行（实测，见 tools/_verify-single-instance.js 的 B 项）。于是被锁挡下的第二个实例
 * 会完整跑一遍启动流程 —— 开 SQLite、写设置、建窗口、装菜单、拉 GPU 进程；而它与首个实例
 * 共用同一个 userData，两边的 Chromium 磁盘缓存互相争抢，控制台就刷出：
 *     ERROR:net\disk_cache\cache_util_win.cc:25  Unable to move the cache: 拒绝访问。(0x5)
 *     ERROR:net\disk_cache\disk_cache.cc:236     Unable to create cache
 *     ERROR:gpu\ipc\host\gpu_disk_cache.cc:724   Gpu Cache Creation failed: -2
 * 用户看到的现象是「`npm run dev` 报了一堆错、窗口没出来就又退出了」（electron-vite 的
 * dev 命令跟着这个进程一起结束）。
 *
 * ### 正确做法：`app.exit(0)` + 排在最前面求值
 * ① 抢不到锁就 `app.exit(0)`（**不是** `app.quit()`）：实测 `app.exit()` 不返回，后面的语句
 *    与 `whenReady` 回调都不会执行，退出码 0，且**不会**出现上面那三条缓存报错。
 * ② 光退出还不够，本模块必须在**所有会读 userData 的模块之前**求值：`services/database` 的
 *    `db` 是模块级 `new LuminDatabase()`，它一旦被求值就已经把 SQLite 打开并跑了迁移。
 *    机制与 devProfile.ts 完全一样（那一个也是靠 import 顺序保证 userData 先被改掉），
 *    所以它在 main/index.ts 里排在 `./menu` / `./ipc`（→ services/database）之前。
 *
 * ### 启动参数不会丢
 * `requestSingleInstanceLock()` 在返回 false 之前，已经**同步**把命令行交给了已运行的实例
 * （那边触发 `second-instance` → services/launchIntent 解析 → 打开文件 / 打开目录 / 新窗口），
 * 所以这里紧接着退出不会截断这次请求。这条性质由套件的 C 项守着。
 *
 * 退出码 0 而不是 1：这不是错误，是一次正常的「请求转交」。
 */

// userData（以及按它认定的锁）由 app name 推导：名字必须在这里就定下来 —— 本模块是唯一能保证
// 「先定名 → 再抢锁 → 后开库」的位置（index.ts 里那一行要等 import 全部求值完才执行）。
app.setName('Lumin')

/** 本次是否是「首个实例」。第二个实例在下面的分支里就退出了，走不到导出之后 */
export const primaryInstance: boolean = app.requestSingleInstanceLock()

if (!primaryInstance) {
  const message = [
    '[Lumin] 已有实例在运行（单实例锁被它持有），本次启动已退出。',
    '        命令行参数已交给那个实例（双击 .md、跳转列表都会由它处理）。',
    '        开发时想再起一个互不干扰的实例：npm run dev:isolated（独立 userData，不抢锁）'
  ].join('\n')
  // 同步写 fd 2：重定向/管道下 console 是异步的，紧接着的 app.exit 会把提示吞掉。
  // fd 2 不可写（打包态双击启动、没有控制台）时静默跳过 —— 发不出提示也不该影响退出本身。
  try {
    fs.writeSync(2, message + '\n')
  } catch {
    /* 没有可写的 stderr */
  }
  app.exit(0)
}
