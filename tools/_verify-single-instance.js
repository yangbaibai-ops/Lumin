// 验收：单实例锁 —— 第二个实例必须**立刻干净退出**（不跑启动流程、不抢 GPU 磁盘缓存）
//
// ─── 这条套件守的是什么 ────────────────────────────────────────────────────────
// 现场（用户报告）：dev 实例还在跑时再执行一次 `npm run dev`，控制台刷出
//     ERROR:net\disk_cache\cache_util_win.cc:25  Unable to move the cache: 拒绝访问。(0x5)
//     ERROR:net\disk_cache\disk_cache.cc:236     Unable to create cache
//     ERROR:gpu\ipc\host\gpu_disk_cache.cc:724   Gpu Cache Creation failed: -2
// 然后整个 `npm run dev` 就退出了、窗口也没出来。
//
// 根因（两段，都有实测）：① `app.quit()` 在 ready **之前**只是标记退出，ready 一到
// `app.whenReady()` 的回调照跑 —— 第二个实例于是完整启动一遍（开库、建窗、装菜单、拉 GPU
// 进程），与首个实例共用 userData，两边的 Chromium 磁盘缓存互相争抢 → 上面三条报错；
// ② 该进程退出后 electron-vite dev 跟着结束。修法见 src/main/singleInstance.ts。
//
// 断言就是「修复前实测为假、修复后为真」的那些现象，另外补两条回归保护：
//   * 命令行参数仍要转交给首个实例（别把双击 .md 的链路一起修坏）；
//   * 构建产物里守卫的求值顺序要在服务层开库（`new LuminDatabase`）之前。
//
// 前置：先 `npm run build`（跑的是 out/ 里的构建产物）。
// 跑法：`node tools/_verify-single-instance.js`（自起自灭两个实例，独立 userData + 独立调试端口）
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Reporter, attach, inject, appPages, sleep } = require('./lib/harness')

const REPO = path.join(__dirname, '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 本套件自己的调试端口：矩阵里别的套件用 9222，这里换成 9231，
 * 这样无论它排在矩阵哪个位置，都不会连到（或撞上）运行器给别的套件起的实例。
 */
const PORT = 9231
/** 长路径：argv 交给应用后会被原样记录下来，短路径（YANGBA~1）比对会误判 */
const LONG_TMP = (() => {
  try {
    return fs.realpathSync.native(os.tmpdir())
  } catch {
    return os.tmpdir()
  }
})()
const UD = path.join(LONG_TMP, 'lumin-si-userdata')
const WS = path.join(LONG_TMP, 'lumin-si-ws')
const TARGET = path.join(WS, 'si-target.md')
/** 第二个实例最多允许跑多久（正常 ~250ms；只要它跑完启动流程就会远大于这个数） */
const EXIT_TIMEOUT_MS = 60000

const samePath = (a, b) =>
  !!a && path.resolve(String(a)).toLowerCase() === path.resolve(b).toLowerCase()

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 已经退了 */
  }
}

function rmrf(p) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch {
      execFileSync('cmd', ['/c', 'ping -n 2 127.0.0.1 >NUL'], { stdio: 'ignore' })
    }
  }
}

/** 起一个实例；appArgs 追加在 `--user-data-dir` 之后 */
function launch(appArgs, { debugPort } = {}) {
  const env = { ...process.env }
  // 隔离：不继承 dev server / dev profile，否则页面地址与 userData 都不是我们要的那份
  delete env.ELECTRON_RENDERER_URL
  delete env.LUMIN_DEV_PROFILE
  delete env.LUMIN_DEBUG_PORT
  if (debugPort) env.LUMIN_DEBUG_PORT = String(debugPort)
  const argv = [REPO, `--user-data-dir=${UD}`, ...appArgs]
  return debugPort
    ? spawn(ELECTRON, argv, { env, stdio: 'ignore' })
    : spawn(ELECTRON, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 等页面出现（首个实例的健康信号） */
async function waitPages(count, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const pages = await appPages(PORT)
    if (pages.length >= count) return pages
    if (Date.now() > end) return pages
    await sleep(400)
  }
}

/** 等第二个实例**自己**退出；返回 { closed, timedOut, output, ms } */
function waitClose(child, timeoutMs) {
  return new Promise((resolve) => {
    let output = ''
    child.stdout?.on('data', (c) => (output += c))
    child.stderr?.on('data', (c) => (output += c))
    const t0 = Date.now()
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ closed: false, timedOut: true, output, ms: Date.now() - t0 })
    }, timeoutMs)
    // 'close' 而不是 'exit'：前者在 stdio 冲刷完之后才到，输出不会被截断
    child.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ closed: true, timedOut: false, output, ms: Date.now() - t0 })
    })
  })
}

