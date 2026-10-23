'use strict'
// 验收：一次性「感谢 / 支持」提示（原生框、只弹一次、帮助菜单重开、两个按钮）。
//
// 用户口径：首次启动后（首屏可交互 ~1.5s）弹一次**原生**提示（Win32 `#32770`），
// 关掉后不再自动弹；帮助菜单里可以随时重新调出来；「去点个 Star」打开项目仓库。
//
// 证据（本脚本产出）：
//   * `tmp/support-zh.png` / `tmp/support-en.png` / `tmp/support-help.png`（桌面截图，含原生框）；
//   * 主进程日志 `[dialog] show support native` / `[dialog] native support response=…`
//     / `[shell] openExternal …` / `[support] promptShown=…`；
//   * `supportPromptShown` 的真实值 + 同一 profile 再启动两次都不弹；
//   * 首屏可交互耗时（与改动前 `tmp/boot-base.json` 对比）。
//
// 跑法：先 `npm run build`，再 `node tools/_verify-support-prompt.js`。
// 端口 9552；userData = `%TEMP%\xw-support-ud`（不含 `lumin`，避免碰到真实配置）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, spawnSync, execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'tmp')
const PORT = 9552
const UD = path.join(os.tmpdir(), 'xw-support-ud')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN_LOG = path.join(OUT, 'support-main.log')
const ERR_LOG = path.join(OUT, 'support-main.err.log')
const INFO_JSON = path.join(OUT, '.support-dialog.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const keepalive = setInterval(() => {}, 1000)
const results = []
const data = { port: PORT, userData: UD, results }

/**
 * 前置守卫（`tests/tooling.test.mjs` 要求注入按键的套件必须能安全跳过）：
 * 没有可用的 Electron / 端口被别的实例占着时，**明确打 SKIP 并退出 0**，
 * 而不是在别人机器上留下一个"看起来失败了"的半截实例。
 */
function preconditionSkip(reason) {
  console.log(`SKIP: ${reason}`)
  clearInterval(keepalive)
  process.exit(0)
}

function c(name, cond, extra) {
  results.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
}
const fsRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function killInstance() {
  // 匹配的是**验收脚本自己的**两套隔离 profile（`xw-support-ud` / `xw-support-*` 探针）。
  // 上一版只匹配 `*xw-support-ud*`，于是更早手工起的 `xw-support-starprobe-ud` 一直活着、
  // 占着 9552 端口 —— CDP 连到的是旧实例，新实例的 IPC 永远看不到（本轮踩过的坑）。
  const ps =
    'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | ' +
    "Where-Object { $_.CommandLine -like '*xw-support*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ' +
    'Start-Sleep -Milliseconds 600'
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'ignore'
  })
}

/** 端口被上一个实例占着时，CDP 会连到旧页面 —— 必须等它真的空出来 */
function portIsFree() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `if (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue) { 'busy' } else { 'free' }`
    ],
    { encoding: 'utf8' }
  )
  return String(r.stdout || '').trim() === 'free'
}

/** 删掉隔离 profile；Windows 上刚被杀掉的进程可能还握着文件句柄，重试几次。 */
function wipeProfile() {
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(UD, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* 继续重试 */
    }
    if (!fs.existsSync(UD)) return
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250'], {
      stdio: 'ignore'
    })
  }
  throw new Error('cannot wipe profile: ' + UD)
}

let child = null
function launch({ fresh = false, extraEnv = {} } = {}) {
  fs.mkdirSync(OUT, { recursive: true })
  killInstance()
  if (fresh) wipeProfile()
  for (let i = 0; i < 20 && !portIsFree(); i++) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250'], {
      stdio: 'ignore'
    })
  }
  if (!portIsFree()) preconditionSkip(`CDP port ${PORT} is held by another instance`)
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.LUMIN_DEBUG_PORT = String(PORT)
  env.LUMIN_TRUSTED_PATHS = os.tmpdir()
  fs.writeFileSync(MAIN_LOG, '')
  const out = fs.openSync(MAIN_LOG, 'a')
  const err = fs.openSync(ERR_LOG, 'a')
  child = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${UD}`, '--disable-features=CalculateNativeWinOcclusion'],
    { cwd: ROOT, env, stdio: ['ignore', out, err] }
  )
  return child
}
function stopChild() {
  if (!child) return
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  killInstance()
  child = null
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], {
    stdio: 'ignore'
  })
}

// ── CDP ────────────────────────────────────────────────────────────────────
function getJson(p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''
      r.on('data', (x) => (d += x))
      r.on('end', () => {
        try {
          res(JSON.parse(d))
        } catch (e) {
          rej(e)
        }
      })
    })
    req.on('error', rej)
    req.setTimeout(1500, () => req.destroy(new Error('cdp-timeout')))
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
    settings: () => pinia._s.get('settings'),
    ui: () => pinia._s.get('ui'),
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`

