'use strict'
// ─── CDP 套件公共骨架 ─────────────────────────────────────────────────────────
//
// 为什么要有这个文件：tools/ 下 50+ 个 `_verify-*.js` 各自抄了一遍「连 CDP → 找页面
// → attach → 注入 pinia 访问器 → 敲键盘」这几十行，抄出来的副本还会各自漂移：
//   * 页面识别写死 `5173` → dev server 没跑就整轮跑不了（构建产物 out/ 明明也能跑）；
//   * 取 pinia 写死 `String(s) === 'Symbol(pinia)'` → 生产构建里 symbol 描述被压掉，
//     只有 dev server 的页面能用（同一个套件行为随构建方式变化，最坑）；
//   * 结果汇总格式各不相同，没法机器聚合。
// 新套件一律 `require('./lib/harness')`；老套件按「改到谁就顺手迁谁」的节奏收口。
//
// 用法：
//   const { connect, Reporter, settle, key, clickSelector, sleep } = require('./lib/harness')
//   const app = await connect()            // 找不到 app 页面会抛出，附带排查提示
//   await settle(app.ev)                   // 等启动完成 + 注入 window.__L
//   const md = await app.ev('window.__L.files().current.content')
//   app.close()
//
// 约定：
//   * 只连 `--remote-debugging-port` 暴露的页面，绝不 kill 进程（起实例是调用方的事）；
//   * 页面识别同时认 dev server（5173）与构建产物（out/renderer/index.html）；
//   * 退出码：Reporter.finish() 有 FAIL 返回 1（配合 `process.exit(report.finish())`）。

const DEFAULT_PORT = Number(process.env.LUMIN_DEBUG_PORT || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawnSync, spawn } = require('child_process')

function cdpUrl(port, pathname = '/json') {
  return `http://127.0.0.1:${port}${pathname}`
}

/** 列出调试端口上的所有页面目标（网络异常时抛错，交由调用方决定重试） */
async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(cdpUrl(port))
  return res.json()
}

/** 是不是「本应用的页面」：dev server 或构建产物都算 */
function isAppPage(t) {
  return t.type === 'page' && /index\.html|127\.0\.0\.1:5173|localhost:5173/.test(t.url)
}

/** 应用页面列表（可能 0 个：实例没起或还没加载完） */
async function appPages(port = DEFAULT_PORT) {
  try {
    return (await listTargets(port)).filter(isAppPage)
  } catch {
    return []
  }
}

/** 等一个应用页面出现（默认 30s），返回 page 目标对象 */
async function waitForAppPage({ port = DEFAULT_PORT, timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const pages = await appPages(port)
    if (pages.length) return pages[0]
    if (Date.now() > end) {
      throw new Error(
        `等待应用页面超时（端口 ${port}）。先起隔离实例：\n` +
          `  pwsh tools/start-isolated.ps1 -UserData "$env:TEMP\\lumin-ud"\n` +
          `或用 dev server：ELECTRON_RENDERER_URL=http://localhost:5173 LUMIN_DEBUG_PORT=${port}`
      )
    }
    await sleep(300)
  }
}

/** 连到一个页面目标，返回 { page, send, ev, close, sock } */
async function attach(page) {
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = () => rej(new Error('CDP WebSocket 连接失败：' + page.url))
  })
  let n = 0
  const waiters = new Map()
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m)
      waiters.delete(m.id)
    }
  }
  /**
   * 连接断开时把挂起的求值**立刻**放掉：否则 Node 侧只有 Promise、没有定时器，
   * 事件循环一空就静默退出（退出码 0），看起来像"什么都没跑"。给调用方一个空响应，
   * 让上层按"取不到值"报错。正常流程（连接还在）完全不受影响。
   */
  sock.onclose = () => {
    for (const res of waiters.values()) res({ id: 0, result: {} })
    waiters.clear()
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++n
      waiters.set(i, res)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  /** 在页面里求值（awaitPromise + 返回 JSON 值）；页面抛错时**直接抛出**，别静默变 undefined */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error('页面异常：' + String(d.exception?.description ?? d.text).slice(0, 400))
    }
    return r.result?.result?.value
  }
  return { page, sock, send, ev, close: () => sock.close() }
}

