// 验收：Windows 任务栏跳转列表（右键图标）与 Typora 一致
//
// 分三层验证（跳转列表本身是 Windows shell 的东西，没法只看 DOM）：
//  A. 注册结果：主进程自检日志里的 setJumpList 返回值必须是 ok，任务数为 1；
//  B. 任务/条目的命令行：开发态必须带「应用目录 + 开关」——不带就会拉起一个**无参数的
//     electron.exe**，也就是用户看到的「Electron 原生窗口」；
//  C. 真拉起来点一次：用同样的 user-data-dir 起第二个进程带 --lumin-new-window /
//     --lumin-open=<file>，断言多出一个**Lumin 窗口**（URL 是我们的渲染页 + luminAPI 在），
//     并且最近文档那条能把指定文件打开；不带参数时不会多开窗口。
//
// 用法：先跑 tools/start-isolated.ps1（它会设置 9222 并把主进程 stdout 落到
// %TEMP%\lumin-instance-out.log），再跑本脚本。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, execFileSync } = require('child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const USER_DATA =
  process.env.LUMIN_ISOLATED_USERDATA || path.join(os.tmpdir(), 'lumin-keymap-userdata')
// 主进程自检日志（Windows 上主进程的 stdout 拿不到 console 输出，所以 taskbar 服务落文件）
const OUT_LOG = path.join(os.tmpdir(), 'lumin-taskbar.log')
const REPO = path.resolve(__dirname, '..')
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

function get(p, port = 9222) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url, timeoutMs = 5000) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    // 目标可能已经被关掉了：WebSocket 连不上时必须超时失败，否则整条用例会一直挂着
    const timer = setTimeout(() => rej(new Error('connect timeout')), timeoutMs)
    ws.onopen = () => {
      clearTimeout(timer)
      res()
    }
    ws.onerror = (e) => {
      clearTimeout(timer)
      rej(e instanceof Error ? e : new Error('ws error'))
    }
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params, timeoutMs2 = 8000) =>
    new Promise((res) => {
      const i = ++id
      const timer = setTimeout(() => {
        pending.delete(i)
        res({ timedOut: true })
      }, timeoutMs2)
      pending.set(i, (m) => {
        clearTimeout(timer)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.timedOut) throw new Error('evaluate timeout')
    if (r.result?.exceptionDetails)
      throw new Error(
        'EXC ' +
          JSON.stringify(
            r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
          ).slice(0, 240)
      )
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

/**
 * 关掉一个窗口：走浏览器级 Target.closeTarget，而不是页面里的 window.close()。
 * 页面里的 close 会被应用的「未保存确认」守卫拦住，此时渲染目标已开始销毁，
 * Runtime.evaluate 的 promise 永远不返回 —— 用例会挂死（踩过一次）。
 */
async function closeTarget(targetId, port = 9222) {
  try {
    const v = await get('/json/version', port)
    const b = connect(v.webSocketDebuggerUrl, 4000)
    await b.ready
    await b.send('Target.closeTarget', { targetId }, 4000)
    b.ws.close()
  } catch {
    /* 已经关掉了 / 连不上就算了 */
  }
}

const pages = async () => (await get('/json/list')).filter((t) => t.type === 'page')

/** 主进程日志里所有 [taskbar] 行，解析成结构化记录 */
function taskbarLog() {
  const raw = fs.existsSync(OUT_LOG) ? fs.readFileSync(OUT_LOG, 'utf-8') : ''
  return raw
    .split(/\r?\n/)
    .filter((l) => l.includes('[taskbar]'))
    .map((l) => {
      const status = /status=(\w+)/.exec(l)?.[1] ?? null
      const tasks = Number(/tasks=(\d+)/.exec(l)?.[1] ?? NaN)
      const recent = Number(/recent=(\d+)/.exec(l)?.[1] ?? NaN)
      const args = /args="([^"]*)"/.exec(l)?.[1] ?? ''
      const title = /title="([^"]*)"/.exec(l)?.[1] ?? ''
      const aumid = /aumid=(\S+)/.exec(l)?.[1] ?? ''
      const target = /target="([^"]*)"/.exec(l)?.[1] ?? ''
      const path2 = /path="([^"]*)"/.exec(l)?.[1] ?? ''
      const icon = /icon="([^"]*)"/.exec(l)?.[1] ?? ''
      const okMatch = /ok=(true|false)/.exec(l)
      return {
        line: l,
        kind: l.includes('shortcut') ? 'shortcut' : 'jumplist',
        status,
        tasks,
        recent,
        args,
        title,
        aumid,
        target,
        path: path2,
        icon,
        ok: okMatch ? okMatch[1] === 'true' : null
      }
    })
}

