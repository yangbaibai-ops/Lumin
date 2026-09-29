'use strict'
// 验收：**手动保存**模式下关窗要问「是否保存更改？」（用户口径，对齐 Typora 的实测行为）
//
// 用户口径（原话）：Typora 默认是手动保存，未启用自动保存时关闭会提示
// 「是否保存更改？／如果不保存，您的更改将会丢失。」—— 本项目也要这样。
//
// 改造前的行为（本套件要防它回归）：关窗**一句都不问**，`flushAll()` 直接把有路径的文档
// 落盘、未命名文档只写草稿（见 stores/files.ts 的老注释"避免关闭时弹出保存对话框"）。
// 对选了手动保存的用户来说，那是"我没让它保存，它自己保存了"。
//
// 现在的口径（判定在 shared/closePrompt.ts，单测 tests/closePrompt.test.mjs）：
//   * 自动保存**关着** + 这篇文档有未保存改动 → 弹三选一：保存 / 不保存 / 取消；
//   * 自动保存**开着** → 不问（改动本来就在写盘路上）；
//   * 系统关机/注销（session-end）→ 不问（没人能点那个按钮）。
//
// 三条出路各自的收尾（每一步都真做一遍，因为它们的失败方式互不相同）：
//   * 「取消」→ 窗口必须**继续活着**。这一条最容易做错：主进程的关窗守卫在 close 那一刻
//     就起来了，2.5 秒没心跳（用户正看着对话框，没人在落盘）就强关、总上限 30 秒更强关 ——
//     所以渲染层必须显式 `app:cancelClose` 把它撤掉（本套件在 3.2 秒处验窗口还活着）；
//   * 「不保存」→ 不落盘、**并且把草稿删掉**（否则下次启动又弹"检测到未保存的草稿"，
//     与用户刚说的"更改将会丢失"自相矛盾）；
//   * 「保存」→ 落盘后再关；**保存没成功（另存为被取消 / 写盘失败）则不许关窗**
//     （用户以为自己保存了是最糟的结果），R1b 用"让 `files.save` 返回 false"复现这条。
//
// 自管实例（4 轮，每轮一个全新 userData）：关窗是**真的把窗口关掉**，一个实例只能验一次
// 半（R1 取消后窗口还在，可以接着验 R2 不保存），所以不能像普通套件那样只用一个常驻实例。
// 端口 9222，跑前先 `npm run build`。
const { spawn, execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const REPO = path.join(__dirname, '..')
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron.exe')
const PORT = 9222
const UD = path.join(os.tmpdir(), 'lumin-close-prompt-userdata')
const WS = path.join(os.tmpdir(), 'lumin-close-prompt-ws')
const DOC = path.join(WS, 'prompt.md')
const ORIGINAL = '# prompt\n\n原始正文\n'
const NEW_TEXT = 'CLOSE-PROMPT-新内容'
/** 草稿文件名 = sha1(键).slice(0,16) + '.json'，键的口径见 lib/draftRules.draftKeyFor */
const DRAFT_KEY = 'file-' + encodeURIComponent(DOC.toLowerCase())
const DRAFT_FILE = path.join(
  UD,
  'drafts',
  `${createHash('sha1').update(DRAFT_KEY).digest('hex').slice(0, 16)}.json`
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 读一个 CDP 端点。
 *
 * ⚠️ 必须带超时并把请求 `destroy` 掉：应用退出时 9222 会先"半开"一小会儿 ——
 * 连接建上了但既不发数据也不报错，那个请求就永远不 settle。而套件是"事件循环没活儿了就退出"的，
 * 于是进程**静默退出、一条断言都不再打**（实测踩过：R4 整段没了）。超时后主动销毁，保证
 * promise 一定会 settle。
 */
function get(p, timeoutMs = 1500) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try {
          res(JSON.parse(d))
        } catch (e) {
          rej(e)
        }
      })
    })
    req.on('error', rej)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('cdp-timeout')))
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  /**
   * ⚠️ 窗口关掉之后，之前发出去、还没回来的 CDP 调用**永远不会有响应**。
   * 不处理的话那个 promise 永不 settle，而套件是靠"事件循环还有没有活儿"决定何时退出的 ——
   * 表现就是**进程静默退出、一条断言都没打印**（运行器记 NOASSERT，排查时毫无线索）。
   * 这里把挂着的调用在连接断开时统一 reject，调用方用 `.catch()` 兜住即可。
   */
  const rejectAll = (why) => {
    for (const [, res] of pending) res({ __closed: why })
    pending.clear()
  }
  ws.onclose = () => rejectAll('closed')
  ws.onerror = () => rejectAll('error')
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.__closed) throw new Error('CDP ' + r.__closed)
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__vt = {
    files: () => pinia._s.get('files'),
    settings: () => pinia._s.get('settings'),
    ui: () => pinia._s.get('ui')
  }
  return 'ok'
})()`

/** 弹框的三个按钮 + 文案（钩子见 ModalHost.vue 的 data-triple-*） */
const DIALOG = `(() => {
  const root = document.querySelector('[data-triple="true"]')
  if (!root) return JSON.stringify({ open: false })
  const btn = (sel) => {
    const el = root.querySelector(sel)
    return el ? el.textContent.trim() : null
  }
  return JSON.stringify({
    open: true,
    title: root.querySelector('h3')?.textContent?.trim() ?? null,
    body: root.querySelector('p')?.textContent?.trim() ?? null,
    confirm: btn('[data-triple-confirm]'),
    alt: btn('[data-triple-alt]'),
    cancel: btn('[data-triple-cancel]')
  })
})()`

const clickDialog = (which) =>
  `(() => { const el = document.querySelector('[data-triple-${which}]'); if (!el) return 'no-button'; el.click(); return 'clicked' })()`

async function waitForCdp(timeoutSteps = 80) {
  for (let i = 0; i < timeoutSteps; i++) {
    try {
      const list = await get('/json/list')
      const pages = list.filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
      if (pages.length) return pages
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  throw new Error('CDP 没起来')
}

async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    const ok = await c.ev(SETUP).catch(() => 'err')
    if (ok === 'ok') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

function launch() {
  const env = { ...process.env, LUMIN_DEBUG_PORT: String(PORT) }
  delete env.ELECTRON_RENDERER_URL
  delete env.LUMIN_DEV_PROFILE
  return spawn(ELECTRON, [REPO, `--user-data-dir=${UD}`], { env, stdio: 'ignore' })
}

async function waitExit(child) {
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (child.exitCode !== null) break
  }
  await sleep(1200)
  return child.exitCode !== null
}

function killTree(child) {
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

async function windowAlive() {
  try {
    const list = await get('/json/list')
    return list.some((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
  } catch {
    return false
  }
}

/** 关窗要靠主进程的 getFocusedWindow()：拿不到焦点就别硬判（如实 SKIP） */
async function ensureFocus(conn) {
  for (let i = 0; i < 15; i++) {
    await conn.send('Page.bringToFront').catch(() => {})
    if (await conn.ev('document.hasFocus()').catch(() => false)) return true
    await sleep(200)
  }
  return false
}

/**
 * 夹具：把工作区指到 WS、打开 DOC，并把缓冲区改成 NEW_TEXT（= 有未保存改动）。
 * `autoSave` 由调用方给（R1/R2/R3 是 false，R4 是 true）。
 */
async function openDirty(conn, autoSave) {
  await conn.ev(`(async () => {
    const f = window.__vt.files()
    window.__vt.settings().set('autoSave', ${autoSave})
    await f.setRoot(${JSON.stringify(WS)})
    await f.openPath(${JSON.stringify(DOC)})
    return 'ok'
  })()`)
  await sleep(1800)
  return JSON.parse(
    await conn.ev(`(() => {
      const f = window.__vt.files()
      f.setContent(${JSON.stringify(NEW_TEXT)}, 'external')
      return JSON.stringify({ dirty: f.dirty, path: f.current?.path ?? null })
    })()`)
  )
}

/**
 * 点一下窗口的关闭：走真实的主进程 close 路径（`app:close` → getFocusedWindow().close()）。
 *
 * ⚠️ **不要 await 它的返回**：这条路最终可能把页面关掉，那条 `Runtime.evaluate` 的响应就永远
 * 不会回来（套件会静默退出）。所以统一用 `triggerClose(conn)` 发包、不等回执。
 */
const TRIGGER_CLOSE = `(() => { window.luminAPI.app.close(); return 'ok' })()`

function triggerClose(conn) {
  void conn.ev(TRIGGER_CLOSE).catch(() => {})
}

/** 点对话框里的某个按钮（同样不 await：点「保存/不保存」之后页面就没了） */
function clickDialogButton(conn, which) {
  void conn.ev(clickDialog(which)).catch(() => {})
}

/**
 * 关窗后盯到窗口消失为止，回报「中间有没有出现过「是否保存更改？」对话框」。
 * 用于 R4（自动保存开着）：那里**不该**有任何对话框，而"没看到"必须是真的盯过一整段
 * 窗口存活期才算数（只探一次的话，窗口关得快就什么都探不到，结论会退化成"反正没看见"）。
 */
async function watchClose(conn, child, ms = 8000) {
  const end = Date.now() + ms
  let sawDialog = false
  let reason = 'timeout'
  for (;;) {
    // 先看进程退出（最可靠）：应用退出后 9222 会先"半开"一小会儿，
    // 那期间探 CDP 既拿不到数据也不报错，白等一轮超时
    if (child.exitCode !== null) {
      reason = 'exited'
      break
    }
    const d = await evalTimeout(conn, DIALOG, 600)
    const parsed = d ? JSON.parse(d) : { open: false }
    if (parsed.open) {
      sawDialog = true
      reason = 'dialog'
      break
    }
    if (child.exitCode !== null) {
      reason = 'exited'
      break
    }
    if (!(await windowAlive())) {
      reason = 'page-gone'
      break
    }
    if (Date.now() > end) break
    await sleep(100)
  }
  const exited = await waitExit(child)
  console.log(`  watchClose: reason=${reason} exited=${exited}`)
  return { sawDialog, exited }
}

/**
 * 带超时的页面求值：窗口正在关闭时，CDP 调用可能**既不回响应也不报错**（半开状态），
 * 那样 await 会永远挂着 —— 而套件是"事件循环没活儿了就退出"的，结果是**静默退出、
 * 后面的断言一条都不打**（实测踩过：R4 整段没了）。所以凡是"窗口可能正在消失"时的探针，
 * 一律走这里：超时就当"没探到"，让调用方按进程退出 / 端口消失来判断。
 */
async function evalTimeout(conn, expr, ms = 600) {
  try {
    return await Promise.race([conn.ev(expr), sleep(ms).then(() => null)])
  } catch {
    return null
  }
}

async function waitDialog(conn, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    const d = await evalTimeout(conn, DIALOG, 800)
    const parsed = d ? JSON.parse(d) : { open: false }
    if (parsed.open) return parsed
    if (Date.now() > end) return parsed
    await sleep(250)
  }
}

;(async () => {
  const results = []
  let summaryPrinted = false
  let completed = false
  /**
   * 断言**逐条立刻打印**：这条套件要真的关窗口，中途可能撞上"页面没了 / CDP 断了"这类
   * 一次性故障 —— 那时若等到最后才汇总，运行器只会看到一条 NOASSERT（"没有产出任何断言"），
   * 排查时毫无线索。逐条打印 + 退出钩子里补汇总，最差也能看到"跑到哪一条、后面为什么没跑"。
   */
  const c = (n, cond, extra) => {
    const line = (cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : '')
    results.push(line)
    console.log(line)
  }
  const printSummary = () => {
    if (summaryPrinted || !results.length) return
    summaryPrinted = true
    const failed = results.filter((r) => r.startsWith('FAIL')).length
    console.log(`--- ${results.length - failed}/${results.length} PASS`)
  }
  process.on('exit', () => {
    // 没跑完就退出（撞上页面消失/CDP 断开这类一次性故障）时**不能**打一条绿色的汇总 ——
    // 那会让运行器把"半途死掉"当成全绿（实测踩过：R4 整段没跑，汇总却是 14/14 PASS）。
    if (!completed) {
      console.log(
        'FAIL suite-ended-early | 套件在跑完之前就退出了（看上面的里程碑：最后一条之后的那一轮没跑完）'
      )
      return
    }
    printSummary()
  })
  const disk = () => fs.readFileSync(DOC, 'utf-8')

  rmrf(UD)
  rmrf(WS)
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(DOC, ORIGINAL, 'utf-8')

  let round = null
  let extraChild = null
  let skipped = null

  try {
    // ── R1「取消」＋ R2「不保存」：同一个实例（取消之后窗口还在，正好接着验不保存）──
    round = { child: launch() }
    const pages = await waitForCdp()
    round.conn = await attach(pages[0])
    await sleep(2500)
    const fixture = await openDirty(round.conn, false)
    c(
      'fixture-doc-is-dirty',
      fixture.dirty === true && fixture.path === DOC,
      JSON.stringify(fixture)
    )
    // 草稿是崩溃兜底，编辑期间一直在写；这里显式写一份，让 R2 的"删草稿"可判（不赌防抖时序）
    await round.conn.ev(`(async () => { await window.__vt.files().writeDraft(); return 'ok' })()`)
    await sleep(600)
    c('fixture-draft-exists', fs.existsSync(DRAFT_FILE), DRAFT_FILE)

    if (!(await ensureFocus(round.conn))) {
      skipped = 'SKIP: 前置条件不满足 —— 窗口拿不到焦点（app:close 依赖 getFocusedWindow）'
    } else {
      console.log('R1 手动保存 + 脏 → 关窗应弹「是否保存更改？」，先点「取消」')
      triggerClose(round.conn)
      const dlg = await waitDialog(round.conn)
      c(
        'manual-close-prompts-when-dirty',
        dlg.open === true,
        JSON.stringify({ open: dlg.open, title: dlg.title })
      )
      c(
        'prompt-text-is-the-typora-wording',
        dlg.title === '是否保存更改？' && dlg.body === '如果不保存，您的更改将会丢失。',
        JSON.stringify({ title: dlg.title, body: dlg.body })
      )
      c(
        'prompt-offers-save-dontsave-cancel',
        dlg.confirm === '保存' && dlg.alt === '不保存' && dlg.cancel === '取消',
        JSON.stringify({ confirm: dlg.confirm, alt: dlg.alt, cancel: dlg.cancel })
      )

      // 「取消」：窗口必须活下来 —— 而且是**跨过兜底时限**地活下来（旧实现这里 2.5s 就被强关）
      console.log('  → 点「取消」')
      const clickedCancel = await round.conn.ev(clickDialog('cancel'))
      await sleep(400)
      // ⚠️ 判据用 **store 状态**（`ui.tripleState === null`）而不是 DOM 里那层 `<Transition>` 是否
      // 已经卸载：窗口被遮挡时 Chromium 不出帧，`transitionend` 不来，元素会留在 DOM 里
      // （同一现象在 `_verify-sidebar-root-and-outline-side` 里也踩到过）。语义是"对话框已关闭"。
      const afterCancel = JSON.parse(
        await round.conn.ev(`(() => JSON.stringify({
          storeOpen: !!window.__vt.ui().tripleState
        }))()`)
      )
      c(
        'cancel-dismisses-the-dialog',
        clickedCancel === 'clicked' && afterCancel.storeOpen === false,
        JSON.stringify({ clickedCancel, ...afterCancel })
      )
      let aliveLate = null
      const t0 = Date.now()
      for (let i = 0; i < 10; i++) {
        await sleep(400)
        const alive = await windowAlive()
        if (Date.now() - t0 >= 3200) {
          aliveLate = alive
          break
        }
      }
      c(
        'cancel-keeps-the-window-alive',
        aliveLate === true,
        `取消后 3.2 秒窗口仍活着 = ${aliveLate}（渲染层必须发 app:cancelClose 撤掉关窗兜底；旧实现 2.5 秒就被强关）`
      )
      c(
        'cancel-leaves-the-file-untouched',
        disk() === ORIGINAL,
        JSON.stringify(disk().slice(0, 40))
      )
      const stillDirty = await round.conn.ev(`window.__vt.files().dirty === true`)
      c('cancel-keeps-the-changes-in-the-buffer', stillDirty === true, String(stillDirty))

      // ── R1b「保存没成功（另存为被取消 / 写盘失败）」→ 也不许关窗 ──
      // 这条最容易被写漏，后果也最糟：用户点了「保存」、以为写进去了，窗口却关掉 ——
      // 那份内容就只剩草稿了。这里把 `files.save` 换成"返回 false"复现"另存为被取消"
      // （原生对话框在自动化里没法驱动），然后要求窗口活下来、改动还在。
      console.log('R1b 让 save 返回 false（等价于另存为被取消）→ 点「保存」不该关窗')
      await round.conn.ev(`(() => {
        const f = window.__vt.files()
        window.__vt.__realSave = f.save
        f.save = async () => false
        return 'ok'
      })()`)
      triggerClose(round.conn)
      const dlg1b = await waitDialog(round.conn)
      clickDialogButton(round.conn, 'confirm')
      await sleep(600)
      let aliveLate1b = null
      const t1b = Date.now()
      for (let i = 0; i < 10; i++) {
        await sleep(400)
        const alive = await windowAlive()
        if (Date.now() - t1b >= 3200) {
          aliveLate1b = alive
          break
        }
      }
      c(
        'failed-save-keeps-the-window-open',
        dlg1b.open === true && aliveLate1b === true,
        `弹框出现 = ${dlg1b.open} / 点「保存」后 3.2 秒窗口仍活着 = ${aliveLate1b}（保存没成功就不许关窗）`
      )
      const stillDirty1b = await round.conn.ev(`window.__vt.files().dirty === true`)
      c('failed-save-keeps-the-changes', stillDirty1b === true, String(stillDirty1b))
      await round.conn.ev(`(() => {
        const f = window.__vt.files()
        if (window.__vt.__realSave) f.save = window.__vt.__realSave
        return 'ok'
      })()`)

      // ── R1c：用户在对话框前犹豫超过 30 秒（= 关窗兜底的**总上限**）也不许被强关 ──
      // 兜底的两条判据里，"心跳停了 2.5 秒就强关"防的是渲染进程卡死；而"人在想"不是卡死 ——
      // 渲染层因此发带 `deciding` 的心跳，主进程据此把这段时间排除在 30 秒总上限之外。
      // 这条断言很慢（要真的等过上限），但不写就等于把那条口径交给运气。
      console.log('R1c 在对话框前等 32 秒（跨过 30 秒总上限）→ 窗口必须还在')
      triggerClose(round.conn)
      const dlg1c = await waitDialog(round.conn)
      let aliveAtCap = null
      const t1c = Date.now()
      for (let i = 0; i < 17; i++) {
        await sleep(2000)
        aliveAtCap = await windowAlive()
        if (!aliveAtCap || Date.now() - t1c >= 32_000) break
      }
      c(
        'long-deliberation-is-not-force-closed',
        dlg1c.open === true && aliveAtCap === true,
        `弹框出现 = ${dlg1c.open} / 等了 ${Math.round((Date.now() - t1c) / 1000)} 秒后窗口仍活着 = ${aliveAtCap}`
      )
      clickDialogButton(round.conn, 'cancel')
      await sleep(600)
      const afterCancel1c = await evalTimeout(
        round.conn,
        `(() => String(!!window.__vt.ui().tripleState))()`,
        1500
      )
      c(
        'deliberation-then-cancel-still-works',
        afterCancel1c === 'false',
        `等过 30 秒之后再点「取消」仍生效 = ${afterCancel1c}`
      )

      // ── R2「不保存」：不落盘 + 草稿删掉 + 窗口关掉 ──
      console.log('R2 同一个实例再关一次 → 点「不保存」')
      triggerClose(round.conn)
      const dlg2 = await waitDialog(round.conn)
      clickDialogButton(round.conn, 'alt')
      const closed = await waitExit(round.child)
      c(
        'dont-save-closes-the-window',
        dlg2.open === true && closed === true,
        JSON.stringify({ open: dlg2.open, closed })
      )
      c(
        'dont-save-leaves-the-file-untouched',
        disk() === ORIGINAL,
        JSON.stringify(disk().slice(0, 40))
      )
      c(
        'dont-save-drops-the-draft',
        !fs.existsSync(DRAFT_FILE),
        fs.existsSync(DRAFT_FILE)
          ? `草稿还在 ${DRAFT_FILE}（mtime=${fs.statSync(DRAFT_FILE).mtimeMs}，内容=${JSON.stringify(
              fs.readFileSync(DRAFT_FILE, 'utf-8').slice(0, 60)
            )}）—— 下次启动会弹"检测到未保存的草稿"，与刚选的"不保存"自相矛盾`
          : DRAFT_FILE
      )
      round.conn.ws.close()
    }

    // ── R3「保存」：落盘后再关 ──
    if (!skipped) {
      rmrf(UD)
      fs.writeFileSync(DOC, ORIGINAL, 'utf-8')
      const r3 = { child: launch() }
      extraChild = r3.child
      const p3 = await waitForCdp()
      r3.conn = await attach(p3[0])
      await sleep(2500)
      await openDirty(r3.conn, false)
      if (!(await ensureFocus(r3.conn))) {
        skipped = 'SKIP: 前置条件不满足 —— 窗口拿不到焦点（app:close 依赖 getFocusedWindow）'
        killTree(r3.child)
      } else {
        console.log('R3 手动保存 + 脏 → 点「保存」应落盘后再关')
        triggerClose(r3.conn)
        const dlg3 = await waitDialog(r3.conn)
        clickDialogButton(r3.conn, 'confirm')
        const closed3 = await waitExit(r3.child)
        c(
          'save-then-close-happens',
          dlg3.open === true && closed3 === true,
          JSON.stringify({ open: dlg3.open, closed3 })
        )
        c(
          'save-writes-the-new-content',
          disk().includes(NEW_TEXT),
          JSON.stringify(disk().slice(0, 60))
        )
        r3.conn.ws.close()
      }
    }

    // ── R4「自动保存开着」：不弹框，直接落盘关窗 ──
    if (!skipped) {
      rmrf(UD)
      fs.writeFileSync(DOC, ORIGINAL, 'utf-8')
      const r4 = { child: launch() }
      extraChild = r4.child
      const p4 = await waitForCdp()
      r4.conn = await attach(p4[0])
      await sleep(2500)
      console.log('R4 实例就绪，准备夹具（autoSave = true）')
      await openDirty(r4.conn, true)
      console.log('R4 夹具就绪，等焦点')
      if (!(await ensureFocus(r4.conn))) {
        skipped = 'SKIP: 前置条件不满足 —— 窗口拿不到焦点（app:close 依赖 getFocusedWindow）'
        killTree(r4.child)
      } else {
        // 自动保存开着时，`scheduleSave` 会在 `autoSaveInterval`（默认 3s）后自己落盘；
        // 为了让"脏着关窗却不弹框"这条断言真的成立，落盘前再改一次内容（确保此刻是脏的），
        // 然后**立刻**触发关窗（不给自动保存抢先的机会）。
        const dirtyAtClose = await r4.conn.ev(`(() => {
          const f = window.__vt.files()
          f.setContent(${JSON.stringify(NEW_TEXT + '-R4')}, 'external')
          return f.dirty === true
        })()`)
        console.log('R4 自动保存开着 + 脏 → 关窗应**不弹框**、直接落盘')
        triggerClose(r4.conn)
        const watched = await watchClose(r4.conn, r4.child)
        c(
          'auto-save-on-does-not-prompt',
          dirtyAtClose === true && watched.sawDialog === false,
          `关窗那一刻是脏的 = ${dirtyAtClose}；窗口消失前一直盯着，出现过对话框 = ${watched.sawDialog}`
        )
        c('auto-save-on-still-closes', watched.exited === true, `窗口退出 = ${watched.exited}`)
        c(
          'auto-save-on-flushed-the-content',
          disk().includes(NEW_TEXT),
          JSON.stringify(disk().slice(0, 60))
        )
        r4.conn.ws.close()
      }
    }
  } finally {
    // 收尾要把**每一轮**起过的实例都杀掉：R3/R4 中途失败时（比如弹框没出现）窗口还活着，
    // 留着它等于给下一支套件占住 9222（工具的 README 把这条记成硬性规矩）
    for (const child of [round?.child, extraChild]) {
      if (child && child.exitCode === null) killTree(child)
    }
    await sleep(1200)
    rmrf(UD)
    rmrf(WS)
  }

  if (skipped) {
    console.log(skipped)
    return
  }
  completed = true
  printSummary()
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