/**
 * 页面侧取 pinia：**按结构找，不按 symbol 名字找**。
 * Vue 的 provides 里那个持有 `_s`（Map，store 名 → store 实例）的对象就是 pinia，
 * 这个形状在 dev 与生产构建下一致，而 `Symbol(pinia)` 的描述在生产构建里会被压掉。
 */
const PINIA = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return null
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  return vals.find((v) => v && typeof v === 'object' && v._s instanceof Map) ?? null
})()`

/** 页面侧注入 window.__L（store 访问器）。reload 会清掉，需要重新注入 */
const INJECT = `(() => {
  const pinia = ${PINIA}
  if (!pinia) return 'NO_PINIA'
  window.__L = {
    pinia,
    store: (name) => pinia._s.get(name),
    files: () => pinia._s.get('files'),
    settings: () => pinia._s.get('settings'),
    ui: () => pinia._s.get('ui'),
    editor: () => pinia._s.get('editor'),
    notifications: () => pinia._s.get('notifications'),
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`

/** 注入访问器；未挂载时返回 false（不抛，方便轮询） */
async function inject(ev) {
  return (await ev(INJECT)) === 'ok'
}

/** 等启动完成（#app 挂载 + ui.booting 结束）并注入访问器 */
async function settle(ev, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    let ready = false
    try {
      ready = await ev(`(() => {
        const pinia = ${PINIA}
        if (!pinia) return false
        const ui = pinia._s.get('ui')
        return !!ui && ui.booting === false
      })()`)
    } catch {
      ready = false
    }
    if (ready === true) {
      await inject(ev)
      return true
    }
    await sleep(200)
  }
  return false
}

/** 等编辑器实例就绪（打开文档后 Tiptap 按 :key 重建，需要等它挂上） */
async function waitEditor(ev, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await ev('!!window.__L?.ed()')
    if (ok) return true
    await sleep(100)
  }
  return false
}

/**
 * 让**快捷工具栏**显示出来，并等它真的挂上（返回是否等到）。
 *
 * 为什么夹具必须显式打开：工具栏**出厂默认收起**（清单 §1.E 选项②，`shared/defaults.ts`），
 * 而运行器给每个套件用的都是全新 userData ⇒ 默认值每次都生效。
 * 要量工具栏里的控件（尤其 `clickMode` 点的模式分段控件）的套件，请在 `waitEditor()` 之后
 * 先 `await showToolbar(app)`，不要依赖 profile 里残留的状态。
 */
async function showToolbar(app, ms = 4000) {
  await app.ev(`(() => { window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await app.ev(`!!document.querySelector('[role="tablist"]')`)) return true
    await sleep(100)
  }
  return false
}

/**
 * 隔离实例的 **stdout 日志文件**（主进程 `console.log` 的落点）。
 *
 * 为什么要有这个约定：主进程在 GUI 子系统里**没有控制台**，`console.log` 平时谁也看不见；
 * `tools/start-isolated.ps1` 用 `Start-Process -RedirectStandardOutput` 把它落到了
 * `%TEMP%\lumin-instance-<userData 目录名>-out.log` —— 于是「主进程到底有没有收到这条 IPC /
 * 打了什么」变成**可读的事实**。文件名口径只有一处：就是那个 ps1（这里按同一规则拼）。
 *
 * 典型用法（`_verify-devtools.js`）：点了工具栏那枚按钮后，读这里的
 * `[devtools] opened window=N already=…` 行 —— `contextBridge` 暴露的 API 对象是**只读**的
 * （页面里 monkey-patch 不了，第一版因此拿到恒空的计数、断言假红），主进程日志才是
 * "渲染层 → IPC → 主进程"真的走通了的证据。
 *
 * 手工起的实例若没走 run-suites，套件仍能按同一规则读到文件；真读不到时返回的路径不存在，
 * 调用方应**如实 SKIP**依赖它的断言（不要判红）。
 */
function instanceLog(userData = process.env.LUMIN_ISOLATED_USERDATA) {
  /**
   * ⚠️ 显式传进来的 `userData` **优先于** `LUMIN_INSTANCE_LOG`：
   * **自管实例**的套件（`_verify-feedback.js` 这种自己要带环境变量起实例的）跑在运行器给的
   * 进程里，而那个变量指向的是**运行器那个实例**的日志 —— 拿它去读自己起的实例当然读不到。
   */
  if (userData) return path.join(os.tmpdir(), `lumin-instance-${path.basename(userData)}-out.log`)
  if (process.env.LUMIN_INSTANCE_LOG) return process.env.LUMIN_INSTANCE_LOG
  return null
}

/**
 * connect：等页面 → attach → 返回句柄（不自动 settle，调用方按需）
 */
async function connect({ port = DEFAULT_PORT, timeoutMs = 30000, bringToFront = true } = {}) {
  const page = await waitForAppPage({ port, timeoutMs })
  const app = await attach(page)
  await app.send('Page.enable')
  if (bringToFront) await app.send('Page.bringToFront').catch(() => {})
  return app
}

/**
 * 订阅 CDP **事件**（`connect()` 返回的句柄只处理带 id 的响应，事件默认被丢掉）。
 *
 * 什么时候需要它：要证明「某个懒加载 chunk 到底有没有被取」这类**页面侧看不到**的事 ——
 * 页面里的 `performance.getEntriesByType('resource')` 在本应用（Electron + 本地文件）里
 * **恒为空数组**（实测 resTotal = 0），拿它做断言只会永远通过，是假绿。
 * 用法：`const off = watchEvents(app, (m) => { if (m.method === 'Network.requestWillBeSent') … })`
 * 实现是**包一层**原有的 onmessage，所以 `send` / `ev` 不受影响；返回取消订阅的函数。
 */
function watchEvents(app, onEvent) {
  const prev = app.sock.onmessage
  app.sock.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data))
    } catch {
      /* 事件解析失败不影响响应处理 */
    }
    if (prev) prev(e)
  }
  return () => {
    app.sock.onmessage = prev
  }
}

