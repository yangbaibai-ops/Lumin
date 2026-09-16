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
 * ### 提示怎么写才在用户终端里看得懂
 * **只用 ASCII**。Windows 控制台按代码页解读字节（中文系统的 cmd 是 936/GBK），而 `fs.writeSync`
 * 写 UTF-8：中文会乱码，行尾的非法字节还会把换行一起吃掉。而「先认出控制台、再交给 Node 转码」
 * 这条路在 Electron 主进程里走不通（Electron 自己把 `isTTY` 的 spec 标成不可靠并压掉了；
 * 本机实测控制台/管道两种落点都拿不到可信信号）—— 详见下面 message 处的注释。
 *
 * 退出码 0 而不是 1：这不是错误，是一次正常的「请求转交」。
 */

// userData（以及按它认定的锁）由 app name 推导：名字必须在这里就定下来 —— 本模块是唯一能保证
// 「先定名 → 再抢锁 → 后开库」的位置（index.ts 里那一行要等 import 全部求值完才执行）。
app.setName('Lumin')

/** 本次是否是「首个实例」。第二个实例在下面的分支里就退出了，走不到导出之后 */
export const primaryInstance: boolean = app.requestSingleInstanceLock()

if (!primaryInstance) {
  /**
   * 提示**故意只用 ASCII**（英文）。这是唯一可靠的选择，理由全是实测出来的：
   *
   *  - Windows 控制台按**代码页**解读我们写出去的字节（本机是 936/GBK），而 `fs.writeSync`
   *    写的是 UTF-8 → 中文必然乱码；更糟的是行尾那个非法字节会把**换行一起吃掉**，四行并成一行
   *    （实测：「已有实例在运行」显示成「宸叉湁瀹炰緥鍦ㄨ繍琛?」）。
   *  - 想让 Node 按控制台编码转码（WriteConsoleW）就得先认出「这是控制台」，而 Electron 主进程
   *    在 Windows 上判断不了：Electron 自己把 `isTTY` 的 spec 标成「on some machines 不可靠」
   *    压掉了（electron/electron@62b1034）；本机实测在真实控制台下 `process.stderr.isTTY` 仍是
   *    `undefined`、`new tty.WriteStream(2)` 直接 init 失败，而管道下 `IsOutputRedirected` 为真 ——
   *    两条路都拿不到可信信号。
   *  - 探测不可靠 ⇒ 输出就可能乱码，所以这里选「一定能看懂」而不是「可能更好看」：
   *    ASCII 在任意代码页、管道、日志文件里都是对的。
   *
   * 顺带立个规矩：**主进程的 console 输出一律 ASCII**（中文说明留在界面与文档里）——
   * 否则任何一行排查日志都可能在用户终端里变成乱码。
   *
   * 中文说明见 README「快速开始」与手册 §4.67。
   * 用 `fs.writeSync` 同步写：重定向/管道下 `console` 在 Windows 上是异步的，紧接着的
   * `app.exit(0)` 有把提示吞掉的风险。fd 2 不可写（打包态双击启动）时静默跳过。
   */
  const message = [
    '[Lumin] another instance is already running: this launch exited.',
    '        (argv was handed over; your existing window is untouched)',
    '        second dev instance -> npm run dev:isolated',
    '        restart this one    -> close the running Lumin first, then npm run dev'
  ].join('\n')
  try {
    fs.writeSync(2, message + '\n')
  } catch {
    /* 没有可写的 stderr */
  }
  app.exit(0)
}
