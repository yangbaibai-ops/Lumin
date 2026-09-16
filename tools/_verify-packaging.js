// 验收：打包链路（electron-builder → win-unpacked 免安装版 + NSIS 安装包）
//
// 断言（全部真跑，不看代码猜）：
//  A. `npm run build:unpack` 产出 dist/win-unpacked/Lumin.exe
//  B. **exe 里嵌的确实是我们的图标**：用 Windows 自己的 API 抽出 exe 图标，
//     与 resources/icon.ico 的中心区逐像素比；同时用 electron.exe 的图标做反证
//     （我们的差异必须远小于 Electron 的差异，否则说明图标压根没进产物）
//  C. **裸路径参数能打开文件**（文件关联的前提）：带一个中文 .md 夹具启动打包后的 exe，
//     CDP 连上去断言 files.current.path 与正文都对 —— 顺带验了编码链路
//  D. **第二实例转发**：再起一个进程带另一个夹具 → 新窗口打开它；用**同一个**夹具再来一次
//     → 不重复开窗（沿用「一个文件只开一个窗口」）
//  E. **打包态不写开始菜单快捷方式**：安装器才是那条快捷方式的主人，运行时不插手
//     （快照「开始菜单\程序」目录，前后必须一致，且不得出现 Lumin.lnk）
//  F. `npm run build:win` 产出 NSIS 安装包，报告体积与 SHA256
//     ⚠️ **绝不运行安装包** —— 它会在用户机器上写注册表、开始菜单、卸载项
//  G. **配置单一来源 + 身份一致**：package.json 不许有 `build` 字段（有它 electron-builder.yml 就是死配置），
//     并用 electron-builder 自己的解析函数验证「生效的配置 == yml 里写的」，appId 与代码一致
//
// 另外两条护栏来自踩过的坑，见对应函数的注释：
//  * 构建前必须没有旧实例占着 dist，且要自己删掉上一轮产物并确认删得掉；
//  * 构建后先冒烟启动（A2），坏产物当场暴露并自动重建一次；C 段再失败会打印
//    HINT-PACKAGED-BOOT-FAILED 指向「重新干净构建」，而不是只报一句「连不上 CDP」。
//
// 打包测试一律 `--user-data-dir=%TEMP%\...` 隔离；结束杀掉自己起的进程、清理临时目录。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const DIST = path.join(REPO, 'dist')
const UNPACKED_EXE = path.join(DIST, 'win-unpacked', 'Lumin.exe')
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const ICON_ICO = path.join(REPO, 'resources', 'icon.ico')
const USER_DATA = path.join(os.tmpdir(), 'lumin-pkg-userdata')
const DEBUG_PORT = 9225
const START_MENU = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 迭代时可以只验产物：LUMIN_PKG_SKIP_BUILD=1（默认一定真打包，避免「测的是旧产物」） */
const SKIP_BUILD = process.env.LUMIN_PKG_SKIP_BUILD === '1'
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version
const SETUP_EXE = path.join(DIST, `Lumin-${version}-setup.exe`)

/**
 * 跑一条命令并返回 { ok, code, out }（构建耗时较长，超时给足）。
 *
 * ⚠️ `maxBuffer` 必须放大：Node 的 spawnSync 默认只缓冲 1MB，而 electron-builder 那一行
 * `duplicate dependency references dependencies=[...]` 本身就接近 1MB。一旦超限，**子进程会被
 * 直接杀掉**（error.code = ENOBUFS、status = null），于是：
 *   - 构建实际上被打断，`dist/` 里留下**半成品**（产物存在但 exe 的 asar 完整性资源没来得及写），
 *     这种半成品启动时会静默退出，排查起来极其误导（详见 ensureNoPackagedInstanceRunning 注释）；
 *   - 断言只报一句 `exit=1`，看不出是「构建真的失败」还是「输出太多被杀」。
 * 所以：放大缓冲，并把 r.error 一并带进断言信息。
 */
