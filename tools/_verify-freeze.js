// 验收：全局防卡死兜底（心跳 / 无响应 / 崩溃节流 / 哨兵 / 自救入口 / 安全模式）。
//
// 跑法（自带隔离实例，端口 9486，userData 不含 "lumin"）：
//   node tools/_verify-freeze.js
//
// 前置：`npx electron-vite build`（本套件加载 out/renderer，不依赖 dev server）。
//
// 它真的会：
//   1. 在页面里同步阻塞 8s → 等主进程弹原生「页面响应缓慢/无响应」→ 截图 →
//      点「等待」→ 量恢复；再阻塞一次 → 点「重新加载并恢复」→ 用草稿恢复正文；
//   2. Page.crash → 自动重载一次；30s 内再崩一次 → 节流为"等用户点"；
//   3. 阻塞 3s → 读 `window.__LWORK.freezes` + 截图可见提示；
//   4. 合成一次结构超限的粘贴 → 护栏提示 → 点「改用纯文本粘贴」；
//   5. 超大文档 → 「以源码模式打开」；
//   6. 量输入延迟 P50/P95 与长任务数。
//
// 只操作**本套件自己的** Electron 实例（按 userData 路径识别），结束时 taskkill /T。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, execFileSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'tmp')
const PORT = 9486
const UD = path.join(os.tmpdir(), 'xw-freeze-ud')
const FIX = path.join(os.tmpdir(), 'xw-freeze-fixtures')
const MAIN_LOG = path.join(OUT, 'freeze-main.log')
const ERR_LOG = path.join(OUT, 'freeze-main-err.log')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const STAMP = Date.now().toString(36).toUpperCase()

// CDP 的 WebSocket 在 Node 里不总是被算作活跃 handle：没有保活，某个 await 的
// 消息没回来时进程会"静默退出 0"，套件看起来像没跑。
const keepalive = setInterval(() => {}, 1000)
const results = []
const data = { stamp: STAMP, port: PORT, userData: UD, fixtures: FIX }
function c(name, cond, extra) {
  results.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fsRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// ─── 进程 ───────────────────────────────────────────────────────────────────
function killInstance() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*xw-freeze-ud*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'ignore'
  })
}

function launch() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(FIX, { recursive: true })
  killInstance()
  if (fs.existsSync(UD)) {
    spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', UD], { stdio: 'ignore' })
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.LUMIN_DEBUG_PORT = String(PORT)
  env.LUMIN_TRUSTED_PATHS = os.tmpdir()
  const out = fs.openSync(MAIN_LOG, 'w')
  const err = fs.openSync(ERR_LOG, 'w')
  const child = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${UD}`, '--disable-features=CalculateNativeWinOcclusion'],
    { cwd: ROOT, env, stdio: ['ignore', out, err] }
  )
  data.pid = child.pid
  return child
}

// ─── CDP ────────────────────────────────────────────────────────────────────
function getJson(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (x) => (d += x))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
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
    if (r.result?.exceptionDetails) {
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    }
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => {
    const p = app._context.provides[s]
    return !!p && typeof p === 'object' && p._s instanceof Map
  })
  if (!sym) return 'no-pinia'
  const pinia = app._context.provides[sym]
  window.__vt = {
    files: () => pinia._s.get('files'),
    ui: () => pinia._s.get('ui'),
    ed: () => pinia._s.get('editor')?.instance ?? null,
    notifications: () => pinia._s.get('notifications')
  }
  return 'ok'
})()`

/**
 * 前置守卫：本套件会注入真实按键/滚轮（`Input.insertText` / `dispatchMouseEvent`）。
 * 窗口不在前台时输入会落到别的窗口（假红），所以每次 attach 都先要求焦点。
 */
async function requireFocus(conn) {
  try {
    await conn.send('Page.bringToFront')
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    return true
  } catch {
    return false
  }
}

async function attach(maxMs = 30000) {
  const deadline = Date.now() + maxMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const pages = (await getJson('/json/list')).filter(
        (t) => t.type === 'page' && /index\.html/.test(t.url)
      )
      if (!pages.length) throw new Error('no page target')
      const conn = connect(pages[0].webSocketDebuggerUrl)
      await conn.ready
      await conn.send('Page.enable')
      await requireFocus(conn)
      for (let i = 0; i < 80; i++) {
        await sleep(250)
        const setup = await conn.ev(SETUP).catch(() => '')
        if (setup !== 'ok') continue
        const booting = await conn.ev('window.__vt.ui().booting').catch(() => true)
        if (booting === false) return conn
      }
      conn.ws.close()
      throw new Error('booting timeout')
    } catch (e) {
      lastErr = String(e?.message ?? e)
      await sleep(400)
    }
  }
  throw new Error('attach failed: ' + lastErr)
}

