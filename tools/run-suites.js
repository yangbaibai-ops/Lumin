'use strict'
// ─── CDP 套件统一入口 ─────────────────────────────────────────────────────────
//
// 为什么需要它：tools/ 下有 50+ 个 `_verify-*.js`，此前**没有统一跑法** ——
// 每个都要人工先起隔离实例、记住哪些套件会互相污染（设置/kv/最近文档/草稿），
// 结果就是「上一轮跑过的数字」没人能复现。这个脚本把三件事固定下来：
//
//   1. **每个套件起一个全新隔离实例**（`start-isolated.ps1`，user-data-dir 在临时目录）：
//      套件会改设置、写草稿、动 kv，串着跑必然互相污染（实测同一套件两次结果不同）；
//   2. 解析套件末行的 `--- N/M PASS`，汇总成一张矩阵；有 FAIL 就非零退出；
//   3. 慢/需要 dev server 的套件**默认不跑**（`import('/src/...')` 的那批必须有
//      5173 上的 dev server），用 `--all` 或 `--suite=` 显式点名。
//
// 用法：
//   node tools/run-suites.js                     # 跑「快速、无 dev server 依赖」的一组
//   node tools/run-suites.js --suite=_verify-session.js,_verify-md-fidelity.js
//   node tools/run-suites.js --all --port=9223   # 全量（需要 dev server，失败会标 SKIP）
//   node tools/run-suites.js --keep              # 跑完不关实例（调试用）
//
// 约定：套件只允许连 `--remote-debugging-port` 暴露的页面，绝不 kill 进程；
//       实例由本脚本管理，绝不碰用户自己的 `%APPDATA%\lumin`。
//
// ⚠️ **跑之前先 `npm run build`，跑的过程中不要再 build**：实例加载的是 `out/`，
//    边跑边构建会把正在运行的实例指向半截产物 —— 表现是随机的两三条断言失败
//    （实测踩过：编码套件的「设置已落库」与「菜单标题跟随语言」同时红，看着像代码坏了）。

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TOOLS = __dirname

/** 默认跑的套件：不 import /src/...、单实例可跑完、覆盖核心回归面 */
const DEFAULT_SUITES = [
  // ⚠️ 自管实例的套件必须排在**最前面**：它们自己起/杀 Electron（3 轮），
  //    需要 9222 空闲，所以运行器不能先给它起一个实例。
  '_verify-session-last-closed.js',
  '_verify-md-fidelity.js', // Markdown 往返保真（Wave 1）
  '_verify-draft-banner.js', // 草稿横幅（未命名缓冲区的归属）
  '_verify-new-document.js', // 新建 / Ctrl+N / Ctrl+S 落点
  '_verify-session.js', // 会话恢复
  '_verify-local-media.js', // lumin-file:// 白名单 + 本地图片
  '_verify-encoding.js', // 编码判定与写回
  '_verify-wave3.js', // 编辑器⇄store 单向数据流账本 / 文件树键盘可达 / 原生菜单三语
  // 编辑器布局与代码块的核心回归（本轮从「自己连 CDP 的一次性脚本」迁到 harness + Reporter）
  '_regress-layout.js', // 常驻布局：代码块可聚焦可输入 / 跨面位置保持 / 源码回灌 / 大纲联动
  '_regress-split-live.js', // 分屏双向实时同步（同一账本的端到端回归）
  '_regress-cb.js', // 代码块打字 / 回车 / 空块退格删除 / 段落退格入块尾
  '_regress-divider.js', // 分屏分隔条拖拽改比例 + 双击复位 + 比例持久化
  '_regress-fileswitch.js', // 切文件（:key 重建）与「源码模式下切文件」
  '_regress-source-roundtrip.js', // 源码模式往返后的代码块可用性
  '_repro-rapidenter.js' // 快速连续回车不丢行（CM / PM / store 三处一致）
]

/** 自己管理 Electron 实例的套件（运行器不替它们起实例） */
const SELF_MANAGED = new Set(['_verify-session-last-closed.js'])