function run(command, timeoutMs = 20 * 60 * 1000) {
  const r = spawnSync(command, {
    cwd: REPO,
    shell: true,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const err = r.error ? `${r.error.code ?? r.error.message}` : ''
  return { ok: r.status === 0, code: err ? `${r.status ?? 'null'}(${err})` : r.status, out }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function startMenuSnapshot() {
  try {
    return fs
      .readdirSync(START_MENU)
      .filter((n) => /lumin/i.test(n))
      .map((n) => {
        const st = fs.statSync(path.join(START_MENU, n))
        return `${n}@${st.mtimeMs}`
      })
      .sort()
      .join(',')
  } catch {
    return ''
  }
}

/** 起一个打包后的实例（isolated profile），返回 pid */
function launchPackaged(extraArgs, withDebugPort) {
  const args = [`--user-data-dir=${USER_DATA}`, ...extraArgs]
  const env = { ...process.env }
  if (withDebugPort) {
    args.unshift(`--remote-debugging-port=${DEBUG_PORT}`)
    // 主进程只在 LUMIN_DEBUG_PORT 存在时才主动 appendSwitch —— 两条路都给上，确保端口真的开
    env.LUMIN_DEBUG_PORT = String(DEBUG_PORT)
  } else {
    delete env.LUMIN_DEBUG_PORT
  }
  const child = spawn(UNPACKED_EXE, args, { detached: true, stdio: 'ignore', env })
  child.unref()
  return child.pid
}

function get(p, port = DEBUG_PORT) {
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

function connect(url, timeoutMs = 6000) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
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
  const send = (method, params, timeoutMs2 = 15000) =>
    new Promise((res) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        res({ timedOut: true })
      }, timeoutMs2)
      pending.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.timedOut) throw new Error('evaluate timeout')
    if (r.result?.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? '').slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

/** 渲染层桥（打包态是生产构建：pinia 的 Symbol 没有描述，必须用鸭子类型兜底） */
const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const prov = app._context.provides
  const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__PKG = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui') }
  return 'ok'
})()`

const pages = async () => (await get('/json/list')).filter((t) => t.type === 'page')

/** 等主实例的调试端口与首页就绪 */
async function waitForApp(timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await pages()).length) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return false
}

/**
 * 用 Windows 自己的 API 抽出 exe 的 32×32 图标，返回中心 8×8 的均色与整体均色。
 * 只当**辅助判据**（字节比对才是硬证据）：抽取过程会带缩放/抗锯齿，逐像素比没有意义，
 * 但「中心区偏不偏青」足以区分我们的字形（中性白）与 Electron 的 logo（青色）。
 * 顺带把抽出的图标存 PNG 到 %TEMP%，供人工眼看一下到底嵌的是哪张图。
 */
function extractIconStats(exePath, label) {
  const ps = `param([string]$Exe,[string]$Label)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe).ToBitmap()