// ─── 外部动作（截图 / 原生对话框 / 剪贴板）──────────────────────────────────
function ps(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }
  )
}

function desktopShot(file) {
  const p = file.replace(/'/g, "''")
  ps(
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
      `$bmp.Save('${p}',[System.Drawing.Imaging.ImageFormat]::Png); ` +
      '$g.Dispose(); $bmp.Dispose()'
  )
}

async function pageShot(conn, file) {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
}

function clickDialog(name) {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, '_click-dialog.ps1'),
      '-Name',
      name,
      '-TimeoutSeconds',
      '12'
    ],
    { encoding: 'utf8' }
  )
  return out.trim()
}

function setClipboard(text) {
  ps(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`)
}

async function waitLog(substr, from = 0, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const log = fsRead(MAIN_LOG)
    const i = log.indexOf(substr, from)
    if (i >= 0) return { at: i, log }
    await sleep(200)
  }
  return null
}

// ─── 页面级动作 ─────────────────────────────────────────────────────────────
async function state(conn) {
  return conn.ev('window.luminAPI.freeze.state()')
}
async function currentContent(conn) {
  return conn.ev('window.__vt.files().current?.content ?? ""')
}
async function setEditorContent(conn, md) {
  return conn.ev(
    `(() => {
      const ed = window.__vt.ed()
      if (!ed) return 'no-editor'
      ed.commands.setContent(${JSON.stringify(md)})
      return 'ok'
    })()`
  )
}
async function waitDraft(conn, marker, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await conn
      .ev(
        `(async () => {
          const f = window.__vt.files()
          const d = await window.luminAPI.drafts.load(f.draftKey(f.current.path))
          return d?.content ?? ''
        })()`
      )
      .catch(() => '')
    if (v.includes(marker)) return v
    await sleep(250)
  }
  return ''
}
async function restoreDraftIfAny(conn) {
  const has = await conn.ev(`!!document.querySelector('.draft-modal')`).catch(() => false)
  if (!has) return { restored: false, content: await currentContent(conn) }
  await conn.ev(`(() => {
    const btns = Array.from(document.querySelectorAll('.draft-modal button'))
    const b = btns.find((x) => (x.textContent || '').includes('恢复'))
    if (b) b.click()
    return !!b
  })()`)
  await sleep(700)
  return { restored: true, content: await currentContent(conn) }
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('electron.exe not found: ' + ELECTRON)
  killInstance()
  const child = launch()
  const cleanup = () => {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
    killInstance()
  }
  process.on('exit', cleanup)

  try {
    let conn = await attach(40000)
    await sleep(1600)
    data.boot = await state(conn)
    c(
      'boot-heartbeat-online',
      data.boot.heartbeats >= 2 && data.boot.lastRafFramesIn500ms > 5,
      `heartbeats=${data.boot.heartbeats} raf500=${data.boot.lastRafFramesIn500ms}`
    )

    // ── 夹具 A：正常文档 ──
    const docA = path.join(FIX, 'freeze-doc-a.md')
    fs.writeFileSync(docA, '# Freeze fixture A\n\nbase content\n', 'utf8')
    await conn.ev(`window.__vt.files().openPath(${JSON.stringify(docA)})`)
    await sleep(900)
    const opened = await conn.ev(
      `JSON.stringify({ path: window.__vt.files().current?.path ?? null, mode: window.__vt.ui().editorMode })`
    )
    data.openA = JSON.parse(opened)
    c('open-fixture-a', data.openA.path === docA, JSON.stringify(data.openA))

    const mdA = [
      `# FREEZE-A-${STAMP}`,
      '',
      '这一段是在冻结测试之前写入的正文，用来验证重新加载后草稿仍在。',
      '',
      '- alpha',
      '- beta',
      '',
      '```js',
      'const freeze = true',
      '```'
    ].join('\n')
    await setEditorContent(conn, mdA)
    await sleep(1200)
    const beforeFreeze = await currentContent(conn)
    const draftA = await waitDraft(conn, `FREEZE-A-${STAMP}`)
    c(
      'draft-saved-before-freeze',
      beforeFreeze.includes(`FREEZE-A-${STAMP}`) && draftA.includes(`FREEZE-A-${STAMP}`),
      `content=${beforeFreeze.length}c draft=${draftA.length}c`
    )

    // ── B. 哨兵：3s 阻塞 ──
    const t3 = Date.now()
    const p3 = conn.send('Runtime.evaluate', {
      expression: '(()=>{const t=Date.now();while(Date.now()-t<3000){}})()'
    })
    await sleep(3600)
    await p3
    await sleep(900)
    const freezes = await conn.ev('JSON.stringify(window.__LWORK?.freezes ?? [])')
    data.freezes = JSON.parse(freezes)
    const lastFreeze = data.freezes[data.freezes.length - 1] ?? null
    c(
      'sentinel-records-freeze',
      !!lastFreeze && lastFreeze.durationMs >= 2500 && typeof lastFreeze.stackHint === 'string',
      JSON.stringify(lastFreeze)
    )
    const freezeNotice = await conn.ev(
      `Array.from(document.querySelectorAll('.ntf-title, .ntf-body, .ntf-card')).some((e) => (e.textContent || '').includes('长时间阻塞'))`
    )
    c('sentinel-visible-notice', freezeNotice === true, `3s block took ${Date.now() - t3}ms`)
    await pageShot(conn, path.join(OUT, 'freeze-sentinel.png'))

    // ── C1. 粘贴护栏提示 +「改用纯文本粘贴」 ──
    const deepHtml = Array.from({ length: 230 }).reduce((a) => `<div>${a}</div>`, 'DEEP-PASTE')
    await conn.ev(`(() => {
      const dt = new DataTransfer()
      dt.setData('text/html', ${JSON.stringify(deepHtml)})
      dt.setData('text/plain', 'GUARD-PLAIN-${STAMP}')
      const pm = document.querySelector('.ProseMirror')
      pm.focus()
      pm.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
      return 'ok'
    })()`)
    await sleep(900)
    const afterGuard = await currentContent(conn)
    const guardAction = await conn.ev(
      `JSON.stringify(Array.from(document.querySelectorAll('.ntf-action')).map((b) => (b.textContent || '').trim()))`
    )
    data.guardActions = JSON.parse(guardAction)
    c(
      'guard-offers-plain-paste',
      afterGuard.includes(`GUARD-PLAIN-${STAMP}`) &&
        data.guardActions.some((x) => x.includes('纯文本')),
      JSON.stringify(data.guardActions)
    )
    const clip = `CLIPBOARD-PLAIN-${STAMP}`
    setClipboard(clip)
    await conn.ev(`(() => {
      const b = Array.from(document.querySelectorAll('.ntf-action')).find((x) => (x.textContent || '').includes('纯文本'))
      if (b) b.click()
      return !!b
    })()`)
    await sleep(900)
    const afterPlain = await currentContent(conn)
    c('plain-paste-button-works', afterPlain.includes(clip), `len=${afterPlain.length}`)
    data.plainPaste = { clipboard: clip, inserted: afterPlain.includes(clip) }

    // 右键菜单项存在 + 截图
    const pmRect = await conn.ev(`(() => {
      const r = document.querySelector('.ProseMirror').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 120) })
    })()`)
    const pt = JSON.parse(pmRect)
    await conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pt.x,
      y: pt.y,
      button: 'right',
      buttons: 2,
      clickCount: 1
    })
    await conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pt.x,
      y: pt.y,
      button: 'right',
      buttons: 0,
      clickCount: 1
    })
    await sleep(500)
    const menuTexts = await conn.ev(
      `JSON.stringify(Array.from(document.querySelectorAll('.ecm-panel .ecm-tool, .ecm-panel .ecm-item')).map((b) => (b.textContent || '').trim()))`
    )
    data.menuTexts = JSON.parse(menuTexts)
    c(
      'context-menu-has-paste-plain',
      data.menuTexts.some((x) => x.includes('粘贴为纯文本')),
      JSON.stringify(data.menuTexts.slice(0, 8))
    )
    await pageShot(conn, path.join(OUT, 'paste-plain-menu.png'))
    await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await sleep(300)

    // ── A1. 模拟卡死 → 等待 ──
    await setEditorContent(conn, mdA)
    await sleep(1200)
    const beforeWait = await currentContent(conn)
    const logMark1 = fsRead(MAIN_LOG).length
    const tInject1 = Date.now()
    const p8a = conn.send('Runtime.evaluate', {
      expression: '(()=>{const t=Date.now();while(Date.now()-t<8000){}})()'
    })
    const prompt1 = await waitLog('prompt unresponsive', logMark1, 9000)
    const detectAt1 = Date.now()
    c('unresponsive-prompt-within-5s', !!prompt1, `prompt at ${detectAt1 - tInject1}ms`)
    await sleep(350)
    desktopShot(path.join(OUT, 'freeze-unresponsive.png'))
    const clickWait = clickDialog('等待')
    data.waitClick = clickWait
    await p8a
    const recoveredAt1 = Date.now()
    let st1 = null
    for (let i = 0; i < 30; i++) {
      st1 = await state(conn)
      if (st1 && st1.episodeOpen === false && st1.lastHeartbeatAgeMs < 1500) break
      await sleep(200)
    }
    data.freezeWait = {
      detectLatencyMs: st1?.lastDetectLatencyMs,
      promptAfterInjectMs: detectAt1 - tInject1,
      recoveredAfterInjectMs: recoveredAt1 - tInject1,
      recoveryMs: st1?.lastRecoveryMs,
      userWaited: st1?.userWaited,
      userReloads: st1?.userReloads
    }
    const contentAfterWait = await currentContent(conn)
    c(
      'freeze-wait-recovers',
      !!st1 && st1.userWaited >= 1 && st1.userReloads === 0 && contentAfterWait === beforeWait,
      JSON.stringify(data.freezeWait)
    )

    // ── A2. 模拟卡死 → 重新加载并恢复 ──
    const mdReload = mdA + `\n\nRELOAD-DRAFT-${STAMP}\n`
    await setEditorContent(conn, mdReload)
    await sleep(1500)
    const beforeReload = await currentContent(conn)
    const logMark2 = fsRead(MAIN_LOG).length
    const p8b = conn.send('Runtime.evaluate', {
      expression: '(()=>{const t=Date.now();while(Date.now()-t<8000){}})()'
    })
    const prompt2 = await waitLog('prompt unresponsive', logMark2, 9000)
    c('second-unresponsive-prompt', !!prompt2, `at ${Date.now() - tInject1}ms`)
    await sleep(300)
    const clickReload = clickDialog('重新加载并恢复')
    data.reloadClick = clickReload
    await p8b.catch(() => {})
    try {
      conn.ws.close()
    } catch {}
    // 重载后重新 attach
    conn = await attach(40000)
    const reloadState = await state(conn)
    data.freezeReload = reloadState
    const draftModal = await conn.ev(`!!document.querySelector('.draft-modal')`).catch(() => false)
    const restored = await restoreDraftIfAny(conn)
    const afterReload = restored.content || (await currentContent(conn))
    c(
      'unresponsive-reload-keeps-content',
      afterReload.includes(`RELOAD-DRAFT-${STAMP}`) && draftModal === true,
      `draftModal=${draftModal} len=${afterReload.length} reloads=${JSON.stringify(reloadState.reloads)}`
    )
    c(
      'reload-recorded',
      reloadState.reloads.some((r) => r.trigger === 'unresponsive') &&
        reloadState.userReloads >= 1,
      JSON.stringify(reloadState.reloads)
    )
    const modeAfterReload = await conn.ev('window.__vt.ui().editorMode')
    const safeNotice = await conn.ev(
      `Array.from(document.querySelectorAll('.ntf-card, .ntf-title')).some((e) => (e.textContent || '').includes('源码模式'))`
    )
    data.safeModeAfter2Incidents = { mode: modeAfterReload, notice: safeNotice }
    c(
      'two-incidents-default-source-mode',
      modeAfterReload === 'source' && safeNotice === true,
      JSON.stringify(data.safeModeAfter2Incidents)
    )

    // ── A3. 崩溃 → 自动重载一次 ──
    await conn.ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(800)
    const mdCrash = `# CRASH-${STAMP}\n\n崩溃前的未保存正文，必须从草稿恢复。\n`
    await setEditorContent(conn, mdCrash)
    await sleep(1500)
    const beforeCrash = await currentContent(conn)
    const logMark3 = fsRead(MAIN_LOG).length
    const tCrash1 = Date.now()
    conn.send('Page.crash').catch(() => {})
    const gone1 = await waitLog('render process gone', logMark3, 8000)
    c('crash-detected', !!gone1, `after ${Date.now() - tCrash1}ms`)
    const reloadLog1 = await waitLog('reload window=', logMark3, 10000)
    c(
      'crash-auto-reload',
      !!reloadLog1 && !reloadLog1.log.slice(logMark3).includes('throttled'),
      reloadLog1 ? 'reload logged' : 'no reload'
    )
    try {
      conn.ws.close()
    } catch {}
    await sleep(1200)
    conn = await attach(40000)
    const stCrash1 = await state(conn)
    const restoredCrash = await restoreDraftIfAny(conn)
    const afterCrash = restoredCrash.content || (await currentContent(conn))
    data.crashFirst = {
      crashes: stCrash1.crashes,
      reloads: stCrash1.reloads,
      autoReloadThrottled: stCrash1.autoReloadThrottled,
      contentOk: afterCrash.includes(`CRASH-${STAMP}`)
    }
    c(
      'crash-auto-reload-recovers-draft',
      stCrash1.crashes >= 1 &&
        stCrash1.reloads.some((r) => r.trigger === 'crash') &&
        afterCrash.includes(`CRASH-${STAMP}`),
      JSON.stringify(data.crashFirst)
    )

    // ── A4. 第二次崩溃（30s 内）→ 节流，必须用户点 ──
    await conn.ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(800)
    await setEditorContent(conn, `# CRASH2-${STAMP}\n\n第二次崩溃前的正文。\n`)
    await sleep(1200)
    const logMark4 = fsRead(MAIN_LOG).length
    conn.send('Page.crash').catch(() => {})
    const throttled = await waitLog('crash auto-reload throttled', logMark4, 8000)
    await waitLog('prompt', logMark4, 5000)
    c(
      'crash-loop-throttled',
      !!throttled,
      throttled
        ? throttled.log
            .split('\n')
            .find((l) => l.includes('throttled'))
        : 'no throttle log'
    )
    const clickCrashReload = clickDialog('重新加载并恢复')
    data.crashReloadClick = clickCrashReload
    try {
      conn.ws.close()
    } catch {}
    await sleep(1800)
    conn = await attach(40000)
    const stCrash2 = await state(conn)
    const reloadIntervals = stCrash2.reloads.map((r) => r.at)
    data.crashThrottle = {
      autoReloadThrottled: stCrash2.autoReloadThrottled,
      reloads: stCrash2.reloads,
      intervalsMs: reloadIntervals.slice(1).map((t, i) => t - reloadIntervals[i]),
      crashes: stCrash2.crashes
    }
    c(
      'crash-throttle-then-manual-reload',
      stCrash2.autoReloadThrottled >= 1 && stCrash2.reloads.length >= 2,
      JSON.stringify(data.crashThrottle)
    )
    await restoreDraftIfAny(conn)

    // ── C2. 大文档 → 以源码模式打开 ──
    const docBig = path.join(FIX, 'freeze-doc-big.md')
    const line = '这一行用于把文档撑到 2MB 以上，验证打开前的安全模式提示。'
    const big = []
    for (let i = 0; i < 60000; i++) big.push(line)
    fs.writeFileSync(docBig, big.join('\n'), 'utf8')
    data.bigBytes = fs.statSync(docBig).size
    // 注意：openPath 会**等用户回答**三选一，所以这里不能 await（否则 CDP 调用永远不返回，
    // 轮询 DOM 的那段根本跑不到）。先发出去，等提示出现并点完再收它的结果。
    const bigOpen = conn.send('Runtime.evaluate', {
      expression: `window.__vt.files().openPath(${JSON.stringify(docBig)})`,
      returnByValue: true,
      awaitPromise: true
    })
    let triple = null
    for (let i = 0; i < 40; i++) {
      triple = await conn
        .ev(`document.querySelector('[data-triple]')?.textContent ?? ''`)
        .catch(() => '')
      if (triple && triple.includes('较大')) break
      await sleep(250)
    }
    c(
      'large-doc-prompts',
      !!triple && triple.includes('较大') && triple.includes('以源码模式打开'),
      `bytes=${data.bigBytes}`
    )
    await pageShot(conn, path.join(OUT, 'large-doc-prompt.png'))
    await conn.ev(`document.querySelector('[data-triple-confirm]')?.click()`)
    await bigOpen.catch(() => {})
    await sleep(1200)
    const bigMode = await conn.ev('window.__vt.ui().editorMode')
    data.bigDoc = { bytes: data.bigBytes, mode: bigMode }
    c('large-doc-opens-source', bigMode === 'source', JSON.stringify(data.bigDoc))

    // ── D. 正常路径：输入延迟 / 长任务 / 滚动 ──
    const docC = path.join(FIX, 'freeze-doc-c.md')
    fs.writeFileSync(
      docC,
      ['# Normal path', '', ...Array.from({ length: 80 }, (_, i) => `第 ${i} 段正常正文，用于输入延迟测量。`)].join('\n'),
      'utf8'
    )
    await conn.ev(`window.__vt.files().openPath(${JSON.stringify(docC)})`)
    await sleep(900)
    await conn.ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(800)
    await conn.ev(`(() => { const ed = window.__vt.ed(); ed.commands.focus('end'); return 'ok' })()`)
    const longBefore = (await state(conn)).lastWork?.longTasks ?? 0
    const lat = []
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now()
      await conn.send('Input.insertText', { text: 'x' })
      await conn.ev('new Promise((r) => requestAnimationFrame(() => r(1)))')
      lat.push(Date.now() - t0)
    }
    const sort = (a) => [...a].sort((x, y) => x - y)
    const pct = (a, p) => sort(a)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]
    const longAfter = (await state(conn)).lastWork?.longTasks ?? 0
    const scroll = []
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now()
      await conn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 640,
        y: 480,
        deltaX: 0,
        deltaY: 120
      })
      await conn.ev('new Promise((r) => requestAnimationFrame(() => r(1)))')
      scroll.push(Date.now() - t0)
    }
    data.latency = {
      inputP50: pct(lat, 50),
      inputP95: pct(lat, 95),
      inputMax: Math.max(...lat),
      scrollAvg: Math.round(scroll.reduce((a, b) => a + b, 0) / scroll.length),
      longTasksDelta: longAfter - longBefore,
      samples: lat
    }
    c(
      'normal-input-latency',
      data.latency.inputP95 < 120 && data.latency.scrollAvg < 60,
      JSON.stringify({ ...data.latency, samples: undefined })
    )

    // ── 汇总 ──
    data.results = results
    const pass = results.filter((r) => r.startsWith('PASS')).length
    fs.writeFileSync(path.join(OUT, 'freeze-report.json'), JSON.stringify(data, null, 2))
    console.log(`--- ${pass}/${results.length} PASS`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    cleanup()
    clearInterval(keepalive)
  }
}

main().catch((e) => {
  clearInterval(keepalive)
  console.error('FATAL', e)
  try {
    fs.writeFileSync(
      path.join(OUT, 'freeze-report.json'),
      JSON.stringify({ ...data, results, error: String(e) }, null, 2)
    )
  } catch {}
  process.exitCode = 1
})