/**
 * 读**用户自己那条**开发态快捷方式（`Lumin (dev).lnk`）的图标路径；没有这条快捷方式时返回 null。
 * 注意用 `-LiteralPath`/`[System.IO.File]::Exists` 那套口径：`Lumin (dev) [test].lnk` 里的方括号
 * 在 PowerShell 里是通配符，路径判断必须走字面量（否则会误判成「不存在」）。
 */
function userDevShortcutIcon() {
  const lnk = path.join(
    process.env.APPDATA,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Lumin (dev).lnk'
  )
  if (!fs.existsSync(lnk)) return null
  try {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').IconLocation`
      ],
      { encoding: 'utf-8', windowsHide: true }
    ).trim()
  } catch {
    return null
  }
}

/** 用 shell 打开 .lnk（与「点任务栏菜单第一项」同一条路径：Windows 解析标识对应的快捷方式）。
 *  仅保留给「用户没在跑应用」时的手工验证，验收默认不调用 —— 理由见 A3 的注释。 */
function launchShortcut(lnkPath) {  const env = { ...process.env }
  delete env.LUMIN_DEBUG_PORT
  delete env.ELECTRON_RENDERER_URL
  // 直接 spawn 一个 .lnk 不行（不是可执行文件），必须交给 shell 解析
  spawn('cmd.exe', ['/c', 'start', '', lnkPath], { detached: true, stdio: 'ignore', env }).unref()
}