/** 把本实例的主窗口拉到前台：自动提示要求 `document.hasFocus()`，Windows 的前台锁会挡 CDP 的 bringToFront */
function focusApp() {
  if (!child) return
  try {
    ps(
      `$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate(${child.pid}); ` +
        "Start-Sleep -Milliseconds 250"
    )
  } catch {}
}

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
      for (let i = 0; i < 160; i++) {
        await sleep(100)
        if ((await conn.ev(SETUP).catch(() => '')) !== 'ok') continue
        if ((await conn.ev('window.__vt.ui().booting').catch(() => true)) === false) {
          focusApp()
          return conn
        }
      }
      conn.ws.close()
      throw new Error('boot timeout')
    } catch (e) {
      last = String(e?.message ?? e)
      await sleep(300)
    }
  }
  throw new Error('attach failed: ' + last)
}

// ── 原生窗口（Win32 #32770）取证 / 截图 ──────────────────────────────────────
function ps(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }
  )
}
function nativeDialogs() {
  try {
    fs.unlinkSync(INFO_JSON)
  } catch {}
  const file = INFO_JSON.replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuminSupportDialog {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public static List<IntPtr> Dialogs() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() == "#32770") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr d) {
    var list = new List<IntPtr>();
    EnumChildWindows(d, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(2048); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(64); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  public static int PidOf(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$list = @()
foreach ($dlg in [LuminSupportDialog]::Dialogs()) {
  $buttons = @()
  foreach ($ch in [LuminSupportDialog]::Children($dlg)) {
    if ([LuminSupportDialog]::ClassOf($ch) -eq 'Button') { $buttons += [LuminSupportDialog]::Text($ch) }
  }
  $list += [pscustomobject]@{ class = '#32770'; pid = [LuminSupportDialog]::PidOf($dlg); title = [LuminSupportDialog]::Text($dlg); buttons = $buttons }
}
[System.IO.File]::WriteAllText('${file}', (ConvertTo-Json -InputObject @($list) -Compress -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
`
  try {
    ps(script)
    const raw = fsRead(INFO_JSON).trim()
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
function findSupportDialog(titleSubstr) {
  const pid = child ? child.pid : null
  return (
    nativeDialogs().find(
      (d) => (d.title || '').includes(titleSubstr) && (pid == null || d.pid === pid)
    ) || null
  )
}
async function waitSupportDialog(titleSubstr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const d = findSupportDialog(titleSubstr)
    if (d) return d
    await sleep(250)
  }
  return null
}
const SUPPORT_TITLE_RE =
  /^一点小小的说明$|^A small note from the author$|^Небольшая записка от автора$/
async function waitSupportGone(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let seen = []
  while (Date.now() < deadline) {
    const pid = child ? child.pid : null
    seen = nativeDialogs().filter(
      (d) => SUPPORT_TITLE_RE.test(d.title || '') && (pid == null || d.pid === pid)
    )
    if (!seen.length) return { gone: true, seen }
    await sleep(250)
  }
  return { gone: false, seen }
}
function clickDialog(name, titleContains) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, '_support-click.ps1'),
    '-Name',
    name,
    '-TitleContains',
    titleContains,
    '-TimeoutSeconds',
    '12'
  ]
  if (child) args.push('-ProcessId', String(child.pid))
  return execFileSync('powershell.exe', args, { encoding: 'utf8' }).trim()
}
function desktopShot(file) {
  const p = file.replace(/'/g, "''")
  ps(
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
      `$bmp.Save('${p}',[System.Drawing.Imaging.ImageFormat]::Png); ` +
      '$g.Dispose(); $bmp.Dispose()'
  )
}

/** 渲染层截图（应用内下拉菜单这类 DOM 证据用它） */
function pageShot(conn, file) {
  return conn
    .send('Page.captureScreenshot', { format: 'png' })
    .then((r) => fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')))
}

/**
 * 原生框**单独**截图（PrintWindow）。
 *
 * 为什么不用整屏截图：验收机是多显示器，`dialog.showMessageBox` 会出现在系统认为的
 * "当前活动窗口所在屏"，而 `PrimaryScreen` 未必是那一块 —— 第一版截图里根本没有对话框。
 * PrintWindow 直接按窗口句柄渲染，与窗口在哪个屏、有没有被别的窗口压住都无关。
 */
function dialogShot(titleContains, file) {
  const title = titleContains.replace(/'/g, "''")
  const out = file.replace(/'/g, "''")
  const pid = child ? child.pid : 0
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuminSupportShot {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static string Text(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, s.Capacity); return s.ToString(); }
  public static int Pid(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }
  public static IntPtr Find(string title, int wantPid) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || Cls(h) != "#32770") return true;
      if (wantPid != 0 && Pid(h) != wantPid) return true;
      if (Text(h).IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
      hit = h; return false;
    }, IntPtr.Zero);
    return hit;
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$h = [LuminSupportShot]::Find('${title}', ${pid})
if ($h -eq [IntPtr]::Zero) { Write-Host 'NO-DIALOG'; exit 2 }
$r = New-Object LuminSupportShot+RECT
[void][LuminSupportShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { Write-Host 'EMPTY-RECT'; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][LuminSupportShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ("SHOT " + $w + "x" + $hgt)
`
  return ps(script).trim()
}
function waitLog(substr, from = 0, timeoutMs = 15000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const log = fsRead(MAIN_LOG)
      const i = log.indexOf(substr, from)
      if (i >= 0) return { at: i, log }
      await sleep(150)
    }
    return null
  })()
}
function startupValue(stage) {
  const log = fsRead(path.join(UD, 'logs', 'startup.log'))
  let found = null
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.stage === stage) found = e
  }
  return found
}
function flagOnPage(conn) {
  return conn.ev('window.__vt.settings().supportPromptShown')
}
function bodySnippet(text, max = 120) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
}
function saveLog(name) {
  const text = fsRead(MAIN_LOG)
  fs.writeFileSync(path.join(OUT, `support-${name}.log`), text)
  return text
}