/** 把**被测实例的窗口**重新提到前台（`Page.bringToFront`）。
 *
 * 为什么需要单独一个可重复调用的入口：`connect()` 只在挂载时提一次前台，而
 * `ed.isFocused` 依赖 `document.hasFocus()` —— 只要用户**自己的** Lumin 窗口
 * （`%APPDATA%\lumin`，套件约定绝不碰它）此刻在前台，被测实例就拿不到焦点，
 * 真实按键会打到 body 上（套件里表现为 `NO-FOCUS`，且**只影响真实输入类断言**）。
 * 所以「取焦点」的重试循环里每次都重新提一次前台，把这条环境干扰压掉。
 */
async function bringToFront(app) {
  try {
    await app.send('Page.bringToFront')
  } catch {
    /* 目标已关闭/不支持：由调用方的重试逻辑决定后续 */
  }
}

/**
 * 真实按键注入前的**取焦点重试循环**（清单 §10：flaky 表里
 * `_verify-inline-formats` / `_verify-rename` / `_verify-new-document` /
 * `_verify-keymap` / `_repro-rapidenter` 都栽在同一件事上 —— 被测窗口不在 OS 前台时
 * CDP 注入的按键会丢，套件里表现为 `NO-FOCUS` 或"敲了没反应"的假红）。
 *
 * 每次重试都重新 `Page.bringToFront`（只提一次不够：用户自己的 Lumin 窗口随时可能抢回焦点），
 * 再问页面 `document.hasFocus()`。返回 false = 拿不到焦点，调用方应**如实 SKIP**，
 * 不要判红 —— 那是环境不满足，不是被测代码坏了（口径见清单 §1.C.1）。
 *
 * 用法：
 *   if (!(await ensureFocus(app))) { report.skip('真实按键段', '窗口拿不到焦点'); return report.finish() }
 */
async function ensureFocus(app, { tries = 15, gapMs = 200 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    await bringToFront(app)
    try {
      if (await app.ev(`document.hasFocus()`)) return true
    } catch {
      return false
    }
    await sleep(gapMs)
  }
  return false
}

/**
 * `ensureFocus` 的"直接 SKIP"版本：拿不到焦点就抛 `preconditionSkip`（由 `fatal` 结算成 SKIP）。
 *
 * 用法（省掉每个套件各写一遍"返回 false 就 report.skip"）：
 * ```js
 * await requireFocus(app, 'Ctrl+N 段')   // 拿不到就 SKIP 整个套件
 * ```
 * 什么时候该用它、什么时候该用 `report.skip`：**整个套件都靠真实输入**时用这个；
 * 只有一段依赖输入、其余断言仍值得跑时，用 `report.skip` 只跳过那一段
 * （`_verify-outline-nav.js` 就是后者）。
 */
