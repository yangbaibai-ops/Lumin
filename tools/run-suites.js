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
//   node tools/run-suites.js --retry=0           # 关掉失败重跑（默认 1 次，见下面的 FLAKY）
//
// 判定档位：PASS / **FLAKY**（首次红、重跑绿：环境敏感，不判失败但会单独列出）/
//           FAIL（重跑仍红 = 真回归）/ SKIP（环境不支持，如实跳过）/
//           NOASSERT（一条断言都没产出 = 没测）。
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

/**
 * 「确实没有断言可产出」的套件白名单（**必须写理由**）。
 *
 * 背景（自查报告 H1）：判定只看退出码时，一个没产出断言的套件会显示 `0/0 PASS`，
 * 与「全部通过」只差一个数字。现在零断言一律记 NOASSERT 并让命令失败；
 * 如果某个套件天生无事可断言（例如它只做一次性清理），把它加到这里并写明原因。
 */
const EMPTY_OK = new Set([
  // 目前为空：所有已知的 0 断言套件都是**该修或该删**的（见 NOASSERT 汇总行）。
])

/** 默认跑的套件：不 import /src/...、单实例可跑完、覆盖核心回归面 */
const DEFAULT_SUITES = [
  // ⚠️ 自管实例的套件必须排在**最前面**：它们自己起/杀 Electron（3 轮），
  //    需要 9222 空闲，所以运行器不能先给它起一个实例。
  '_verify-session-last-closed.js',
  '_verify-md-fidelity.js', // Markdown 往返保真（Wave 1）
  '_verify-draft-banner.js', // 草稿横幅（未命名缓冲区的归属）
  '_verify-new-document.js', // 新建 / Ctrl+N / Ctrl+S 落点
  '_verify-session.js', // 会话恢复
  '_verify-single-instance.js', // 单实例锁：第二个实例立刻干净退出（自管实例 + 独立调试端口）
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
  '_repro-rapidenter.js', // 快速连续回车不丢行（CM / PM / store 三处一致）
  '_verify-find-replace.js', // 编辑器内查找替换（两个编辑面 / 替换与全部替换 / 大小写）
  '_verify-inline-formats.js', // 行内格式矩阵：工具栏/快捷键/手打标记/组合（标记字符一个不能少）
  '_verify-math.js', // 数学公式（行内 `$…$` / 块级 `$$…$$`）：KaTeX 渲染 + 原文逐字保留
  // 两面一致性（实时渲染 ⇄ 源码）三层：见 docs/wysiwyg-test-plan.md
  // ── 自查报告整改时接入的四条（原来是「0 断言假通过」或新功能）──
  '_verify-remote-image.js', // 远程图片隐私闸门：不自动加载 / 点击加载 / 导出仍给真实 src
  '_verify-a11y.js', // 无障碍基线：icon-only 按钮必须有可访问名 + 状态属性一致
  '_verify-editor-menu.js', // 编辑器右键菜单（两级结构、分类悬停、动作齐全）
  '_verify-i18n.js', // 切换语言后顶部菜单文字随之变化（三语）
  '_verify-surfaces.js', // L2 双面端到端矩阵：切面无副作用 / 位置语义 / 状态语义 / 渲染结构
  '_verify-surface-fuzz.js', // L3 生成式语料往返（可复现种子 + 失败最小化）
  '_verify-surface-stress.js', // L4 极端/边界/压力（含 1MB 与 2000 代码块的耗时基线）
  // ── 清单 §2.I 收口时「从 --all 提进默认矩阵」的一批（有价值且单实例可跑完）──
  '_verify-toc.js', // 目录 [TOC]：插入 / 渲染 / 点击跳转 / 往返 / 重载还原（原两条 0 断言探针合并升级）
  '_verify-notifications.js', // 通知中心整体（CRUD / 顶部通知带 / 步进 / 多语言 / 重载存活 / 兼容层）
  '_verify-toolbar-settings.js', // 快捷工具栏：空白区右键菜单 + 显隐与排序设置
  '_verify-cb-languages.js', // 代码块语言高亮矩阵（15 种 + 别名，清单外退化为纯文本）
  '_verify-cb-virtualization.js', // 代码块 CM 虚拟化：按需挂载 / 高度稳定 / 选区保护 / churn 后可打字
  '_verify-table-fidelity.js', // 表格保真：单元格回车不再退化成 HTML / 空段丢弃 / 多段用 <br> / 幂等
  '_verify-outline-right.js', // 三栏模式：大纲放右侧（左栏只剩文件树 / 右侧可折叠展开 / 关掉即还原）
  '_verify-outline-nav.js', // 目录高亮：点最后一条 / 滚到底点亮最后一节 / 高亮锁不永久
  '_verify-bars-no-filename.js', // 顶栏与状态栏：不再出现文件名；保存那格只说状态、不带圆点、同灰；列表入场动画已取消
  '_verify-mermaid-gate.js', // mermaid 视口门 + 首屏不预加载（清单 §2.G）
  '_verify-neutral-accent.js', // 副色必须是低饱和灰（通道极差断言）
  // ── 第九轮提进默认矩阵（纯合成事件：不依赖窗口出帧，适合批量跑）──
  '_verify-sidebar-search.js', // Ctrl+F 的去向：焦点在文件面板里搜文件名，否则搜正文（含两个边界）
  '_verify-rename.js', // 文件树就地重命名 + 新建文件（内容区切过去 / 无边框输入框 / 脏了先问）
  '_verify-sidebar-refresh.js', // 头部「刷新」只在列表视图下出现，且真的能刷新列表元数据
  // ── 第十轮：数据安全（保存期输入 / 草稿最大等待 / 换文档前 flush / 真实 mtime）──
  '_verify-save-safety.js'
]

