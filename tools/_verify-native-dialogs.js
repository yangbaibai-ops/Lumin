// 验收（本轮追加）：关窗未保存 / 外部修改 → **主进程原生**确认框。
//
// 用户口径：这两条确认必须是 `dialog.showMessageBox(win, …)`（原生 MessageBox 风格、
// 父窗口绑定），**不再**是渲染层自绘的 `.lm-prompt`。内部通知卡片（灰条）不在此列。
//
// 证据（本脚本产出）：
//   * 主进程日志 `[dialog] show close-unsaved native` / `[dialog] show external-change native`
//     与 `[dialog] native … response=N choice=…`；
//   * 原生窗口类名 `#32770`（tools/_click-dialog.ps1 的 Win32 通道会打印）；
//   * 截图 `tmp/native-close-dialog.png`、`tmp/native-external-dialog.png`；
//   * 同一时刻 DOM 里没有 `[data-top-prompt]`（自绘模态的语义锚点）。
//
// 跑法：`node tools/_verify-native-dialogs.js`（自带隔离实例，端口 9487）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, execFileSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'tmp')
const PORT = 9487
const UD = path.join(os.tmpdir(), 'xw-native-dlg-ud')
const FIX = path.join(os.tmpdir(), 'xw-native-dlg-fixtures')
const MAIN_LOG = path.join(OUT, 'native-dialogs-main.log')
const ERR_LOG = path.join(OUT, 'native-dialogs-err.log')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const STAMP = Date.now().toString(36).toUpperCase()

// 保活：CDP 的 WebSocket 在 Node 里不总是被算作活跃 handle；没有它，
// 一旦某个 await 消息没回来，进程会"静默退出 0"，套件看起来像没跑。
const keepalive = setInterval(() => {}, 1000)
const results = []
const data = { stamp: STAMP, port: PORT, userData: UD }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fsRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
function c(name, cond, extra) {
  results.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
}

function killInstance() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*xw-native-dlg-ud*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'ignore'
  })
}

let currentChild = null
function launch() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(FIX, { recursive: true })
  killInstance()
  if (fs.existsSync(UD)) spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', UD], { stdio: 'ignore' })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.LUMIN_DEBUG_PORT = String(PORT)
  env.LUMIN_TRUSTED_PATHS = os.tmpdir()
  fs.writeFileSync(MAIN_LOG, '')
  const out = fs.openSync(MAIN_LOG, 'a')
  const err = fs.openSync(ERR_LOG, 'a')
  currentChild = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${UD}`, '--disable-features=CalculateNativeWinOcclusion'],
    { cwd: ROOT, env, stdio: ['ignore', out, err] }
  )
}
function stopChild() {
  if (!currentChild) return
  try {
    spawnSync('taskkill', ['/PID', String(currentChild.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  killInstance()
  currentChild = null
}

// CDP
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
    if (r.result?.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
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
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`
async function attach(maxMs = 30000) {
  const deadline = Date.now() + maxMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const pages = (await getJson('/json/list')).filter(
        (t) => t.type === 'page' && /index\.html/.test(t.url)
      )
      if (!pages.length) throw new Error('no page')
      const conn = connect(pages[0].webSocketDebuggerUrl)
      await conn.ready
      await conn.send('Page.enable')
      await conn.send('Page.bringToFront')
      for (let i = 0; i < 80; i++) {
        await sleep(250)
        if ((await conn.ev(SETUP).catch(() => '')) !== 'ok') continue
        if ((await conn.ev('window.__vt.ui().booting').catch(() => true)) === false) return conn
      }
      conn.ws.close()
      throw new Error('boot timeout')
    } catch (e) {
      last = String(e?.message ?? e)
      await sleep(400)
    }
  }
  throw new Error('attach failed: ' + last)
}
async function pageAlive() {
  try {
    const pages = (await getJson('/json/list')).filter((t) => t.type === 'page')
    return pages.length > 0
  } catch {
    return false
  }
}
async function waitPageGone(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await pageAlive())) return true
    await sleep(300)
  }
  return false
}

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
function pageShot(conn, file) {
  return conn
    .send('Page.captureScreenshot', { format: 'png' })
    .then((r) => fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')))
}
function clickDialog(name) {
  return execFileSync(
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
  ).trim()
}
function waitLog(substr, from = 0, timeoutMs = 15000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const log = fsRead(MAIN_LOG)
      const i = log.indexOf(substr, from)
      if (i >= 0) return { at: i, log }
      await sleep(200)
    }
    return null
  })()
}