async function requireFocus(app, what = '真实按键段', opts) {
  if (await ensureFocus(app, opts)) return
  throw preconditionSkip(`${what}：拿不到 OS 焦点（CDP 注入的按键会丢）——环境抖动，不是产品缺陷`)
}

/**
 * 这个窗口**在不在产生帧**（`requestAnimationFrame` 会不会被派发）。
 *
 * 为什么要先问这一句：滚动事件与平滑滚动都挂在**帧**上。窗口被别的窗口挡住时 Chromium 会暂停
 * 出帧（实测：用户自己的 Lumin 在前台时，探针里 `scrollTop` 一直 0、滚动事件一个不来）。
 * 从 `_verify-outline-nav.js` 提上来（审计 §10 P1 的评价是"这是正确做法，应推广"）。
 */
async function framesAlive(app, ms = 2500) {
  for (let i = 0; i < 3; i++) {
    await bringToFront(app)
    await app.ev(
      `(() => { window.__RAF = 'pending'; requestAnimationFrame(() => { window.__RAF = 'ok' }); return 'ok' })()`
    )
    const end = Date.now() + Math.round(ms / 3)
    while (Date.now() < end) {
      if ((await app.ev('window.__RAF')) === 'ok') return true
      await sleep(100)
    }
  }
  return false
}

/** `framesAlive` 的"直接 SKIP"版本：窗口不出帧就抛 `preconditionSkip` */
async function requireFrames(app, what = '依赖出帧的断言', ms) {
  if (await framesAlive(app, ms)) return
  throw preconditionSkip(`${what}：窗口不产生帧（多半被别的窗口遮挡）——请在窗口可见时重跑`)
}

// ─── 输入模拟（统一从这里取，别各写各的坐标算法）─────────────────────────────
async function key(send, type, keyName, code, vk) {
  await send('Input.dispatchKeyEvent', {
    type,
    key: keyName,
    code,
    windowsVirtualKeyCode: vk
  })
}

/** 敲一个组合键（默认按下+抬起），modifiers 见 CDP Input.dispatchKeyEvent */
async function pressKey(send, { key: k, code, vk, modifiers = 0 }) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    modifiers
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    modifiers
  })
}

async function insertText(send, text) {
  await send('Input.insertText', { text })
}