/** 找到「第二个实例转交过来的那篇文档」所在的新窗口，读它当前打开的路径 */
async function waitOpenedDoc(beforeIds, timeoutMs) {
  const end = Date.now() + timeoutMs
  let last = null
  while (Date.now() < end) {
    for (const page of await appPages(PORT)) {
      if (beforeIds.includes(page.id)) continue
      let conn = null
      try {
        conn = await attach(page)
        await conn.send('Page.enable')
        for (let i = 0; i < 20; i++) {
          if (await inject(conn.ev)) break
          await sleep(300)
        }
        const cur = await conn
          .ev('window.__L ? (window.__L.files().current?.path ?? null) : null')
          .catch(() => null)
        if (cur) {
          last = String(cur)
          if (samePath(cur, TARGET)) return { ok: true, path: last }
        }
      } catch (e) {
        last = 'ERR ' + e.message
      } finally {
        if (conn) conn.close()
      }
    }
    await sleep(500)
  }
  return { ok: false, path: last }
}

/**
 * 构建产物里的求值顺序：单实例守卫必须在服务层「模块级开库」之前。
 * 顺序错了的后果是「第二个实例虽然退出了，但已经打开过首个实例的 SQLite 并跑了迁移」。
 */
function bundleOrder() {
  const file = path.join(REPO, 'out', 'main', 'index.js')
  if (!fs.existsSync(file)) return { skipped: '没有 out/main/index.js（先 npm run build）' }
  const text = fs.readFileSync(file, 'utf-8')
  const guard = text.indexOf('已有实例在运行')
  const open = text.indexOf('new LuminDatabase')
  if (guard < 0 || open < 0) return { skipped: '标记串没找到（打包方式变了？）' }
  return { ok: guard < open, guard, open }
}

/**
 * 根因对照：Electron 的 `app.quit()` 在 ready 之前只是标记退出 —— ready 一到，
 * `app.whenReady()` 的回调照跑。这正是「必须用 app.exit(0)」的理由，写下来免得日后被
 * 「简化」回文档里的写法。
 */
