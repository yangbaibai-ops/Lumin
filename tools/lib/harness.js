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

/** connect：等页面 → attach → 返回句柄（不自动 settle，调用方按需） */
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
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
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
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  return true
}

/** 点页面坐标 */
async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
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
function fatal(err) {
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
  Reporter,
  fatal
}