/** 取元素中心的页面坐标（返回 null = 元素不存在） */
async function centerOf(ev, selector) {
  const raw = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height })
  })()`)
  return raw ? JSON.parse(raw) : null
}

/** 按选择器点一下（元素不存在返回 false） */
async function clickSelector(send, ev, selector) {
  const p = await centerOf(ev, selector)
  if (!p) return false
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: p.x,
    y: p.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: p.x,
    y: p.y,
    button: 'left',
    clickCount: 1
  })
  return true
}

/** 点页面坐标 */
async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

/**
 * 直接起一个 **不经过 `start-isolated.ps1`** 的实例。
 *
 * 为什么需要它：ps1 的第 2 步会**先删掉 `--user-data-dir`**（保证每个套件都从全新 profile 开始），
 * 而有一类套件验的正是**启动路径对已有文件的处理** —— 草稿 GC、迁移、备份轮换的夹具
 * 必须在实例起来之前就躺在数据目录里，删掉就没得验了。
 *
 * 收尾**不要**只 `proc.kill()`：我们是通过 `cmd.exe /c electron.cmd` 起的，
 * 杀掉 cmd 不保证 Electron 跟着走。一律用
 * `startIsolated({ userData, port, cleanupOnly: true })`（按 `--user-data-dir` 精确杀进程树）。
 *
 * ⚠️ 起之前建议先 `startIsolated({ ..., cleanupOnly: true })` 清一遍：
 *    否则端口可能还被上一轮没杀干净的实例占着，套件会连到**上一个 profile** 的窗口上。
 */
function spawnApp({ userData, port = 9222, env = {} } = {}) {
  const ROOT = path.join(__dirname, '..', '..')
  const electron = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
  return spawn('cmd.exe', ['/c', electron, '.', `--user-data-dir=${userData}`], {
    cwd: ROOT,
    // 调试端口靠**环境变量**开（见 main/index.ts）——只传命令行开关是不生效的
    env: { ...process.env, LUMIN_DEBUG_PORT: String(port), ...env },
    stdio: 'ignore',
    detached: false
  })
}

/**
 * **起实例的正确姿势**（第 135 轮收口，全部套件/探针共用这一条路径）
 *
 * ## ⚠️ 真因：`ELECTRON_RUN_AS_NODE` 会被 `spawn` **继承**，必须 `delete`
 * 一旦它非空（本环境里常被上层进程带进来），`electron.cmd .` 就退化成"用 **node** 跑 `.`"：
 * 主进程里 `require('electron').app` 是 `undefined`，随后报
 * `Cannot read properties of undefined (reading 'isPackaged')` 并**立刻退出**。
 * 症状极具误导性：窗口标题一闪、`DevTools listening on …` 已经打出来、**探针连上之前进程数就归零** ——
 * 多轮里我一直误判成"同目录复用导致实例活不久"，其实是环境变量。
 * **注意：`ELECTRON_RUN_AS_NODE: undefined` 会被 `spawn` 忽略（等价于没删）⇒ 必须 `delete`。**
 *
 * ## 其余要点
 *   * **非阻塞**：`spawn`（不是 `spawnSync`）—— 原来的 `start-isolated.ps1` 是"起实例→轮询→READY→退出"
 *     的语义，用 `spawnSync` 等它时，只要脚本起不来就**永久阻塞**（历史上多次把运行器挂死）。
 *   * **硬超时**：轮询 `/json/list` 最多 `readyMs`（默认 90s），超时**kill 并如实返回本次的退出码与日志尾部**。
 *   * **每次全新 userData**：唯一名、跑完即弃 —— 同目录复用会撞单实例锁/profile 残留。
 *   * **精确清理**：按 `--user-data-dir` 杀，不用"命令行含某关键字就杀"（会误杀）。
 *
 * @returns `{ ok, port, userData, log, proc, attempts, close }`；`ok:false` 时 `attempts` 里带每次的失败原因。
 */
async function launchStable({
  tag = 'inst',
  userData = null,
  ports = [9440, 9441, 9442],
  tries = 3,
  readyMs = 90000,
  rootDir = null,
  /** 追加给 Electron 的参数（例如 `--lumin-open=<encoded>`）；默认空，既有调用方不受影响 */
  extraArgs = [],
  /**
   * 端口选择策略：
   *   * `'skip-busy'`（默认）：端口上有**别的**实例在跑就换下一个 —— 防止连到陈旧实例上
   *     （本轮实际踩过：残留实例占着 9440，新实例 DevTools `bind()` 失败，而 `connect()`
   *     连到了那个陈旧实例，夹具完全不对）。
   *   * `'force'`：**忽略占用检查**，直接用 `ports[0]`。给"先关掉自己那个实例、再在同一端口重起"
   *     的调用方用（`bootInstance` 就是这种；用 `'skip-busy'` 会因为**自己**占着端口而误判成"全占用"）。
   */
  portPolicy = 'skip-busy'
} = {}) {
  const ROOT = rootDir || path.join(__dirname, '..', '..')
  const attempts = []
  /** 轮询 CDP：返回页面目标或 null */
  const probe = async (port) => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1500)
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctl.signal })
      clearTimeout(t)
      if (!r.ok) return null
      const list = await r.json()
      return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null
    } catch (e) {
      return null
    }
  }
  const killByUserData = (ud) => {
    try {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${String(ud).replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
    } catch (e) {
      /* 忽略 */
    }
  }
  for (let i = 0; i < Math.max(1, tries); i++) {
    let port = ports[i % ports.length]
    /**
     * ⚠️ **先确认端口是空的**：上一轮留下的实例（或其它 agent 起的实例）会占着端口，
     * 新实例的 DevTools `bind()` 失败（`tcp_socket_win.cc: bind() returned an error`），
     * 而 `connect()` 会**连到那个陈旧实例**上 ⇒ 夹具不对、统计全是假数据（这一坑本轮实际踩到）。
     * 占用就换下一个候选端口；全占则如实失败。
     */
    const busy = portPolicy === 'force' ? null : await probe(port)
    if (busy) {
      const free = []
      for (const x of ports) if (!(await probe(x))) free.push(x)
      if (!free.length) {
        attempts.push({
          i: i + 1,
          port,
          ready: false,
          code: null,
          busy: true,
          tail: `端口 ${ports.join('/')} 都被占用（先杀掉残留 electron 再跑）`
        })
        continue
      }
      port = free[0]
    }
    const ud =
      userData && tries === 1
        ? userData
        : path.join(os.tmpdir(), `xw-${tag}-${Date.now().toString(36)}${i}-ud`)
    const logFile = path.join(ROOT, 'tmp', `inst-${tag}-${i + 1}.log`)
    try {
      fs.rmSync(ud, { recursive: true, force: true })
    } catch (e) {
      /* 忽略 */
    }
    try {
      fs.mkdirSync(ud, { recursive: true })
    } catch (e) {
      /* 忽略 */
    }
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
    } catch (e) {
      /* 忽略 */
    }
    const fd = fs.openSync(logFile, 'w')
    const electron = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    const childEnv = {
      ...process.env,
      LUMIN_DEBUG_PORT: String(port),
      /**
       * ⚠️ 必须显式信任临时目录：套件/探针的夹具都写在 `os.tmpdir()`，而主进程对 `file:read`
       * 有**路径授权**（未授权会回 `PathNotAuthorized`，页面侧看到 `openPath` 直接 `false`，
       * 表现为"夹具没被打开 / 夹具没渲染成预期形状"这种含糊 skip）。`start-isolated.ps1` 会自己设
       * 这个变量，`spawn` 这条路必须自己设。
       */
      LUMIN_TRUSTED_PATHS: os.tmpdir()
    }
    // ⚠️ 关键一行：必须 **delete**（置 undefined 会被 spawn 忽略）
    delete childEnv.ELECTRON_RUN_AS_NODE
    const proc = spawn(
      'cmd.exe',
      [
        '/c',
        electron,
        '.',
        `--user-data-dir=${ud}`,
        '--disable-features=CalculateNativeWinOcclusion',
        ...extraArgs
      ],
      {
        cwd: ROOT,
        env: childEnv,
        stdio: ['ignore', fd, fd],
        detached: false
      }
    )
    let page = null
    const t0 = Date.now()
    while (Date.now() - t0 < readyMs) {
      page = await probe(port)
      if (page) break
      if (proc.exitCode != null) break
      await sleep(500)
    }
    const tail = (() => {
      try {
        return fs.readFileSync(logFile, 'utf-8').split('\n').slice(-14).join('\n')
      } catch (e) {
        return '(无日志)'
      }
    })()
    attempts.push({ i: i + 1, port, ud, ready: !!page, code: proc.exitCode, log: logFile, tail })
    if (page) {
      return {
        ok: true,
        port,
        userData: ud,
        page,
        proc,
        log: logFile,
        attempts,
        close: () => {
          try {
            proc.kill()
          } catch (e) {
            /* 忽略 */
          }
          killByUserData(ud)
          try {
            fs.closeSync(fd)
          } catch (e) {
            /* 忽略 */
          }
        }
      }
    }
    try {
      proc.kill()
    } catch (e) {
      /* 忽略 */
    }
    killByUserData(ud)
    try {
      fs.closeSync(fd)
    } catch (e) {
      /* 忽略 */
    }
  }
  return { ok: false, attempts }
}

/**
 * 起/收一个**隔离实例**（项目标准入口 `tools/start-isolated.ps1`）。
 *
 * 什么时候需要它：套件必须在**实例启动前**摆好前置状态或环境变量 —— 典型两类：
 *   * 往 `--user-data-dir` 里预置文件（启动路径上的行为才验得到，例如草稿 GC、备份轮换）；
 *   * 传只有启动时读得到的开发态开关（例如 `LUMIN_EXPORT_DIR`，见 src/main/testPaths.ts）。
 *
 * ⚠️ 它会**先删掉 `--user-data-dir`**：要保留预置文件时用 `spawnApp()`（见上）。
 * 实现要点：`env` 由 powershell 继承 → `Start-Process` 再传给 Electron
 * （ps1 只覆盖 `LUMIN_DEBUG_PORT` / `LUMIN_TRUSTED_PATHS`，其余原样透过）。
 * `cleanupOnly` 会按 user-data-dir **精确**杀掉实例并删数据目录（连子进程一起），
 * 所以收尾一律用它，而不是 `proc.kill()`。
 *
 * @returns powershell 退出码（0 = READY；`cleanupOnly` 时为 0 = CLEANED）
 */
function startIsolated({ userData, port = 9222, env = {}, cleanupOnly = false } = {}) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, '..', 'start-isolated.ps1'),
    '-UserData',
    userData,
    '-Port',
    String(port)
  ]
  if (cleanupOnly) args.push('-CleanupOnly')
  const r = spawnSync('powershell', args, {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ...env },
    stdio: 'ignore'
  })
  return r.status
}

/**
 * 点工具栏的**模式分段控件**（0=实时渲染 / 1=分屏 / 2=源码）。
 *
 * 为什么按序号而不是按按钮文字找：按钮上是图标 + **可本地化**的标签，
 * 按文字找的话「换语言就跑不了」（老套件里写死中文『分屏』正是它们长期发红的原因之一）。
 * 顺序由 Toolbar 的 `modeItems` 固定，控件本身是 `role="tablist"` + 三个 `role="tab"`。
 * @returns 是否点到了（false = 控件还没渲染出来）
 */
async function clickMode(app, index, waitMs = 450) {
  const raw = await app.ev(`(() => {
    const list = [...document.querySelectorAll('[role="tablist"]')].find(
      (l) => l.querySelectorAll('[role="tab"]').length === 3
    )
    const btn = list?.querySelectorAll('[role="tab"]')[${index}]
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!raw) return false
  const p = JSON.parse(raw)
  await clickAt(app.send, p.x, p.y)
  await sleep(waitMs)
  return true
}