async function openFixture(conn, file, body) {
  fs.writeFileSync(file, body, 'utf8')
  await conn.ev(`window.__vt.files().openPath(${JSON.stringify(file)})`)
  await sleep(900)
  return conn.ev('window.__vt.files().current?.path ?? null')
}
async function setContent(conn, md) {
  return conn.ev(`(() => { const ed = window.__vt.ed(); if (!ed) return 'no-ed'; ed.commands.setContent(${JSON.stringify(md)}); return 'ok' })()`)
}
async function content(conn) {
  return conn.ev('window.__vt.files().current?.content ?? ""')
}
async function customModalCount(conn) {
  return conn.ev(
    `document.querySelectorAll('[data-top-prompt], .lm-prompt, .draft-modal').length`
  )
}

async function closeCase(button, mutateDisk) {
  launch()
  const conn = await attach(40000)
  const file = path.join(FIX, `close-${button}.md`)
  const base = `# base ${button}\n\ndisk body\n`
  await openFixture(conn, file, base)
  const marker = `UNSAVED-${button}-${STAMP}`
  await setContent(conn, `# ${marker}\n\n未保存正文 ${button}\n`)
  await sleep(1400)
  const appBefore = await content(conn)
  const diskBefore = fsRead(file)
  const customBefore = await customModalCount(conn)
  const logMark = fsRead(MAIN_LOG).length
  // 走应用自己的关窗 IPC（`app:close` → 主进程 `win.close()` → 关窗守卫）。
  // 不用 `window.close()`：Chromium 对脚本发起的 close 在 Electron 里可能绕过
  // BrowserWindow 的 close 守卫（实测：窗口直接没了、`before-close` 没发）。
  await conn.ev('window.luminAPI.app.close()').catch(() => {})
  const shown = await waitLog('[dialog] show close-unsaved native', logMark, 12000)
  await sleep(300)
  const customDuring = await customModalCount(conn).catch(() => -1)
  if (shown) desktopShot(path.join(OUT, `native-close-${button}.png`))
  const click = clickDialog(button)
  await sleep(1200)
  const alive = await pageAlive()
  const diskAfter = fsRead(file)
  const info = {
    button,
    shown: !!shown,
    customBefore,
    customDuring,
    click,
    alive,
    appBefore: appBefore.slice(0, 60),
    diskBefore: diskBefore.slice(0, 60),
    diskAfter: diskAfter.slice(0, 60)
  }
  if (mutateDisk) mutateDisk(info)
  stopChild()
  return info
}