$bmp.Save((Join-Path $env:TEMP ("lumin-exe-icon-" + $Label + ".png")), [System.Drawing.Imaging.ImageFormat]::Png)
$w = $bmp.Width; $h = $bmp.Height
$sumR = 0; $sumG = 0; $sumB = 0; $n = 0
$x0 = [int](($w - 8) / 2); $y0 = [int](($h - 8) / 2)
for ($x = $x0; $x -lt $x0 + 8; $x++) { for ($y = $y0; $y -lt $y0 + 8; $y++) {
  $p = $bmp.GetPixel($x, $y); if ($p.A -lt 128) { continue }
  $sumR += $p.R; $sumG += $p.G; $sumB += $p.B; $n++
} }
if ($n -eq 0) { '{"error":"no opaque pixel"}' } else {
  [pscustomobject]@{
    size = "$($w)x$($h)"
    centerR = [int]($sumR / $n); centerG = [int]($sumG / $n); centerB = [int]($sumB / $n)
    sampled = $n
    png = (Join-Path $env:TEMP ("lumin-exe-icon-" + $Label + ".png"))
  } | ConvertTo-Json -Compress
}
`
  const script = path.join(os.tmpdir(), 'lumin-icon-extract.ps1')
  fs.writeFileSync(script, ps, 'utf-8')
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exe', exePath, '-Label', label],
    { encoding: 'utf-8', timeout: 60000 }
  )
  const line = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { error: `${line}${r.stderr ?? ''}`.slice(0, 200) }
  }
}

/**
 * 杀掉本次测试留下的打包进程。
 *
 * 匹配范围刻意收窄，绝不碰用户自己的实例：
 *  - 进程名必须叫 Lumin.exe（用户开发态跑的是 electron.exe，不受影响）；
 *  - 且「命令行里带本套件的隔离 profile」**或**「可执行文件就在 dist\ 下」（= 我们自己的产物）。
 *
 * ⚠️ **打包前必须先把这些进程清干净**（见 ensureNoPackagedInstanceRunning 的说明）。
 */
function killPackaged() {
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='Lumin.exe'" | Where-Object { $_.CommandLine -like '*lumin-pkg-userdata*' -or ($_.ExecutablePath -and $_.ExecutablePath -like '${DIST.replace(/'/g, "''")}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ],
    { encoding: 'utf-8', timeout: 60000 }
  )
}

/** 当前还活着的打包实例（同上匹配规则） */
function listPackagedProcesses() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='Lumin.exe'" | Where-Object { $_.CommandLine -like '*lumin-pkg-userdata*' -or ($_.ExecutablePath -and $_.ExecutablePath -like '${DIST.replace(/'/g, "''")}*') } | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`
    ],
    { encoding: 'utf-8', timeout: 60000 }
  )
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 打包前确保没有任何打包实例在跑 —— **这是踩过的坑，不是仪式感**。
 *
 * 背景（现象与已知事实，别再重复排查一遍）：
 *  某两轮验收构建出的产物「启动即静默退出」：exit code 1、stdout/stderr 一个字都没有、profile 目录
 *  建了但是空的、连主进程的启动日志都不写（用 `--inspect` 试过，Node inspector 根本不监听 ——
 *  说明死在 Electron 启动校验阶段，主进程 JS 一行都没跑）。而 A/B 段（产物存在、exe 里 7 档图标
 *  字节全中）**全部 PASS**，只有 C 段「连不上 CDP」暴露出来，非常误导。
 *  已验证的事实：这种产物**重新构建一次就恢复正常**，且重建后的 exe / app.asar 与可用产物
 *  **SHA256 逐字节一致**（所以不是配置或代码问题，也不是构建不确定）。
 *  推测的触发条件：构建时 `dist\win-unpacked` 里上一轮的产物文件仍被占用（刚被杀掉的进程可能还留着
 *  句柄），electron-builder 往 exe 里写 asar 完整性资源（日志里的
 *  `updating asar integrity executable resource`）时没能与新的 asar 对上。**这一条是推测**，
 *  没有最终定位；但「先清场、再构建、构建后冒烟启动」这套流程不依赖推测是否成立。
 */
async function ensureNoPackagedInstanceRunning() {
  const before = listPackagedProcesses()
  if (before.length) {
    console.log('LEFTOVER-PACKAGED ' + JSON.stringify(before))
    killPackaged()
    for (let i = 0; i < 30 && listPackagedProcesses().length; i++) await sleep(500)
  }
  return listPackagedProcesses()
}

/**
 * 构建前自己把上一轮的产物删掉，并**确认删得掉**。
 * 删不掉 = 还有东西占着这些文件 —— 这正是「构建出坏产物」最可能的触发条件，
 * 所以宁可在这里显式失败，也不要让 electron-builder 在文件被占的情况下继续跑。
 */