/** 等视图恢复完成（切模式时内容区会被临时隐藏，期间坐标/焦点都不可靠） */
async function waitRestored(ev, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const busy = await ev(`!!document.querySelector('.view-restoring')`).catch(() => false)
    if (!busy) return true
    await sleep(50)
  }
  return false
}

let docSeq = 0

/**
 * 让应用「打开一份新文档」（内容 = md），返回文档路径。
 *
 * 为什么不让套件直接 `ed.commands.setContent()`：那只是换**编辑器**内容，
 * 而代码块里的 CodeMirror 有一条「CM 拿着光标时绝不覆盖」的规则（手册 §4.59）——
 * 先前的用例若刚在代码块里打过字（CM 仍持焦），外部换内容时 CM 会**故意**保持旧文本，
 * 于是后续断言看到的是上一份文档的内容（实测：空代码块退格那条会莫名其妙 blocks=1）。
 *
 * 走 `files.current` 赋值 + path 变化则完全等同于真实「打开文件」：EditorView 按
 * `:key=path` 重建渲染面，CM 也一起重建 —— 这才是套件想测的那条路径。
 * @returns 该文档的路径（每次调用都不同，保证触发重建）
 */
async function openDocWith(app, md, name = 'lumin-fixture.md') {
  docSeq += 1
  const path = `/tmp/lumin-suite-${Date.now()}-${docSeq}/${name}`
  await app.ev(`(() => {
    const f = window.__L.files()
    f.current = {
      path: ${JSON.stringify(path)},
      name: ${JSON.stringify(name)},
      content: ${JSON.stringify(md)},
      mtimeMs: Date.now(),
      savedContent: ${JSON.stringify(md)}
    }
    // 语义上这就是一次外部整篇替换（与打开文件同一条路径）
    f.noteExternalReplace()
    return 'ok'
  })()`)
  await sleep(600)
  return path
}