/** 自己管理 Electron 实例的套件（运行器不替它们起实例） */
const SELF_MANAGED = new Set([
  '_verify-session-last-closed.js',
  // 它自己起「首个实例 + 第二个实例」，并用 9231 而不是 9222，故不占运行器的实例
  '_verify-single-instance.js'
])

function parseArgs(argv) {
  const args = { suite: null, all: false, keep: false, port: 9222, timeoutMs: 420000, retry: 1 }
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true
    else if (a === '--keep') args.keep = true
    else if (a.startsWith('--suite=')) args.suite = a.slice('--suite='.length).split(',').filter(Boolean)
    else if (a.startsWith('--port=')) args.port = Number(a.slice('--port='.length))
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice('--timeout='.length))
    // 失败重跑次数（默认 1）。见 README 里「FLAKY 与 FAIL 的区别」
    else if (a.startsWith('--retry=')) args.retry = Math.max(0, Number(a.slice('--retry='.length)))
  }
  return args
}

/**
 * **两阶段/需人工介入**的套件：`--all` 里必须排除，否则每轮都报一个假 FAIL。
 *
 * `_verify-notify-restart.js` 的用法是 `seed` → **外部杀掉 Electron 并重启** → `check`，
 * 不带参数跑只会打印用法然后 `exit 1`（运行器读到 `0/0` 记成 FAIL）。
 * 它验证的是「跨进程重启」这件事，任何自动矩阵都给不了那个重启时机。
 */
const MANUAL = new Set(['_verify-notify-restart.js'])