function clearPreviousArtifacts() {
  const problems = []
  for (const target of [path.join(DIST, 'win-unpacked'), SETUP_EXE, path.join(DIST, 'latest.yml')]) {
    if (!fs.existsSync(target)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
    } catch (e) {
      problems.push(`${path.basename(target)}: ${e.code ?? e.message}`)
    }
    if (fs.existsSync(target)) problems.push(`${path.basename(target)}: 删除后仍存在（被占用）`)
  }
  return problems
}

/**
 * 构建后**冒烟启动**：产物能不能真的跑起来，必须在跑 C 段之前就知道。
 * 因为坏产物的表现是「启动即静默退出」，只有真起一次才能发现；起不来就自动重建一次再试
 * （重建已被验证能修复），两次都不行才判定失败。
 */
async function smokeBootArtifact(timeoutMs = 25000) {
  killPackaged()
  await sleep(800)
  const pid = launchPackaged([], true)
  const ok = await waitForApp(timeoutMs)
  if (ok) {
    killPackaged()
    await sleep(1200)
  }
  return { ok, pid }
}

;(async () => {
  const results = []
  const c = (n, cond, extra) => {
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
    console.log((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  }

  // 用户环境快照：全程不得变化
  const startMenuBefore = startMenuSnapshot()
  console.log('START-MENU-BEFORE ' + JSON.stringify(startMenuBefore))

  // ── A. build:unpack ──
  console.log('── A. npm run build:unpack（免安装版）' + (SKIP_BUILD ? ' —— 本轮跳过，复用已有产物' : '') + '──')
  // 先清场：进程清干净 + 自己删掉上一轮产物并确认删得掉。有东西占着 dist 时构建出来的产物可能
  // 「启动即静默退出」（详见 ensureNoPackagedInstanceRunning / clearPreviousArtifacts 的注释）。
  const leftovers = await ensureNoPackagedInstanceRunning()
  c('no-packaged-instance-holds-dist-before-build', leftovers.length === 0, JSON.stringify(leftovers))
  const clearProblems = clearPreviousArtifacts()
  c('dist-cleared-before-build', clearProblems.length === 0, JSON.stringify(clearProblems))
  if (!SKIP_BUILD) {
    const unpack = run('npm run build:unpack')
    console.log(unpack.out.split(/\r?\n/).slice(-12).join('\n'))
    if (!unpack.ok) {
      // 失败时把可疑行单独拎出来：只打尾 12 行时，「输出太多被杀」和「构建真报错」看起来一模一样
      const suspects = unpack.out
        .split(/\r?\n/)
        .filter((l) => /error|fail|cannot|denied|EPERM|EBUSY|ENOBUFS/i.test(l))
        .slice(0, 12)
      console.log('BUILD-SUSPECT-LINES ' + JSON.stringify(suspects))
    }
    c('build-unpack-succeeds', unpack.ok, `exit=${unpack.code}`)
  } else {
    c('build-unpack-succeeds', fs.existsSync(UNPACKED_EXE), 'SKIPPED (复用已有 dist/win-unpacked)')
  }
  c('unpacked-exe-exists', fs.existsSync(UNPACKED_EXE), UNPACKED_EXE)
  if (!fs.existsSync(UNPACKED_EXE)) {
    console.log('打包未产出 exe，后续断言无法进行')
    console.log(`--- ${results.filter((r) => r.startsWith('PASS')).length}/${results.length} PASS`)
    process.exit(1)
  }

  // ── A2. 产物冒烟启动（构建后立刻验一次，坏产物在这里就被抓住，不用等到 C 段才暴露）──
  // 坏产物的症状是「启动即静默退出」，只有真起一次才知道；起不来就自动重建一次再试。
  console.log('── A2. 产物冒烟启动 ──')
  let smoke = await smokeBootArtifact()
  if (!smoke.ok && !SKIP_BUILD) {
    console.log('SMOKE-FAILED-FIRST-TRY ' + JSON.stringify(smoke) + ' → 自动重建一次后重试')
    const rebuild = run('npm run build:unpack')
    console.log(rebuild.out.split(/\r?\n/).slice(-8).join('\n'))
    killPackaged()
    await sleep(1500)
    smoke = await smokeBootArtifact()
    c('packaged-artifact-boots-after-rebuild', smoke.ok, JSON.stringify(smoke))
  }
  c('packaged-artifact-smoke-boots', smoke.ok, JSON.stringify(smoke))

  // ── B. 图标真的嵌进了 exe ──
  // 判据用**字节级**的：electron-builder 会把 resources/icon.ico 的各档位原样写进 exe 的图标资源，
  // 所以「我们的每个条目负载都能在 exe 里逐字节找到」是「图标真的进了产物」的最硬证据。
  // （最初写的是「抽 exe 图标逐像素比」，但 .NET 的 Icon(path,32,32) 取参考图时会给出 alpha 只有 40
  //   的中间态 —— 参考值本身是坏的，比出来的数字没有意义。换成字节比对。）
  console.log('── B. exe 内嵌图标 ──')
  const icoBuf = fs.readFileSync(ICON_ICO)
  const icoEntries = (() => {
    const n = icoBuf.readUInt16LE(4)
    const out = []
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16
      const size = icoBuf.readUInt8(o) === 0 ? 256 : icoBuf.readUInt8(o)
      const len = icoBuf.readUInt32LE(o + 8)
      const off = icoBuf.readUInt32LE(o + 12)
      out.push({ size, payload: icoBuf.subarray(off, off + len) })
    }
    return out
  })()
  const exeBytes = fs.readFileSync(UNPACKED_EXE)
  const foundInExe = icoEntries.map((e) => ({ size: e.size, found: exeBytes.includes(e.payload) }))
  const electronBytes = fs.existsSync(ELECTRON_EXE) ? fs.readFileSync(ELECTRON_EXE) : Buffer.alloc(0)
  const foundInElectron = icoEntries.map((e) => electronBytes.includes(e.payload))
  console.log('ICON-BYTES ' + JSON.stringify({ sizes: foundInExe.map((f) => f.size), inExe: foundInExe.map((f) => f.found) }))
  c(
    'exe-embeds-our-icon-bytes',
    foundInExe.length === 7 && foundInExe.every((f) => f.found),
    JSON.stringify(foundInExe)
  )
  c(
    'electron-exe-has-none-of-our-icon',
    foundInElectron.every((v) => v === false),
    JSON.stringify(foundInElectron)
  )
  // 图标资源还得是「可读的」：Windows 抽得出 32×32，说明资源目录接对了
  const extracted = extractIconStats(UNPACKED_EXE, 'lumin-packaged')
  const electronExtracted = extractIconStats(ELECTRON_EXE, 'electron-control')
  console.log('ICON-EXTRACT ' + JSON.stringify({ ours: extracted, electron: electronExtracted }))
  c('exe-icon-extractable-32px', extracted?.size === '32x32', JSON.stringify(extracted))
  // 中心区判别（旁证，真正的硬证据是上面的字节比对）：
  // 我们字形的中心是**接近白**的（实测 176,179,198 —— 白字带一点periwinkle），
  // Electron 图标中心实测是暗色（60,66,78）。判别用亮度差，实测差 113，阈值取 60 留足余量。
  const lumaOf = (p) =>
    typeof p?.centerR === 'number' ? p.centerR * 0.299 + p.centerG * 0.587 + p.centerB * 0.114 : NaN
  const oursLuma = lumaOf(extracted)
  const electronLuma = lumaOf(electronExtracted)
  c(
    'exe-icon-renders-ours-not-electron',
    Number.isFinite(oursLuma) && Number.isFinite(electronLuma) && oursLuma - electronLuma > 60,
    JSON.stringify({
      ours: { r: extracted?.centerR, g: extracted?.centerG, b: extracted?.centerB, luma: Math.round(oursLuma) },
      electron: { r: electronExtracted?.centerR, g: electronExtracted?.centerG, b: electronExtracted?.centerB, luma: Math.round(electronLuma) }
    })
  )

  // ── C. 裸路径参数（文件关联的前提） ──
  console.log('── C. 裸路径参数打开文件 ──')
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  const fixtureDir = path.join(os.tmpdir(), 'lumin-pkg-fixtures')
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  fs.mkdirSync(fixtureDir, { recursive: true })
  const fixtureA = path.join(fixtureDir, '甲-中文名.md')
  const fixtureB = path.join(fixtureDir, '乙-第二篇.md')
  const textA = '# 甲文档标题\n\n这是 UTF-8 保存的中文正文，用来顺带验证编码链路。\n'
  const textB = '# 乙文档标题\n\n第二篇的内容。\n'
  fs.writeFileSync(fixtureA, Buffer.from(textA, 'utf-8'))
  fs.writeFileSync(fixtureB, Buffer.from(textB, 'utf-8'))

  killPackaged()
  const primaryPid = launchPackaged([fixtureA], true)
  const up = await waitForApp()
  if (!up) {
    // 打包实例起不来时给出**可执行的下一步**，而不是只报一句「连不上 CDP」：
    // 十有八九是 exe 里的 asar 完整性哈希与 asar 不一致（构建时有旧实例占着 exe），
    // 症状是进程启动即静默退出。重新干净构建即可，不要往代码/配置上找。
    const alive = listPackagedProcesses()
    console.log(
      'HINT-PACKAGED-BOOT-FAILED ' +
        JSON.stringify({
          pid: primaryPid,
          stillAlive: alive,
          likelyCause: 'asar 完整性哈希与 exe 不一致（构建时旧实例占着 exe）或产物不完整',
          nextStep: '重跑 npm run build:unpack（确保没有 Lumin.exe 在跑）后再试'
        })
    )
  }
  c('packaged-app-boots', up, 'pid=' + primaryPid)
  if (up) {
    const targets = await pages()
    const w = connect(targets[0].webSocketDebuggerUrl)
    await w.ready
    for (let i = 0; i < 40; i++) {
      const st = await w.ev(SETUP).catch(() => 'err')
      if (st === 'ok') break
      await sleep(400)
    }
    const readDoc = async (page) =>
      JSON.parse(
        await w.ev(
          `(() => { const f = window.__PKG.files(); const c = f.current; return JSON.stringify({ path: c?.path ?? null, head: c ? c.content.slice(0, 10) : null, encoding: c?.encoding ?? null }) })()`
        )
      )
    let a = await readDoc()
    for (let i = 0; i < 30 && a.path !== fixtureA; i++) {
      await sleep(500)
      a = await readDoc()
    }
    console.log('C-BARE-PATH ' + JSON.stringify(a))
    c('bare-path-opens-file', a.path === fixtureA, JSON.stringify(a))
    c(
      'bare-path-content-decoded',
      typeof a.head === 'string' && a.head.startsWith('# 甲文档标题'),
      JSON.stringify({ head: a.head, encoding: a.encoding })
    )
    w.ws.close()
  } else {
    c('bare-path-opens-file', false, 'SKIP: 打包实例没起来')
    c('bare-path-content-decoded', false, 'SKIP')
  }

  // ── D. 第二实例转发 + 同文件去重 ──
  console.log('── D. 第二实例转发 ──')
  const countPages = async () => (await pages()).length
  const beforeIds = up ? (await pages()).map((p) => p.id) : []
  const beforeCount = beforeIds.length
  launchPackaged([fixtureB], false)
  // 注意：CDP 的目标顺序不保证「新窗口在最后」，必须用 id 差集找新窗口（踩过：取最后一个
  // 结果读到的还是第一个窗口，误判成「第二实例没打开目标文件」）。
  let fresh = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const now = await pages()
    fresh = now.find((p) => !beforeIds.includes(p.id)) ?? null
    if (fresh) break
  }
  c('second-instance-opens-new-window', !!fresh, `pages ${beforeCount} -> ${await countPages()}`)
  if (fresh) {
    const w = connect(fresh.webSocketDebuggerUrl)
    await w.ready
    for (let i = 0; i < 40; i++) {
      const st = await w.ev(SETUP).catch(() => 'err')
      if (st === 'ok') break
      await sleep(400)
    }
    let b = JSON.parse(
      await w.ev(
        `(() => { const c = window.__PKG.files().current; return JSON.stringify({ path: c?.path ?? null, head: c ? c.content.slice(0, 10) : null }) })()`
      )
    )
    for (let i = 0; i < 30 && b.path !== fixtureB; i++) {
      await sleep(500)
      b = JSON.parse(
        await w.ev(
          `(() => { const c = window.__PKG.files().current; return JSON.stringify({ path: c?.path ?? null, head: c ? c.content.slice(0, 10) : null }) })()`
        )
      )
    }
    console.log('D-SECOND-INSTANCE ' + JSON.stringify(b))
    c('second-instance-opens-that-file', b.path === fixtureB, JSON.stringify(b))
    w.ws.close()
  } else {
    c('second-instance-opens-that-file', false, 'SKIP: 没有新窗口')
  }

  const beforeDedup = await countPages()
  launchPackaged([fixtureB], false) // 同一个文件再来一次 → 应聚焦，不该开新窗
  await sleep(4000)
  const afterDedup = await countPages()
  console.log('D-DEDUP ' + JSON.stringify({ before: beforeDedup, after: afterDedup }))
  c('same-file-does-not-open-twice', afterDedup === beforeDedup, `${beforeDedup} -> ${afterDedup}`)

  // ── E. 打包态不写开始菜单快捷方式 ──
  console.log('── E. 开始菜单不被运行时改动 ──')
  const startMenuAfter = startMenuSnapshot()
  console.log('START-MENU-AFTER ' + JSON.stringify(startMenuAfter))
  c('packaged-run-does-not-touch-start-menu', startMenuAfter === startMenuBefore, JSON.stringify({ before: startMenuBefore, after: startMenuAfter }))
  c('packaged-run-creates-no-Lumin-lnk', !fs.existsSync(path.join(START_MENU, 'Lumin.lnk')), path.join(START_MENU, 'Lumin.lnk'))

  // 收工：杀掉我们起的实例（只匹配隔离 profile）
  killPackaged()
  await sleep(1500)

  // ── F. NSIS 安装包 ──
  // ⚠️ 只构建、绝不运行：运行安装包会在用户机器上写注册表/开始菜单/卸载项。
  console.log('── F. npm run build:win（NSIS 安装包，不运行）' + (SKIP_BUILD ? ' —— 本轮跳过' : '') + '──')
  if (!SKIP_BUILD) {
    const win = run('npm run build:win')
    console.log(win.out.split(/\r?\n/).slice(-14).join('\n'))
    c('build-win-succeeds', win.ok, `exit=${win.code}`)
  } else {
    c('build-win-succeeds', fs.existsSync(SETUP_EXE), 'SKIPPED (复用已有安装包)')
  }
  const setupExists = fs.existsSync(SETUP_EXE)
  c('nsis-installer-produced', setupExists, SETUP_EXE)
  if (setupExists) {
    const size = fs.statSync(SETUP_EXE).size
    const hash = sha256(SETUP_EXE)
    console.log('INSTALLER ' + JSON.stringify({ file: path.basename(SETUP_EXE), bytes: size, mb: +(size / 1048576).toFixed(1), sha256: hash }))
    c('installer-size-sane', size > 40 * 1024 * 1024 && size < 400 * 1024 * 1024, `${(size / 1048576).toFixed(1)} MB`)
  }
  const latestYml = path.join(DIST, 'latest.yml')
  console.log('LATEST-YML ' + (fs.existsSync(latestYml) ? 'present（自动更新的版本清单）' : 'absent'))

  // ── G. 配置单一来源 + 身份一致（防「死配置」复发）──
  // 背景（实测确认，别凭印象）：electron-builder 的解析顺序是**先读 package.json 的 `build` 字段**，
  // 有它就完全忽略 electron-builder.yml。所以「yml 写得很全但 package.json 里还留着 build」= yml 是死配置。
  // 这里用 electron-builder 自己的解析函数（app-builder-lib 的内部路径，只在本验收工具里用）算出**有效配置**，
  // 再断言它确实来自 yml：nsis.oneClick 默认是 true，yml 写的是 false —— 读出 false 就证明 yml 真的生效了。
  console.log('── G. 配置单一来源与身份一致 ──')
  const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'))
  c(
    'package-json-has-no-build-field',
    !('build' in pkgJson),
    JSON.stringify({ hasBuild: 'build' in pkgJson, note: '有 build 字段时 electron-builder.yml 会被完全忽略' })
  )
  const { getConfig } = require(path.join(REPO, 'node_modules', 'app-builder-lib', 'out', 'util', 'config', 'config.js'))
  const eff = await getConfig(REPO, null, null)
  const ymlPath = path.join(REPO, 'electron-builder.yml')
  const ymlText = fs.readFileSync(ymlPath, 'utf-8')
  const effInfo = {
    appId: eff.appId,
    productName: eff.productName,
    executableName: eff.win?.executableName,
    winIcon: eff.win?.icon,
    oneClick: eff.nsis?.oneClick,
    allowDir: eff.nsis?.allowToChangeInstallationDirectory,
    deleteAppDataOnUninstall: eff.nsis?.deleteAppDataOnUninstall,
    associations: (eff.fileAssociations ?? []).map((f) => f.ext)
  }
  console.log('EFFECTIVE-CONFIG ' + JSON.stringify(effInfo))
  // 逐条与 yml 文本对账：这些值只要和 yml 一致，就说明「生效的配置 == yml 里写的」
  c(
    'builder-config-comes-from-yml',
    eff.appId === 'com.lumin.app' &&
      eff.productName === 'Lumin' &&
      eff.win?.executableName === 'Lumin' &&
      eff.win?.icon === 'resources/icon.ico' &&
      // oneClick 默认 true，yml 写 false —— 读到 false 就证明 yml 不是躺着的死配置
      eff.nsis?.oneClick === false &&
      eff.nsis?.allowToChangeInstallationDirectory === true &&
      // 卸载不删用户数据：这条是「绝不能改错」的一条，单独盯住
      eff.nsis?.deleteAppDataOnUninstall === false &&
      /oneClick:\s*false/.test(ymlText) &&
      /deleteAppDataOnUninstall:\s*false/.test(ymlText),
    JSON.stringify(effInfo)
  )
  // 身份一致：安装器写进快捷方式的 appId 与应用运行时设置的必须同一个（见 services/taskbar.ts）
  const taskbarSrc = fs.readFileSync(path.join(REPO, 'src', 'main', 'services', 'taskbar.ts'), 'utf-8')
  const codeAppIds = [...taskbarSrc.matchAll(/'(com\.lumin\.app[^']*)'/g)].map((m) => m[1])
  c(
    'appid-matches-code',
    codeAppIds.includes(eff.appId),
    JSON.stringify({ fromBuilder: eff.appId, fromCode: [...new Set(codeAppIds)] })
  )
  c(
    'file-associations-md-only',
    JSON.stringify(effInfo.associations) === JSON.stringify(['md', 'markdown']),
    JSON.stringify(effInfo.associations)
  )

  // 收尾：清理隔离 profile 与夹具（dist/ 是产物，保留供人工检查）
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  fs.rmSync(fixtureDir, { recursive: true, force: true })

  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  killPackaged()
  process.exit(1)
})