/** 点某个选择器的中心（坐标每次现取：布局可能刚变过），返回是否点到 */
async function clickCenter(send, ev, selector) {
  const p = await centerOf(ev, selector)
  if (!p) return false
  await clickAt(send, p.x, p.y)
  return true
}

// ─── 结果汇总 ────────────────────────────────────────────────────────────────
/**
 * 统一结果格式（机器可读，tools/run-suites.js 依赖末行）：
 *   PASS 名称 | 备注
 *   FAIL 名称 | 备注
 *   SKIP 名称 | 原因
 *   TOTAL 20 PASS 18 FAIL 1 SKIP 1
 *   --- 18/20 PASS
 */
class Reporter {
  constructor(title) {
    this.title = title
    this.lines = []
    this.passed = 0
    this.failed = 0
    this.skipped = 0
    if (title) console.log('## ' + title)
  }
  note(msg) {
    this.lines.push('· ' + msg)
    console.log('· ' + msg)
  }
  check(name, ok, extra) {
    const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : ' | ' + extra)
    this.lines.push(line)
    console.log(line)
    if (ok) this.passed += 1
    else this.failed += 1
    return !!ok
  }
  skip(name, why) {
    const line = 'SKIP ' + name + (why ? ' | ' + why : '')
    this.lines.push(line)
    console.log(line)
    this.skipped += 1
  }
  get total() {
    return this.passed + this.failed + this.skipped
  }
  /** 打印汇总，返回进程退出码（有 FAIL → 1） */
  finish(extra) {
    if (extra) console.log(extra)
    console.log(`TOTAL ${this.total} PASS ${this.passed} FAIL ${this.failed} SKIP ${this.skipped}`)
    console.log(`--- ${this.passed}/${this.total} PASS`)
    return this.failed ? 1 : 0
  }
}