function parseArgs(argv) {
  const args = { suite: null, all: false, keep: false, port: 9222, timeoutMs: 240000 }
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true
    else if (a === '--keep') args.keep = true
    else if (a.startsWith('--suite=')) args.suite = a.slice('--suite='.length).split(',').filter(Boolean)
    else if (a.startsWith('--port=')) args.port = Number(a.slice('--port='.length))
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice('--timeout='.length))
  }
  return args
}

/** 列出 tools 下所有 `_verify-*.js`（用于 --all） */
function allSuites() {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => /^_verify-.*\.js$/.test(f))
    .sort()
}

/** 这个套件是否需要 dev server（页面里 import('/src/...')） */
function needsDevServer(file) {
  try {
    return /import\(\s*['"]\/src\//.test(fs.readFileSync(path.join(TOOLS, file), 'utf-8'))
  } catch {
    return false
  }
}

/**
 * 杀掉「建在临时目录里」的 Electron 实例（本仓库所有隔离实例的约定位置）。
 *
 * 为什么需要：运行器给每个套件起的实例用 `%TEMP%\lumin-suites-ud`，但**人工**起的
 * 隔离实例（`start-isolated.ps1` 默认 `%TEMP%\lumin-ud`、各类调试脚本各自的名字）
 * 会占着 9222，把整轮矩阵顶掉。按「命令行里的 user-data-dir 落在 %TEMP% 下」判定，
 * **不碰**用户自己的 `%APPDATA%\lumin` 实例。
 */
function killTempInstances() {
  const script = [
    `$tmp = $env:TEMP`,
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |`,
    `  Where-Object { $_.CommandLine -match '--user-data-dir="?([^"\\s]+)' -and $matches[1] -like "$tmp*" } |`,
    `  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ].join('\n')
  spawnSync('powershell', ['-NoProfile', '-Command', script], { cwd: ROOT, stdio: 'ignore' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个隔离实例（日志落文件：直接管道会把 launcher 的 Start-Process 输出挂住） */
function startInstance(port, userData, cleanupOnly = false) {
  const log = path.join(os.tmpdir(), `lumin-suites-${path.basename(userData)}.log`)
  const fd = fs.openSync(log, 'w')
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(TOOLS, 'start-isolated.ps1'),
    '-UserData',
    userData,
    '-Port',
    String(port)
  ]
  if (cleanupOnly) args.push('-CleanupOnly')
  const r = spawnSync('powershell', args, { cwd: ROOT, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : ''
  return { code: r.status, text }
}

/**
 * 跑一个套件，返回 { code, pass, total, raw, skipped }
 * 环境变量里带上隔离实例的库与草稿目录：不少老套件直读 SQLite（`LUMIN_DB`）或草稿目录
 * （`LUMIN_DRAFTS_DIR`），不指过去它们读的就是**用户真实的数据**（曾让 6 项会话断言误报失败）。
 */
function runSuite(file, port, timeoutMs, userData) {
  const env = {
    ...process.env,
    LUMIN_DEBUG_PORT: String(port),
    LUMIN_DB: path.join(userData, 'lumin.db'),
    LUMIN_DRAFTS_DIR: path.join(userData, 'drafts')
  }
  const r = spawnSync(process.execPath, [path.join(TOOLS, file)], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024
  })
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // 汇总行两种写法都认：新套件的 `--- N/M PASS`，老套件的 `TOTAL n PASS x FAIL y`
  let pass = 0
  let total = 0
  const bar = [...raw.matchAll(/---\s*(\d+)\/(\d+)\s*PASS/g)].pop()
  if (bar) {
    pass = Number(bar[1])
    total = Number(bar[2])
  } else {
    const tot = [...raw.matchAll(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)/g)].pop()
    if (tot) {
      pass = Number(tot[2])
      total = Number(tot[1]) - Number(tot[3])
    }
  }
  const skipped = /NO-APP-PAGE|SKIP: 没有可用窗口|SKIP: 9222 上已有|NO_PINIA|INSTANCE-NOT-READY/.test(raw)
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    pass,
    total,
    raw,
    skipped: skipped && !total
  }
}

async function main() {
  const args = parseArgs(process.argv)
  let suites = args.suite ?? (args.all ? allSuites() : DEFAULT_SUITES)
  suites = suites.filter((s) => fs.existsSync(path.join(TOOLS, s)))
  if (!suites.length) {
    console.log('没有可跑的套件')
    return 0
  }

  const userData = path.join(os.tmpdir(), `lumin-suites-ud`)
  console.log(`## CDP 套件矩阵（${suites.length} 个，端口 ${args.port}，实例数据目录 ${userData}）`)
  // 开场先收尾：上一轮留下的实例、以及人工起的隔离实例都会占着 9222，
  // 把第一个套件（可能是自管实例的）顶掉 —— 先清掉临时目录下的实例再开始。
  startInstance(args.port, userData, true)
  killTempInstances()
  await sleep(1500)
  const rows = []
  for (const file of suites) {
    const devNeeded = needsDevServer(file)
    if (devNeeded && !args.all) {
      console.log(`SKIP ${file} | 需要 dev server（import('/src/...')），用 --all 显式跑`)
      rows.push({ file, status: 'SKIP', pass: 0, total: 0 })
      continue
    }
    process.stdout.write(`… ${file} `)
    const selfManaged = SELF_MANAGED.has(file)
    if (!selfManaged) {
      let inst = startInstance(args.port, userData)
      if (inst.code === 2) {
        // 端口被占：可能是人工起的隔离实例（%TEMP% 下）——清一遍再试一次
        killTempInstances()
        await sleep(1500)
        inst = startInstance(args.port, userData)
      }
      if (inst.code !== 0) {
        console.log(`\rFAIL ${file} | 隔离实例没起来（exit ${inst.code}）\n${inst.text.trim().slice(0, 200)}`)
        if (inst.code === 2) {
          console.log(
            '    提示：调试端口被别的 Electron 实例占着。先关掉它（多半是上一轮留下的隔离实例）：\n' +
              `      Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select ProcessId,CommandLine\n` +
              '      （按 CommandLine 里的 --user-data-dir 判断；**不要**动用户自己的 %APPDATA%\\lumin 实例）'
          )
        }
        rows.push({ file, status: 'FAIL', pass: 0, total: 0 })
        continue
      }
    }
    const res = runSuite(file, args.port, args.timeoutMs, userData)
    // 判定以**套件退出码**为准：套件里 SKIP（已知缺口、缺 dev server）不算失败
    const status = res.skipped || res.code === 0 ? (res.skipped ? 'SKIP' : 'PASS') : 'FAIL'
    console.log(
      `\r${status} ${file} | ${res.pass}/${res.total}${selfManaged ? '（自管实例）' : ''}${
        devNeeded ? '（需要 dev server）' : ''
      }`
    )
    if (status === 'FAIL') {
      const tail = res.raw
        .split('\n')
        .filter((l) => /^FAIL|^ERROR|^TOTAL/.test(l))
        .slice(0, 8)
        .join('\n    ')
      if (tail) console.log('    ' + tail)
    }
    rows.push({ file, status, pass: res.pass, total: res.total })
    if (!args.keep) await sleep(500)
  }

  const failed = rows.filter((r) => r.status === 'FAIL')
  const pass = rows.filter((r) => r.status === 'PASS')
  const skipped = rows.filter((r) => r.status === 'SKIP')
  if (!args.keep) startInstance(args.port, userData, true) // 收尾：别把实例留在 9222 上
  console.log(`\nTOTAL ${rows.length} PASS ${pass.length} FAIL ${failed.length} SKIP ${skipped.length}`)
  if (failed.length) console.log('FAILED ' + failed.map((r) => r.file).join(', '))
  return failed.length ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('ERROR ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