async function quitBeforeReadyProbe(r) {
  const script = path.join(LONG_TMP, 'lumin-si-probe.js')
  fs.writeFileSync(
    script,
    [
      "const { app } = require('electron')",
      'app.whenReady().then(() => {',
      "  process.stderr.write('[probe] whenReady-ran\\n')",
      '  app.exit(0)',
      '})',
      'app.quit()'
    ].join('\n')
  )
  const child = spawn(ELECTRON, [`--user-data-dir=${path.join(LONG_TMP, 'lumin-si-probe-ud')}`, script], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const res = await waitClose(child, 30000)
  rmrf(path.join(LONG_TMP, 'lumin-si-probe-ud'))
  try {
    fs.unlinkSync(script)
  } catch {
    /* 忽略 */
  }
  r.check(
    '根因对照：app.quit() 早于 ready 时 whenReady 回调照跑（所以要用 app.exit）',
    /whenReady-ran/.test(res.output),
    res.output.trim().split('\n').pop() || '(无输出)'
  )
}

;(async () => {
  const r = new Reporter('单实例锁：第二个实例立刻干净退出（不跑启动流程 / 不抢 GPU 缓存）')
  let primary = null
  let ready = null
  try {
    // 端口自检：9231 上有别人的实例就不碰它（本仓库「绝不 kill 别人的实例」的约定）
    const busy = await appPages(PORT)
    if (busy.length) {
      r.skip('9231 空闲', `已有 ${busy.length} 个页面在跑，不碰它`)
      return process.exit(r.finish())
    }

    rmrf(UD)
    rmrf(WS)
    fs.mkdirSync(WS, { recursive: true })
    fs.writeFileSync(TARGET, '# 单实例验收\n\n第二个实例应该把这篇交给首个实例打开\n')

    // ── A. 首个实例 ──
    primary = launch([], { debugPort: PORT })
    const pages = await waitPages(1, 45000)
    r.check('首个实例起来并提供 CDP 页面', pages.length === 1, `pages=${pages.length}`)
    if (pages.length !== 1) {
      r.note('首个实例没起来，后面的断言没有意义')
      return process.exit(r.finish())
    }
    ready = await attach(pages[0])
    await ready.send('Page.enable')
    let injected = false
    for (let i = 0; i < 40; i++) {
      injected = await inject(ready.ev).catch(() => false)
      if (injected) break
      await sleep(300)
    }
    r.check('首个实例渲染层就绪（window.__L 可注入）', injected, '')

    const beforeIds = pages.map((p) => p.id)

    // ── B. 第二个实例：与用户报错时同形（同一个 user-data-dir，参数带一篇文档）──
    const second = launch([TARGET])
    const res = await waitClose(second, EXIT_TIMEOUT_MS)
    if (!res.closed) {
      killTree(second)
      await sleep(1000)
    }
    r.check('第二个实例自己退出了（不是被超时杀掉的）', res.closed, `${res.ms}ms`)
    r.check('退出码 0（是「请求转交」而不是崩溃）', second.exitCode === 0, `exitCode=${second.exitCode}`)
    r.check('提示说清了「已有实例在运行」', /已有实例在运行/.test(res.output), '')
    r.check('提示给了出路（npm run dev:isolated）', /dev:isolated/.test(res.output), '')
    r.check('没有跑启动流程（没有装菜单）', !/\[menu\] rebuilt/.test(res.output), '')
    const cacheErr = res.output.match(
      /Unable to move the cache|Unable to create cache|Gpu Cache Creation failed/
    )
    r.check('没有 GPU 磁盘缓存报错（用户报的那三条）', !cacheErr, cacheErr ? cacheErr[0] : '')
    r.note('第二个实例输出：' + JSON.stringify(res.output.replace(/\s+/g, ' ').trim().slice(0, 200)))

    // ── C. 参数转交仍然生效（别把双击 .md 的链路一起修坏）──
    const opened = await waitOpenedDoc(beforeIds, 25000)
    r.check('参数仍被转交：首个实例把它开成了新窗口', opened.ok, String(opened.path ?? '(没读到)'))
    const alive = await ready.ev('1 + 1').catch(() => null)
    r.check('首个实例仍然健康（CDP 可求值）', alive === 2, `1+1=${alive}`)
    const nowPages = await appPages(PORT)
    r.check('首个实例没有被第二个实例带崩（窗口数 = 2）', nowPages.length === 2, `pages=${nowPages.length}`)

    // ── D. 构建产物里的求值顺序 ──
    const order = bundleOrder()
    if (order.skipped) r.skip('守卫的求值顺序早于服务层开库', order.skipped)
    else r.check('守卫的求值顺序早于服务层开库（new LuminDatabase）', order.ok, `guard@${order.guard} db@${order.open}`)

    // ── E. 根因对照 ──
    await quitBeforeReadyProbe(r)
  } catch (e) {
    r.check('套件执行未抛异常', false, e && e.message ? e.message : String(e))
  } finally {
    if (ready) ready.close()
    killTree(primary)
    await sleep(1200)
    rmrf(UD)
    rmrf(WS)
  }
  process.exit(r.finish())
})()