/** 顶层错误处理：把异常打成 FAIL 行并给出非零退出码 */
/**
 * ─── 「前置条件不满足」→ 如实 SKIP 的范式（清单 §10 P1「已知 flaky 的套件没有隔离」）────
 *
 * 背景：一批套件要靠**真实按键 / 真实帧**才能跑（`ensureFocus` 之后还要窗口真是前台）。
 * 用户自己那套 Lumin 可能正占着前台，于是同一构建下套件整体跑时会偶发失败 ——
 * 症状是"CDP 注入的按键丢了"，看起来像产品缺陷，实际是环境。审计的建议是
 * **像 `_verify-outline-nav.js` 那样显式检查前置条件，拿不到就 `report.skip`**。
 *
 * 用法（套件不需要改结构，只把"等不到焦点"那处的 throw 换成 `preconditionSkip`）：
 * ```js
 * const { preconditionSkip, fatal } = require('./lib/harness')
 * throw preconditionSkip('编辑器拿不到焦点（真实输入会打到 body 上）')
 * main().then((c) => process.exit(c)).catch(fatal)   // fatal 会把它按 SKIP 结算
 * ```
 * 结算口径：打印 `SKIP: 前置条件不满足 …` 后 **exit 0**；运行器认得这个前缀
 * （见 run-suites.js 的 skipped 判定），于是记 **SKIP** 而不是 PASS/FAIL/NOASSERT。
 */
const PRECONDITION_SKIP_PREFIX = 'SKIP: 前置条件不满足'

/** 造一个「前置条件不满足」的错误（交给 fatal 按 SKIP 结算） */
function preconditionSkip(reason) {
  const err = new Error(reason)
  err.preconditionSkip = true
  return err
}

function fatal(err) {
  // 前置条件不满足：**不是缺陷**，按如实 SKIP 结算（清单 §1.C.1 口径：SKIP 不算失败）
  if (err && err.preconditionSkip) {
    console.log(`${PRECONDITION_SKIP_PREFIX} ${err.message}`)
    console.log('--- 0/1 PASS')
    process.exit(0)
  }
  console.error('ERROR ' + (err && err.stack ? err.stack : err))
  console.log('--- 0/1 PASS')
  process.exit(1)
}

module.exports = {
  DEFAULT_PORT,
  sleep,
  cdpUrl,
  listTargets,
  isAppPage,
  appPages,
  waitForAppPage,
  attach,
  connect,
  bringToFront,
  ensureFocus,
  requireFocus,
  framesAlive,
  requireFrames,
  preconditionSkip,
  PRECONDITION_SKIP_PREFIX,
  watchEvents,
  PINIA,
  INJECT,
  inject,
  settle,
  waitEditor,
  showToolbar,
  key,
  pressKey,
  insertText,
  centerOf,
  clickSelector,
  clickAt,
  clickMode,
  clickCenter,
  waitRestored,
  openDocWith,
  startIsolated,
  launchStable,
  spawnApp,
  instanceLog,
  Reporter,
  fatal
}