/** 列出 tools 下所有 `_verify-*.js`（用于 --all） */
function allSuites() {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => /^_verify-.*\.js$/.test(f))
    .filter((f) => !MANUAL.has(f))
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
    LUMIN_DRAFTS_DIR: path.join(userData, 'drafts'),
    // 有套件会**自己再起一个实例**（`--user-data-dir=$LUMIN_ISOLATED_USERDATA`）来验证
    // 「第二个进程把参数转交给首个实例」（如 _verify-taskbar-jumplist.js 的 C 段、
    // _verify-encoding.js）。它们读的就是这个变量，缺了它就会退回一个**写死的旧目录名**
    // （%TEMP%\lumin-keymap-userdata）—— 那跟本运行器起的实例（%TEMP%\lumin-suites-ud）
    // 不是同一个 profile，于是第二个进程拿不到单实例锁、自己成了首实例、开出的窗口不在
    // 本运行器的调试端口上，表现成「一个窗口都没多出来」的假失败（实测 25/31，其中 6 条
    // 全红）。把实例真实目录告诉套件，才能真的走到「转交 → 新窗口」那条路径上。
    LUMIN_ISOLATED_USERDATA: userData
  }
  const r = spawnSync(process.execPath, [path.join(TOOLS, file)], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024
  })
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // 汇总行三种写法都认：新套件的 `--- N/M PASS`、老套件的 `TOTAL n PASS x FAIL y`、
  // **以及更老的「逐行 `PASS x` / `FAIL y` 但从不打汇总行」那一批**（自查报告 H1 的第二种成因：
  // 这类套件其实一直在断言，只是运行器把它们的成绩读成 0/0 —— 实测 `_verify-editor-menu.js`
  // 51 条、`_verify-notify-style.js` 11 条、`_verify-cb-no-active-line.js` 12 条都是这样被"清零"的）。
  let pass = 0
  let total = 0
  let fail = 0
  let skip = 0
  // ⚠️ **SKIP 不是 FAIL**（清单 §1.C.1）：`--- N/M PASS` 里的 M 是「断言总数」，含 SKIP
  // （Reporter 的 total = passed + failed + skipped），所以 `M - N` **不等于**失败数 ——
  // 老写法把它当失败数，于是「FAIL 0 SKIP 1」的套件被判 FAIL：实测 `_verify-md-fidelity.js`
  // （101/102）、`_verify-round-24.js`（15/16）、`_verify-theme-auto.js` 退出码 0、FAIL 0，
  // 却每轮报红。现在优先认三个数分开写的 `TOTAL … FAIL … SKIP …`；
  // 退到老格式或只有 `--- N/M PASS` 时，用 **SKIP 行数**从 M 里扣掉再算失败数。
  const skipLines = raw.split('\n').filter((l) => /^\s*SKIP\b/.test(l)).length
  const full = [
    ...raw.matchAll(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)\s+SKIP\s+(\d+)/g)
  ].pop()
  const tot = full
    ? null
    : [...raw.matchAll(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)/g)].pop()
  const bar = full || tot ? null : [...raw.matchAll(/---\s*(\d+)\/(\d+)\s*PASS/g)].pop()
  if (full) {
    total = Number(full[1])
    pass = Number(full[2])
    fail = Number(full[3])
    skip = Number(full[4])
  } else if (tot) {
    pass = Number(tot[2])
    fail = Number(tot[3])
    skip = Math.max(0, Number(tot[1]) - pass - fail)
    total = pass + fail + skip
  } else if (bar) {
    pass = Number(bar[1])
    total = Number(bar[2])
    skip = Math.min(skipLines, Math.max(0, total - pass))
    fail = Math.max(0, total - pass - skip)
  } else {
    const lines = raw.split('\n')
    const okLines = lines.filter((l) => /^\s*PASS\b/.test(l)).length
    const badLines = lines.filter((l) => /^\s*FAIL\b/.test(l)).length
    if (okLines + badLines > 0) {
      pass = okLines
      fail = badLines
      total = okLines + badLines
    }
  }
  const skipped = /NO-APP-PAGE|SKIP: 没有可用窗口|SKIP: 9222 上已有|NO_PINIA|INSTANCE-NOT-READY/.test(raw)
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    pass,
    total,
    fail,
    skip,
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
    /**
     * 判定只看两件事：**套件退出码**与**打印过的 FAIL 行**（老套件里存在"只打印、退出码仍 0"
     * 的写法，实测 `_verify-notifications.js` 就是这一类）。
     * ⚠️ SKIP **不参与**失败判定（清单 §1.C.1）：环境不支持而如实 SKIP 的断言不该把整轮判红 ——
     * 它们在行尾单独显示 `SKIP n`，整体退出码也不受 SKIP 影响。
     */
    let status = res.code === 0 && res.fail === 0 ? 'PASS' : 'FAIL'
    if (res.skipped && res.total === 0) status = 'SKIP'
    /**
     * ─── 失败重跑一次：**FLAKY 与 FAIL 分开**（默认 `--retry=1`）─────────────────
     *
     * 为什么要有这一档：CDP 套件住在真实桌面里 —— 机器忙、窗口被遮挡、首帧还没稳定时，
     * 「等布局/等焦点/等帧」类断言会随机红一条。实测：同一套件批跑红、单独重跑绿
     * （本轮 `_regress-cb` / `_verify-cb-virtualization` / `_verify-outline-right` 三条都这样）。
     * 混在一起报 FAIL 的后果是**没人再信红灯**，真回归反而被当成噪音。
     *
     * 口径：重跑一次（**全新实例**），过了记 `FLAKY`（打印出来、不判失败），
     * 两次都红才是 `FAIL` —— 真回归不会因为重跑而变绿。
     */
    let retries = 0
    let firstRun = null
    while (status === 'FAIL' && retries < args.retry) {
      retries += 1
      if (firstRun === null) firstRun = `${res.pass}/${res.total}`
      if (!selfManaged) {
        const again = startInstance(args.port, userData)
        if (again.code !== 0) break
      }
      const retryRes = runSuite(file, args.port, args.timeoutMs, userData)
      if (retryRes.code === 0 && retryRes.fail === 0 && retryRes.total > 0) {
        status = 'FLAKY'
        res.pass = retryRes.pass
        res.total = retryRes.total
        res.skip = retryRes.skip
      }
    }
    /**
     * ⚠️ **零断言 = NOASSERT，不算通过**（自查报告 H1）。
     *
     * 原来只看退出码：一个套件如果**压根没产出断言**（没打印 `--- N/M PASS` / `TOTAL` 行，
     * 退出 0），终端上显示 `0/0 PASS`，和「全部通过」只差一个数字 —— 于是"绿灯"什么都证明不了。
     * 实测：非默认矩阵里抽样 8 个套件，**8/8 都是 0/0 却被记成 PASS**
     * （`_verify-i18n` / `_verify-editor-menu` / `_verify-export-fix2` / `_verify-alt-menu` /
     * `_verify-toast-tip` / `_verify-notifications` / `_verify-notify-style` / `_verify-cb-no-active-line`）。
     * 现在把它们单列为 NOASSERT 并让整体退出码非零，逼着人**要么修好、要么删掉**；
     * 确实"无事可断言"的套件请写进 EMPTY_OK 并注明理由。
     */
    if (status === 'PASS' && res.total === 0 && !EMPTY_OK.has(file)) status = 'NOASSERT'
    console.log(
      `\r${status} ${file} | ${res.pass}/${res.total}${res.skip ? ` SKIP ${res.skip}` : ''}${
        selfManaged ? '（自管实例）' : ''
      }${devNeeded ? '（需要 dev server）' : ''}${
        status === 'FLAKY' ? `  ← 首次 ${firstRun} 红、重跑绿（环境敏感，不是回归）` : ''
      }${status === 'NOASSERT' ? '  ← 没有产出任何断言，等于没测' : ''}`
    )
    if (status === 'FAIL') {
      const tail = res.raw
        .split('\n')
        .filter((l) => /^FAIL|^ERROR|^TOTAL/.test(l))
        .slice(0, 8)
        .join('\n    ')
      if (tail) console.log('    ' + tail)
    }
    rows.push({ file, status, pass: res.pass, total: res.total, skip: res.skip, firstRun })
    if (!args.keep) await sleep(500)
  }

  const failed = rows.filter((r) => r.status === 'FAIL')
  const pass = rows.filter((r) => r.status === 'PASS')
  const skipped = rows.filter((r) => r.status === 'SKIP')
  const noassert = rows.filter((r) => r.status === 'NOASSERT')
  const flaky = rows.filter((r) => r.status === 'FLAKY')
  if (!args.keep) startInstance(args.port, userData, true) // 收尾：别把实例留在 9222 上
  console.log(
    `\nTOTAL ${rows.length} PASS ${pass.length} FAIL ${failed.length} SKIP ${skipped.length} NOASSERT ${noassert.length} FLAKY ${flaky.length}`
  )
  const skippedAssertions = rows.reduce((n, r) => n + (r.skip || 0), 0)
  if (skippedAssertions)
    console.log(`（另有 ${skippedAssertions} 条断言按环境如实 SKIP —— SKIP 不算失败，见清单 §1.C.1）`)
  if (flaky.length) {
    console.log(
      'FLAKY（重跑绿：环境敏感，未判失败；若某条反复出现在这里，请按"套件不稳"修而不是忽略）' +
        flaky.map((r) => `${r.file}(首次 ${r.firstRun})`).join(', ')
    )
  }
  if (failed.length) console.log('FAILED ' + failed.map((r) => r.file).join(', '))
  if (noassert.length) {
    console.log('NOASSERT（没有产出断言，等于没测）' + noassert.map((r) => r.file).join(', '))
    console.log('  → 修好它，或删掉它；确实无事可断言的请加进 run-suites.js 的 EMPTY_OK 并写理由。')
  }
  // NOASSERT 与 FAIL 一样让命令失败：否则「绿灯」继续骗人
  return failed.length || noassert.length ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('ERROR ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