async function openHelpSupport(conn, menuShot = null) {
  await conn.ev(`document.querySelector('[data-topmenu-group="h"]')?.click()`)
  await sleep(250)
  if (menuShot) await pageShot(conn, menuShot)
  return conn.ev(`(() => {
    const el = document.querySelector('[data-menu-item="menu.support"]')
    if (!el) return 'no-item'
    el.click()
    return 'clicked'
  })()`)
}

// 在原生框还开着的时候往编辑器里打字：CDP 直接给渲染层派发输入（窗口被原生模态禁用时，
// 这条仍然是"渲染层是否还能处理输入"的可观测判据）。
async function typeWhileDialogOpen(conn, marker) {
  await conn.ev(`document.querySelector('[data-editor-kernel] .ProseMirror')?.focus()`)
  await sleep(100)
  await conn.send('Input.insertText', { text: marker })
  await sleep(400)
  return conn.ev(`window.__vt.files().current?.content ?? ''`)
}

// ── 场景 ────────────────────────────────────────────────────────────────────
async function firstRun() {
  launch({ fresh: true, extraEnv: { LUMIN_OPEN_EXTERNAL_DRY_RUN: '1' } })
  const t0 = Date.now()
  const conn = await attach(40000)
  const interactiveAt = Date.now()
  data.attachMs = interactiveAt - t0
  data.firstInteractiveMs = (startupValue('renderer-first-interactive') || {}).ms ?? null
  data.bootFlag = await flagOnPage(conn)
  c(
    'fresh-profile-flag-false',
    data.bootFlag === false,
    JSON.stringify({ supportPromptShown: data.bootFlag })
  )

  // 首屏可交互后**先**别弹（用户口径 ~1.5s）：300ms 处确认还没有 #32770，
  // 同时用最终测到的延迟做硬判据（枚举本身有几百毫秒开销，不能只看这一瞬）
  await sleep(300)
  const early = findSupportDialog('一点小小的说明')
  c(
    'auto-not-before-delay',
    !early,
    JSON.stringify({ at: Date.now() - interactiveAt, dialog: !!early })
  )

  const zh = await waitSupportDialog('一点小小的说明', 8000)
  data.zhDialog = zh
  data.dialogDelayMs = Date.now() - interactiveAt
  c(
    'auto-dialog-delay-about-1.5s',
    !!zh && data.dialogDelayMs >= 1200 && data.dialogDelayMs <= 4500,
    `delayMs=${data.dialogDelayMs}`
  )
  c(
    'auto-dialog-native-zh',
    !!zh && zh.class === '#32770',
    JSON.stringify({ class: zh?.class, title: zh?.title, pid: zh?.pid })
  )
  c(
    'auto-dialog-zh-buttons',
    !!zh && zh.buttons.includes('知道了') && zh.buttons.includes('去点个 Star'),
    JSON.stringify(zh?.buttons)
  )
  if (zh) {
    dialogShot('一点小小的说明', path.join(OUT, 'support-zh.png'))
    desktopShot(path.join(OUT, 'support-zh.full.png'))
  }

  // 弹窗期间编辑区仍能接收键盘输入（不阻塞）
  const marker = 'SUPPORT-KEY-' + Date.now().toString(36).toUpperCase()
  const contentDuring = await typeWhileDialogOpen(conn, marker)
  data.keyboardDuringDialog = bodySnippet(contentDuring)
  c('editor-responds-while-dialog-open', contentDuring.includes(marker), marker)

  // 关闭：默认按钮「知道了」⇒ 写 supportPromptShown=true
  const logMark = fsRead(MAIN_LOG).length
  const clickZh = clickDialog('知道了', '一点小小的说明')
  data.clickKeep = clickZh
  const logged0 = await waitLog(
    '[dialog] native support response=0 choice=keepWriting manual=false',
    logMark
  )
  data.keepLog = logged0 ? logged0.log.split('\n').filter((l) => l.includes('[dialog]')) : []
  await sleep(800)
  c(
    'keep-button-closes-and-writes-flag',
    !!logged0 && (await flagOnPage(conn)) === true,
    clickZh.split('\n').slice(-1)[0]
  )
  const gone = await waitSupportGone(5000)
  c('auto-dialog-gone-after-close', gone.gone, JSON.stringify(gone.seen))

  // 帮助菜单 → 支持这个项目：重新弹出同一个原生框（不写 flag）
  const help = await openHelpSupport(conn, path.join(OUT, 'support-help-menu.png'))
  c('help-menu-item-found', help === 'clicked', String(help))
  const helpDlg = await waitSupportDialog('一点小小的说明', 8000)
  data.helpDialog = helpDlg
  if (helpDlg) {
    // 帮助入口的证据分两张：`support-help-menu.png` = 应用内「帮助 → 支持这个项目」菜单，
    // `support-help.png` = 同一个原生框再次弹出（与自动那次同框，证明是同一实现）。
    dialogShot('一点小小的说明', path.join(OUT, 'support-help.png'))
  }
  c(
    'help-reopens-native-dialog',
    !!helpDlg && helpDlg.class === '#32770' && helpDlg.buttons.includes('知道了'),
    JSON.stringify({ title: helpDlg?.title, buttons: helpDlg?.buttons })
  )
  const helpClick = clickDialog('知道了', '一点小小的说明')
  await sleep(900)
  c(
    'help-does-not-change-flag',
    (await flagOnPage(conn)) === true && !!helpClick.includes('CLICKED'),
    helpClick.split('\n').slice(-1)[0]
  )

  // 切到英文：同一条帮助入口 ⇒ 英文文案（README 口径：三语都走主进程语言包）
  await conn.ev(`window.__vt.settings().setLanguage('en-US')`)
  await sleep(1200)
  const helpEn = await openHelpSupport(conn)
  const enDlg = await waitSupportDialog('A small note from the author', 8000)
  data.enDialog = enDlg
  if (enDlg) {
    dialogShot('A small note from the author', path.join(OUT, 'support-en.png'))
    desktopShot(path.join(OUT, 'support-en.full.png'))
  }
  c(
    'english-native-dialog',
    helpEn === 'clicked' &&
      !!enDlg &&
      enDlg.buttons.includes('Got it') &&
      enDlg.buttons.includes('Star the project'),
    JSON.stringify({ title: enDlg?.title, buttons: enDlg?.buttons })
  )
  if (enDlg) clickDialog('Got it', 'A small note from the author')
  await sleep(700)

  // 俄语：同样从帮助入口验证（无截图要求，但要证明文案真的切了）
  await conn.ev(`window.__vt.settings().setLanguage('ru-RU')`)
  await sleep(1200)
  const helpRu = await openHelpSupport(conn)
  const ruDlg = await waitSupportDialog('Небольшая записка от автора', 8000)
  data.ruDialog = ruDlg
  if (ruDlg) {
    dialogShot('Небольшая записка от автора', path.join(OUT, 'support-ru.png'))
    desktopShot(path.join(OUT, 'support-ru.full.png'))
  }
  c(
    'russian-native-dialog',
    helpRu === 'clicked' &&
      !!ruDlg &&
      ruDlg.buttons.includes('Понятно') &&
      ruDlg.buttons.includes('Поставить звезду'),
    JSON.stringify({ title: ruDlg?.title, buttons: ruDlg?.buttons })
  )
  if (ruDlg) clickDialog('Понятно', 'Небольшая записка от автора')
  await sleep(700)

  data.flagAfterAll = await flagOnPage(conn)
  c('flag-still-true-after-manual-and-languages', data.flagAfterAll === true)

  data.firstRunLog = saveLog('first-run')
    .split('\n')
    .filter((l) => l.includes('[support]') || l.includes('[dialog]'))
  conn.ws.close()
  stopChild()
}