/** 起第二个进程（同一个 user-data-dir → 命中单实例锁，把参数交给已运行的实例） */
function launchSecond(extraArgs) {
  const env = { ...process.env }
  delete env.LUMIN_DEBUG_PORT
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(ELECTRON_EXE, [REPO, `--user-data-dir=${USER_DATA}`, ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.unref()
}

/** 等页面数变化（增加 amount 个新窗口） */
async function waitForNewPages(before, amount, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const now = await pages()
    const fresh = now.filter((p) => !before.some((b) => b.id === p.id))
    if (fresh.length >= amount) return fresh
    await sleep(300)
  }
  return []
}

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  const initialPages = await pages()
  if (!initialPages.length) {
    console.log('SKIP: 没有可用窗口（先跑 tools/start-isolated.ps1）')
    return process.exit(1)
  }
  const main = connect(initialPages[0].webSocketDebuggerUrl)
  await main.ready
  const SETUP = `(() => {
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'no-app'
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    if (!pinia) return 'no-pinia'
    window.__K = { files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings'), ui: () => pinia._s.get('ui') }
    return 'ok'
  })()`
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (
      (await main.ev(SETUP)) === 'ok' &&
      (await main.ev(`window.__K.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  await main.ev(SETUP)

  // ── A. 启动时的注册结果 ──
  const boot = taskbarLog().filter((l) => l.kind === 'jumplist' && l.tasks === 1)
  const first = boot[0]
  console.log('BOOT-LOG ' + JSON.stringify(first))
  c('jumplist-registered-ok', !!first && first.status === 'ok', JSON.stringify(first))
  c('has-new-window-task', !!first && first.tasks === 1, JSON.stringify(first?.tasks))
  c('task-title-localized', !!first && first.title === '新建窗口', String(first?.title))

  // ── A2. 开始菜单快捷方式：任务栏右键菜单第一项的**名字**与**点击行为**都来自它 ──
  const sc = taskbarLog().find((l) => l.kind === 'shortcut' && l.ok === true)
  const back = taskbarLog().find((l) => l.line.includes('shortcut-readback'))
  console.log('SHORTCUT ' + JSON.stringify(sc ?? null))
  console.log('SHORTCUT-READBACK ' + JSON.stringify(back ?? null))
  const expectAppPath0 = path.resolve(__dirname, '..')
  c('shortcut-written', !!sc && sc.ok === true && !!sc.path, JSON.stringify(sc ?? null))
  c(
    'shortcut-aumid-is-ours-not-electron',
    !!sc && /^com\.lumin\.app\.dev(\.test)?$/.test(sc.aumid) && !/electron\.exe/i.test(sc.aumid),
    String(sc?.aumid)
  )
  // 隔离实例必须用**独立标识**：任务栏按钮的图标/名字按「AUMID → 开始菜单快捷方式」解析，
  // 同 AUMID 的另一条快捷方式会把用户的应用顶到测试实例那条上 —— 而测试实例的配置目录跑完
  // 就被删，图标文件随之消失，用户的任务栏图标只剩缺省（实测踩过，见手册 §4.46）。
  c(
    'isolated-aumid-is-not-user-aumid',
    !!sc && sc.aumid === 'com.lumin.app.dev.test',
    String(sc?.aumid)
  )
  c(
    'isolated-shortcut-path-is-test-only',
    !!sc && /\[test\]\.lnk$/i.test(sc.path) && !/Lumin \(dev\)\.lnk$/i.test(sc.path),
    String(sc?.path)
  )
  // 它写的图标必须落在**稳定**目录（不能是那个跑完就删的配置目录），否则 [test] 快捷方式
  // 会留下一条「找不到图标」的引用。
  c(
    'isolated-shortcut-icon-outside-profile',
    !!sc?.icon && !sc.icon.toLowerCase().includes(String(USER_DATA).toLowerCase()),
    JSON.stringify({ icon: sc?.icon, userData: USER_DATA })
  )
  c(
    'shortcut-targets-electron-with-app-path',
    !!sc && /electron\.exe$/i.test(sc.target) && sc.args.includes(expectAppPath0),
    JSON.stringify({ target: sc?.target, args: sc?.args })
  )
  c(
    'shortcut-readback-matches',
    !!back && back.aumid === sc?.aumid && back.args === sc?.args && back.target === sc?.target,
    JSON.stringify(back ?? null)
  )
  c('shortcut-file-on-disk', !!sc?.path && fs.existsSync(sc.path), String(sc?.path))
  // 图标：任务栏/开始菜单只认 exe/dll/ico 资源，必须是应用自己的图标（之前借的是 electron.exe 的图标）。
  // 开发态写的是**内容寻址的运行时副本**（userData/icons/lumin-<hash>.ico，见 §4.35：Windows 按路径
  // 缓存图标，所以每次内容变化都要换路径），所以这里断言「后缀 .ico + 文件真实存在 + 字节与
  // resources/icon.ico 完全一致」——比只看文件名更强：既排除了 electron.exe 的图标，也排除了旧设计。
  const canonicalIcon = path.resolve(__dirname, '..', 'resources', 'icon.ico')
  const iconBytesEqual =
    !!sc?.icon && fs.existsSync(sc.icon) && fs.existsSync(canonicalIcon)
      ? fs.readFileSync(sc.icon).equals(fs.readFileSync(canonicalIcon))
      : false
  c(
    'shortcut-icon-is-app-icon',
    !!sc && /\.ico$/i.test(sc.icon) && iconBytesEqual,
    JSON.stringify({ icon: sc?.icon, canonical: canonicalIcon, bytesEqual: iconBytesEqual })
  )
  c('shortcut-readback-icon-matches', !!back && back.icon === sc?.icon, JSON.stringify({ readback: back?.icon, written: sc?.icon }))

  // ── A2b. 用户自己那条开发态快捷方式必须**还指向存在的图标文件** ──
  // 这正是本轮修的 bug 的断言：隔离实例曾经和用户共用同一个 AUMID，跑完验收（配置目录被删）
  // 之后，任务栏按 AUMID 解析到测试实例那条快捷方式 → 图标文件没了 → 用户图标变缺省。
  // .lnk 的属性存储 Node 读不了，用 WScript.Shell（与 Windows 同一套解析）读图标路径即可。
  const userIcon = userDevShortcutIcon()
  const userIconPath = (userIcon ?? '').split(',')[0]
  console.log('USER-SHORTCUT-ICON ' + JSON.stringify({ icon: userIcon }))
  c(
    'user-shortcut-icon-still-valid',
    userIcon === null || (!!userIconPath && fs.existsSync(userIconPath)),
    JSON.stringify({ icon: userIcon })
  )

  // ── A3. 快捷方式的启动命令 == 已经验证过能开新窗口的那条命令 ──
  // 注意：**不要**在验收里真的用 shell 打开这条 .lnk —— 它是应用自己的快捷方式，不带
  // --user-data-dir，于是会连到「默认配置目录」那个实例上（也就是用户正在用的那个应用），
  // 等于拿验收去动用户的窗口（踩过一次）。所以这里只断言「快捷方式的 target+args 恰好
  // 等于下面那条已通过验证的启动命令」，再由 C1 用隔离实例真的跑一遍。
  const provenLaunch = `${path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')}|${expectAppPath0} --lumin-new-window`
  const shortcutLaunch = `${sc?.target ?? ''}|${sc?.args ?? ''}`
  console.log('SHORTCUT-LAUNCH ' + JSON.stringify({ shortcutLaunch, provenLaunch }))
  c(
    'shortcut-launch-equals-proven-command',
    shortcutLaunch === provenLaunch,
    JSON.stringify({ shortcutLaunch, provenLaunch })
  )

  // ── B. 任务命令行必须能拉起「我们的应用」 ──
  // 开发态（未打包）：第一个 token 就是应用目录，否则 electron.exe 会开成 Electron 自带的示例窗口
  const args = first?.args ?? ''
  const expectAppPath = path.resolve(__dirname, '..')
  const tokens = args.split(/\s+/).filter(Boolean)
  console.log('TASK-ARGS ' + JSON.stringify({ args, tokens, expectAppPath, packaged: false }))
  c(
    'task-args-include-app-path',
    tokens[0] === expectAppPath,
    JSON.stringify({ tokens, expectAppPath })
  )
  c('task-args-include-switch', tokens.includes('--lumin-new-window'), args)
  // 带空格的路径必须加引号，否则 CreateProcess 会把一个路径拆成两个参数（当前仓库路径没空格，
  // 因此这里只断言「含空格的 token 一定被引起来」这条规则不成立时不会静默通过）
  c(
    'task-args-quote-spaced-paths',
    !expectAppPath.includes(' ') || args.startsWith('"'),
    JSON.stringify({ expectAppPath, args })
  )

  // ── C1. 点「Lumin」→ 多出一个 Lumin 窗口（不是 Electron 原生窗口） ──
  const beforeNew = await pages()
  launchSecond(['--lumin-new-window'])
  const freshNew = await waitForNewPages(beforeNew, 1)
  c(
    'new-window-task-opens-a-window',
    freshNew.length >= 1,
    `before=${beforeNew.length} after=${beforeNew.length + freshNew.length}`
  )
  if (freshNew.length) {
    const w = connect(freshNew[0].webSocketDebuggerUrl)
    await w.ready
    let info = null
    for (let i = 0; i < 40; i++) {
      await sleep(300)
      try {
        info = JSON.parse(
          await w.ev(
            `JSON.stringify({ href: location.href, hash: location.hash, title: document.title, api: typeof window.luminAPI, app: !!document.querySelector('#app').__vue_app__ })`
          )
        )
        if (info.app) break
      } catch {
        /* 目标还在导航 */
      }
    }
    console.log('NEW-WINDOW ' + JSON.stringify(info))
    c(
      'new-window-is-lumin-not-electron',
      !!info && info.app === true && info.api === 'object' && /5173|index\.html/.test(info.href),
      JSON.stringify(info)
    )
    c('new-window-title-is-lumin', !!info && info.title.startsWith('Lumin'), info?.title)
    // 收掉这个窗口，避免影响后续套件（走 Target.closeTarget，见 closeTarget 的注释）
    w.ws.close()
    await closeTarget(freshNew[0].id)
    for (let i = 0; i < 20; i++) {
      await sleep(300)
      if ((await pages()).length === beforeNew.length) break
    }
  } else {
    c('new-window-is-lumin-not-electron', false, 'SKIP: 没有新窗口')
    c('new-window-title-is-lumin', false, 'SKIP')
  }
  c(
    'extra-window-closed',
    (await pages()).length === beforeNew.length,
    `pages=${(await pages()).length}`
  )

  // ── C2. 最近文档：先把一篇文档写进「最近打开」，重建后日志里应出现它 ──
  const wsDir = path.join(os.tmpdir(), 'lumin-jump-ws')
  fs.rmSync(wsDir, { recursive: true, force: true })
  fs.mkdirSync(wsDir, { recursive: true })
  const fileA = path.join(wsDir, 'alpha.md')
  const fileB = path.join(wsDir, 'beta.md')
  fs.writeFileSync(fileA, '# alpha\n\nfirst\n', 'utf-8')
  fs.writeFileSync(fileB, '# beta\n\nsecond\n', 'utf-8')

  const linesBefore = taskbarLog().length
  await main.ev(
    `(() => { window.__K.settings().set('recentFiles', [{ path: ${JSON.stringify(fileA)}, title: 'alpha.md', openedAt: Date.now() }]); return 'ok' })()`
  )
  await sleep(2600) // 等 settings:update 落库 + 主进程重建（见 services/taskbar 的节流）
  const after = taskbarLog()
  console.log('RECENT-LOG ' + JSON.stringify(after.slice(linesBefore)))
  const withRecent = after.filter((l) => l.recent >= 1).pop()
  c('recent-category-built', !!withRecent, JSON.stringify(withRecent ?? null))
  c(
    'recent-entry-points-at-our-app',
    !!withRecent &&
      withRecent.args.includes(expectAppPath) &&
      withRecent.args.includes('--lumin-new-window'),
    withRecent?.args
  )
  // 最近条目的 args 是在主进程里拼的（日志只打「新窗口」那条），这里直接验证最终行为：

  // ── C3. 点「最近打开」里的 beta.md → 新窗口打开它 ──
  const beforeOpen = await pages()
  launchSecond([`--lumin-open=${encodeURIComponent(fileB)}`])
  const freshOpen = await waitForNewPages(beforeOpen, 1)
  c(
    'recent-entry-opens-a-window',
    freshOpen.length >= 1,
    `before=${beforeOpen.length} after=${beforeOpen.length + freshOpen.length}`
  )
  if (freshOpen.length) {
    const w = connect(freshOpen[0].webSocketDebuggerUrl)
    await w.ready
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (
        (await w.ev(SETUP)) === 'ok' &&
        (await w.ev(`window.__K.ui().booting ? 'booting' : 'ready'`)) === 'ready'
      )
        break
    }
    await w.ev(SETUP)
    let cur = null
    for (let i = 0; i < 40; i++) {
      await sleep(300)
      cur = await w.ev(`(window.__K.files().current && window.__K.files().current.path) || null`)
      if (cur) break
    }
    console.log('OPENED-FILE ' + JSON.stringify({ cur, want: fileB }))
    c(
      'recent-entry-opens-that-file',
      !!cur && path.resolve(cur).toLowerCase() === path.resolve(fileB).toLowerCase(),
      JSON.stringify({ cur, want: fileB })
    )
    w.ws.close()
    await closeTarget(freshOpen[0].id)
    for (let i = 0; i < 20; i++) {
      await sleep(300)
      if ((await pages()).length === beforeOpen.length) break
    }
  } else {
    c('recent-entry-opens-that-file', false, 'SKIP: 没有新窗口')
  }

  // ── C4. 一个已开着的文档：再点一次应该聚焦原窗口，而不是开第二个（沿用「一个文件只开一个窗口」）──
  // 上面刚关掉，所以先重新打开一次拿到窗口数，再点同一篇
  const beforeDedup = await pages()
  launchSecond([`--lumin-open=${encodeURIComponent(fileB)}`])
  const firstOpen = await waitForNewPages(beforeDedup, 1)
  if (firstOpen.length) {
    const base = await pages()
    launchSecond([`--lumin-open=${encodeURIComponent(fileB)}`])
    await sleep(3000)
    const now = await pages()
    console.log('DEDUP ' + JSON.stringify({ base: base.length, now: now.length }))
    c(
      'same-file-does-not-open-twice',
      now.length === base.length,
      `base=${base.length} now=${now.length}`
    )
  } else {
    c('same-file-does-not-open-twice', false, 'SKIP: 没能先打开一个窗口')
  }

  // ── C5. 不带参数再点一次图标（聚焦已有窗口）：不该多开窗口 ──
  const beforePlain = await pages()
  launchSecond([])
  await sleep(3000)
  const plainNow = await pages()
  console.log(
    'PLAIN-LAUNCH ' + JSON.stringify({ before: beforePlain.length, after: plainNow.length })
  )
  c(
    'plain-relaunch-does-not-open-window',
    plainNow.length === beforePlain.length,
    `before=${beforePlain.length} after=${plainNow.length}`
  )

  // ── D. 冷启动（应用没在跑）时点「最近打开」：新进程带 --lumin-open 应直接开那篇文档 ──
  // 这条走的是另一段代码（whenReady 里「有 openFile 就不拉会话恢复」），必须单独验。
  const coldUd = path.join(os.tmpdir(), 'lumin-jump-cold')
  const coldPort = 9223
  fs.rmSync(coldUd, { recursive: true, force: true })
  // 渲染页面来源**继承父进程**，不硬编码 dev server 地址：
  // 本套件其余每个实例（主实例、launchSecond）都是继承的，只有这里写死 http://localhost:5173 会
  // 导致「没有 dev server 时冷启动进程拿不到页面 → #app 不存在 → 下面读 window.__K 直接 TypeError」。
  // 父进程有 ELECTRON_RENDERER_URL 就用它（dev server 模式），没有就删掉 → 与主实例一样走 out/renderer。
  const coldEnv = {
    ...process.env,
    LUMIN_DEBUG_PORT: String(coldPort)
  }
  if (!process.env.ELECTRON_RENDERER_URL) delete coldEnv.ELECTRON_RENDERER_URL
  spawn(
    ELECTRON_EXE,
    [REPO, `--user-data-dir=${coldUd}`, `--lumin-open=${encodeURIComponent(fileA)}`],
    {
      detached: true,
      stdio: 'ignore',
      env: coldEnv
    }
  ).unref()
  let coldPages = []
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      coldPages = (await get('/json/list', coldPort)).filter((t) => t.type === 'page')
      if (coldPages.length) break
    } catch {
      /* 还没起来 */
    }
  }
  c('cold-start-opens-one-window', coldPages.length === 1, `pages=${coldPages.length}`)
  if (coldPages.length) {
    const w = connect(coldPages[0].webSocketDebuggerUrl)
    await w.ready
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (
        (await w.ev(SETUP)) === 'ok' &&
        (await w.ev(`window.__K.ui().booting ? 'booting' : 'ready'`)) === 'ready'
      )
        break
    }
    await w.ev(SETUP)
    let cur = null
    // SETUP 注入失败（页面没起来 / 冷启动进程拿不到渲染页面）时给一条能看懂的结论，别抛 undefined.files
    if ((await w.ev(`typeof window.__K === 'object' ? 'ok' : 'missing'`)) !== 'ok') {
      const href = await w.ev('location.href')
      c('cold-start-opens-that-file', false, `SETUP 失败：页面没起来 href=${href}`)
      c('cold-start-no-extra-restore-windows', false, 'SETUP 失败')
      w.ws.close()
      for (const p of coldPages) await closeTarget(p.id, coldPort)
      console.log(results.join('\n'))
      const nf = results.filter((r) => r.startsWith('FAIL')).length
      console.log(`--- ${results.length - nf}/${results.length} PASS`)
      main.ws.close()
      return process.exit(1)
    }
    for (let i = 0; i < 40; i++) {
      await sleep(300)
      cur = await w.ev(`(window.__K.files().current && window.__K.files().current.path) || null`)
      if (cur) break
    }
    console.log('COLD-OPENED ' + JSON.stringify({ cur, want: fileA }))
    c(
      'cold-start-opens-that-file',
      !!cur && path.resolve(cur).toLowerCase() === path.resolve(fileA).toLowerCase(),
      JSON.stringify({ cur, want: fileA })
    )
    c('cold-start-no-extra-restore-windows', coldPages.length === 1, `pages=${coldPages.length}`)
    w.ws.close()
  } else {
    c('cold-start-opens-that-file', false, 'SKIP: 冷启动实例没起来')
    c('cold-start-no-extra-restore-windows', false, 'SKIP')
  }
  for (const p of coldPages) await closeTarget(p.id, coldPort)

  // 收尾：把测试开出来的窗口都关掉，别影响后续套件
  for (const p of await pages()) {
    if (initialPages.some((i) => i.id === p.id)) continue
    await closeTarget(p.id)
  }
  await sleep(1200)
  console.log('FINAL-PAGES ' + (await pages()).length)

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  main.ws.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