async function externalCase() {
  launch()
  const conn = await attach(40000)
  const file = path.join(FIX, 'external-change.md')
  const base = '# external base\n\ndisk original\n'
  await openFixture(conn, file, base)
  const appMarker = `APP-VERSION-${STAMP}`
  await setContent(conn, `# ${appMarker}\n\n应用内版本\n`)
  await sleep(1400)
  const appBefore = await content(conn)
  let logMark = fsRead(MAIN_LOG).length
  // 外部应用写入第一版
  const ext1 = `# EXT-ONE-${STAMP}\n\n外部版本一\n`
  fs.writeFileSync(file, ext1, 'utf8')
  const shown1 = await waitLog('[dialog] show external-change native', logMark, 12000)
  await sleep(300)
  const custom1 = await customModalCount(conn).catch(() => -1)
  if (shown1) desktopShot(path.join(OUT, 'native-external-dialog.png'))
  const clickLater = clickDialog('暂不')
  await sleep(900)
  const afterLater = await content(conn)
  // 外部再写一版（mtime/size 都变）
  await sleep(1100)
  logMark = fsRead(MAIN_LOG).length
  const ext2 = `# EXT-TWO-${STAMP}\n\n外部版本二，应该被重新加载进来。\n`
  fs.writeFileSync(file, ext2, 'utf8')
  const shown2 = await waitLog('[dialog] show external-change native', logMark, 12000)
  await sleep(300)
  const clickReload = clickDialog('重新加载')
  await sleep(1400)
  const afterReload = await content(conn)
  // 灰色通知卡（内部提示）仍然可用
  await conn.ev(`window.__vt.ui().toast('TOAST-STILL-WORKS-${STAMP}')`)
  await sleep(700)
  const toastText = await conn.ev(
    `Array.from(document.querySelectorAll('.ntf-card, .ntf-title')).map((e) => e.textContent || '').join('|')`
  )
  await pageShot(conn, path.join(OUT, 'native-toast.png'))
  const info = {
    shown1: !!shown1,
    shown2: !!shown2,
    custom1,
    clickLater,
    clickReload,
    appBeforeLen: appBefore.length,
    afterLaterHasApp: afterLater.includes(appMarker),
    afterReloadHasExt2: afterReload.includes(`EXT-TWO-${STAMP}`),
    toastStillWorks: toastText.includes(`TOAST-STILL-WORKS-${STAMP}`),
    afterLater: afterLater.slice(0, 80),
    afterReload: afterReload.slice(0, 80)
  }
  stopChild()
  return info
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('electron.exe not found')
  killInstance()
  try {
    // ① 取消：窗口不能关、内容不能变
    const cancel = await closeCase('取消')
    c(
      'close-cancel-native-and-keeps-window',
      cancel.shown && cancel.customDuring === 0 && cancel.alive && cancel.diskAfter === cancel.diskBefore,
      JSON.stringify({ shown: cancel.shown, custom: cancel.customDuring, alive: cancel.alive, click: cancel.click })
    )
    data.closeCancel = cancel

    // ② 保存：磁盘更新、窗口关闭
    const save = await closeCase('保存')
    c(
      'close-save-native-writes-and-closes',
      save.shown && save.customDuring === 0 && !save.alive && save.diskAfter.includes('UNSAVED-保存'),
      JSON.stringify({ shown: save.shown, custom: save.customDuring, alive: save.alive, disk: save.diskAfter.slice(0, 40) })
    )
    data.closeSave = save

    // ③ 不保存：磁盘不变、窗口关闭
    const discard = await closeCase('不保存')
    c(
      'close-discard-native-keeps-disk-and-closes',
      discard.shown &&
        discard.customDuring === 0 &&
        !discard.alive &&
        discard.diskAfter === discard.diskBefore,
      JSON.stringify({ shown: discard.shown, custom: discard.customDuring, alive: discard.alive })
    )
    data.closeDiscard = discard

    // ④ 外部修改：稍后保留应用内版本；重新加载采用磁盘版本
    const ext = await externalCase()
    c(
      'external-change-native-dialog',
      ext.shown1 && ext.shown2 && ext.custom1 === 0 && ext.clickLater.includes('CLICKED') && ext.clickReload.includes('CLICKED'),
      JSON.stringify({ shown1: ext.shown1, shown2: ext.shown2, custom: ext.custom1 })
    )
    c('external-later-keeps-app-content', ext.afterLaterHasApp, ext.afterLater)
    c('external-reload-uses-disk-content', ext.afterReloadHasExt2, ext.afterReload)
    c('toast-still-works', ext.toastStillWorks, String(ext.toastStillWorks))
    data.external = ext

    data.log = fsRead(MAIN_LOG)
      .split('\n')
      .filter((l) => l.includes('[dialog]'))
    data.results = results
    const pass = results.filter((r) => r.startsWith('PASS')).length
    fs.writeFileSync(path.join(OUT, 'native-dialogs-report.json'), JSON.stringify(data, null, 2))
    console.log(`--- ${pass}/${results.length} PASS`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    stopChild()
    clearInterval(keepalive)
  }
}

main().catch((e) => {
  clearInterval(keepalive)
  console.error('FATAL', e)
  try {
    fs.writeFileSync(
      path.join(OUT, 'native-dialogs-report.json'),
      JSON.stringify({ ...data, results, error: String(e) }, null, 2)
    )
  } catch {}
  process.exitCode = 1
})