async function starRun() {
  // 全新 profile：自动框上点「去点个 Star」⇒ 打开仓库 + 写 flag
  launch({ fresh: true, extraEnv: { LUMIN_OPEN_EXTERNAL_DRY_RUN: '1' } })
  const conn = await attach(40000)
  const dlg = await waitSupportDialog('一点小小的说明', 9000)
  c('star-run-dialog-shown', !!dlg, JSON.stringify({ title: dlg?.title }))
  const starLogMark = fsRead(MAIN_LOG).length
  const click = clickDialog('去点个 Star', '一点小小的说明')
  data.starClick = click
  const starLog = await waitLog('[shell] openExternal', starLogMark, 8000)
  data.starLog = starLog
    ? starLog.log
        .split('\n')
        .filter((l) => l.includes('[shell]'))
        .slice(-3)
    : []
  if (!starLog) data.starDialogsAfterClick = nativeDialogs()
  const expect = 'https://github.com/yangbaibai-ops/Lumin'
  c(
    'star-opens-repo',
    !!starLog && starLog.log.includes(encodeURI(expect)),
    JSON.stringify(data.starLog)
  )
  await sleep(900)
  c('star-writes-flag', (await flagOnPage(conn)) === true)
  data.starRunLog = saveLog('star-run')
    .split('\n')
    .filter((l) => l.includes('[support]') || l.includes('[dialog]') || l.includes('[shell]'))
  conn.ws.close()
  stopChild()
}

async function restartTwiceNoPrompt() {
  // 同一个 profile 再启动两次：不再自动弹（读的是持久化 flag，不是"每次启动都弹"的兜底）
  const runs = []
  for (let i = 1; i <= 2; i++) {
    launch()
    const conn = await attach(30000)
    await sleep(3600)
    const d = nativeDialogs().filter(
      (x) => SUPPORT_TITLE_RE.test(x.title || '') && x.pid === (child ? child.pid : x.pid)
    )
    const startupLog = fsRead(MAIN_LOG)
      .split('\n')
      .filter((l) => l.includes('[support] promptShown='))
    runs.push({
      i,
      dialogs: d.length,
      dialogTitles: d.map((x) => x.title),
      flag: await flagOnPage(conn),
      startupLog: startupLog.slice(0, 3)
    })
    saveLog(`restart-${i}`)
    conn.ws.close()
    stopChild()
    await sleep(700)
  }
  data.restarts = runs
  c(
    'no-auto-prompt-on-two-restarts',
    runs.every((r) => r.dialogs === 0 && r.flag === true && r.startupLog.length > 0),
    JSON.stringify(runs)
  )
}

async function main() {
  if (!fs.existsSync(ELECTRON)) preconditionSkip('electron.exe not found')
  fs.mkdirSync(OUT, { recursive: true })
  killInstance()
  try {
    await firstRun()
    await starRun()
    await restartTwiceNoPrompt()
    data.log = fsRead(MAIN_LOG)
      .split('\n')
      .filter((l) => l.includes('[support]') || l.includes('[dialog]'))
    data.pass = results.filter((r) => r.startsWith('PASS')).length
    data.total = results.length
    fs.writeFileSync(path.join(OUT, 'support-report.json'), JSON.stringify(data, null, 2))
    console.log(`--- ${data.pass}/${data.total} PASS`)
    if (data.pass !== data.total) process.exitCode = 1
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
      path.join(OUT, 'support-report.json'),
      JSON.stringify({ ...data, results, error: String(e) }, null, 2)
    )
  } catch {}
  process.exitCode = 1
})
