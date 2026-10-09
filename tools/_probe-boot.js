'use strict'
// ─── 启动耗时 / 体积基线（可复跑，给「轻量化」改动做前后对照）────────────────────
//
// 为什么单独一个探针而不是默认矩阵里的套件：
//   * 启动耗时是**机器相关量**（磁盘缓存、杀软、其它实例、CPU 频率），把它写成
//     默认矩阵里的硬阈值，红/绿就变成环境噪声；这里按探针档跑（`--probe` 时才判定），
//     并且**自己打印 PASS/FAIL**（阈值给得宽松，只拦"明显退化"）。
//   * 体积类判据（入口 CSS/JS 的 KB、KaTeX 是否进了入口）是**确定量**，那些已经写进
//     `tests/bootBudget.test.mjs` 的单元门禁里，每次 `npm test` 都会守。
//
// 量什么：
//   主进程：`LUMIN_STARTUP_LOG=1` 时 `[startup] <label> t+…ms uptime=…ms` 那些行
//     （app-ready / db-ready / grants-ready / ipc-registered / first-window-created /
//      first-window-painted / first-window-loaded）
//   渲染层：`performance.mark('lumin:*')`（entry-exec / boot-start / settings / shell /
//      files / editor-mounted / editor-bind / decorations-first / css-applied /
//      first-frame / fonts-ready / doc-visible）+ navigation timing + 资源体积/耗时
//   冷启动 = 每次删掉 userData 再起；热启动 = 复用同一份 userData 连起两轮（第二轮计入）
//
// 跑法（**不要**和别的套件同时跑，实例/磁盘会互相干扰）：
//   node tools/_probe-boot.js --tag=before --cold=3 --warm=3
//   node tools/_probe-boot.js --tag=after  --cold=3 --warm=3
// 结果 JSON 落在 %TEMP%\lumin-boot-<tag>.json（含每一轮的原始 marks，便于复核）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), 'lumin-boot-ud')
const PORT = Number(process.env.LUMIN_BOOT_PORT || 9226)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  })
)
const TAG = args.get('tag') || 'run'
const COLD = Number(args.get('cold') || 3)
const WARM = Number(args.get('warm') || 2)
/** 阈值（宽松，只拦明显退化；绝对值随机器变，所以报告里以**相对差**为主） */
const BUDGET = {
  coldEditorMs: Number(args.get('budget-cold-editor-ms') || 2600),
  warmEditorMs: Number(args.get('budget-warm-editor-ms') || 2200),
  entryCssKB: Number(args.get('budget-entry-css-kb') || 160),
  startupFontBytes: Number(args.get('budget-startup-font-bytes') || 1024)
}

function ps(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true
  })
}

async function fetchJson(url) {
  const res = await fetch(url)
  return res.json()
}

/**
 * 清场：只杀**本探针自己的**实例（`lumin-boot-ud` / `lumin-startup-ud`）。
 *
 * 为什么不杀所有 lumin 实例：同机可能同时跑着**别人的**隔离实例或用户自己的 Lumin
 * （`%APPDATA%\lumin`）—— 把它们杀掉既无礼也会毁掉别人的验证。代价是要如实说明：
 * 如果测量期间有别的实例在吃 CPU/磁盘，绝对值会偏悲观（做 A/B 对照时两边条件相同，
 * 所以**差值**仍然可用；报告里会写清）。
 */
async function cleanSlate(wipeUserData) {
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*lumin-boot-ud*' -or $_.CommandLine -like '*lumin-startup-ud*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  )
  await sleep(700)
  for (let i = 0; i < 20; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      await sleep(400)
    } catch {
      break
    }
  }
  if (wipeUserData && fs.existsSync(USER_DATA)) {
    ps(`cmd.exe /c rmdir /s /q "${USER_DATA}"`)
    await sleep(250)
  }
}

async function waitPage(timeoutMs = 40000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {
      /* 端口没起来 */
    }
    await sleep(25)
  }
  throw new Error('等待页面超时')
}

async function attach(page) {
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = () => rej(new Error('CDP 连接失败'))
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value
  }
  return { sock, send, ev, close: () => sock.close() }
}

const PINIA = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return null
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  return vals.find((v) => v && typeof v === 'object' && v._s instanceof Map) ?? null
})()`

/** 只统计**本实例**的 electron 进程（别把用户自己的 Lumin / 别的隔离实例算进来） */
function electronRssMB() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "$p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*lumin-boot-ud*' }; if ($p) { ($p | ForEach-Object { $_.WorkingSetSize } | Measure-Object -Sum).Sum } else { 0 }"
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  return Math.round((Number(String(r.stdout || '0').trim()) || 0) / 1048576)
}

/** 入口（index.html 真正引用的那份 CSS/JS）体积：从**构建产物**读，页面里的
 *  `performance.getEntriesByType('resource')` 在这个应用里恒为空数组（离线 file:// 的老问题），
 *  所以体积只能从磁盘量 —— 这也正好是"入口 CSS 有没有把 KaTeX 拖进来"的可判定判据。 */
function entryAssets() {
  const htmlPath = path.join(ROOT, 'out', 'renderer', 'index.html')
  const assetDir = path.join(ROOT, 'out', 'renderer', 'assets')
  const out = { css: null, js: null, cssKB: null, jsKB: null, katexCssInEntry: null, fontFiles: 0, fontBytes: 0 }
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8')
    const css = /href="\.\/assets\/([^"]+\.css)"/.exec(html)
    const js = /src="\.\/assets\/([^"]+\.js)"/.exec(html)
    if (css) {
      out.css = css[1]
      const p = path.join(assetDir, css[1])
      out.cssKB = Math.round(fs.statSync(p).size / 1024)
      const text = fs.readFileSync(p, 'utf-8')
      // KaTeX 的 CSS 有它自己的类名前缀与那 59 条 @font-face
      // 只认 KaTeX **自己的**痕迹：那 59 条 @font-face 的字体名是 `KaTeX_*`。
      // （别用 `.katex` 当判据 —— 那是我们自己在 markdown.css 里写的覆盖规则，到处都有。）
      out.katexCssInEntry = /KaTeX_/.test(text)
    }
    if (js) {
      out.js = js[1]
      out.jsKB = Math.round(fs.statSync(path.join(assetDir, js[1])).size / 1024)
    }
    // 字体文件总量（KaTeX 那 60 个）
    for (const f of fs.readdirSync(assetDir)) {
      if (!/\.(woff2?|ttf)$/i.test(f)) continue
      out.fontFiles += 1
      out.fontBytes += fs.statSync(path.join(assetDir, f)).size
    }
  } catch (e) {
    out.error = e && e.message
  }
  return out
}

/**
 * 页面里读一次完整时间线（marks + navigation timing + 字体请求 + 堆）。
 *
 * 注意**不读** `performance.getEntriesByType('resource')` 的体积：本项目里它恒为空
 * （离线 file://），拿它做判据只会永远"通过"，是假绿 —— 体积一律从磁盘量（见 `entryAssets`）。
 */
const READ_TIMELINE = `(() => {
  const marks = {}
  for (const m of performance.getEntriesByType('mark')) {
    const k = m.name.replace(/^lumin:/, '')
    if (!(k in marks)) marks[k] = Math.round(m.startTime)
  }
  const nav = performance.getEntriesByType('navigation')[0]
  const res = performance.getEntriesByType('resource')
  const fonts = res.filter((r) => /\\.(woff2?|ttf)$/i.test(String(r.name)))
  return JSON.stringify({
    marks,
    fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime ?? null,
    nav: nav ? { domInteractive: Math.round(nav.domInteractive), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), responseEnd: Math.round(nav.responseEnd) } : null,
    resTotal: res.length,
    fontCount: fonts.length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
  })
})()`

async function oneRun(idx, cold) {
  await cleanSlate(cold)
  const outLog = path.join(os.tmpdir(), `lumin-boot-${TAG}-${idx}-out.log`)
  const errLog = path.join(os.tmpdir(), `lumin-boot-${TAG}-${idx}-err.log`)
  const t0 = Date.now()
  ps(
    `$env:LUMIN_DEBUG_PORT='${PORT}'; $env:LUMIN_STARTUP_LOG='1'; Remove-Item Env:\\ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue; ` +
      `Start-Process -FilePath '${path.join(ROOT, 'node_modules\\.bin\\electron.cmd')}' ` +
      `-ArgumentList '.', '--user-data-dir=${USER_DATA}' -WorkingDirectory '${ROOT}' ` +
      `-RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'`
  )
  const page = await waitPage()
  const tPage = Date.now()
  const app = await attach(page)
  const age = await app.ev('Math.round(performance.now())')
  if (typeof age === 'number' && age > 15000) throw new Error(`拿到旧页面（performance.now=${age}ms），本轮作废`)

  // 等「启动完成」：ui.booting === false && 编辑器实例在
  let tBoot = 0
  let tEditor = 0
  let timeline = null
  const end = Date.now() + 30000
  while (Date.now() < end) {
    const st = await app
      .ev(`(() => {
        const pinia = ${PINIA}
        const ui = pinia && pinia._s.get('ui')
        const ed = pinia && pinia._s.get('editor')?.instance
        return JSON.stringify({ booting: ui ? ui.booting : 'no-ui', editor: !!ed })
      })()`)
      .then((s) => (s ? JSON.parse(s) : null))
      .catch(() => null)
    if (st && st.booting === false) {
      if (!tBoot) tBoot = Date.now()
      if (st.editor) {
        tEditor = Date.now()
        break
      }
    }
    await sleep(25)
  }
  // 时间线在**一切就绪之后**再读一次：marks 是只增的，这样能拿到最早的 css-ready 等
  await sleep(120)
  timeline = JSON.parse(await app.ev(READ_TIMELINE))

  /**
   * 顺手验一件**正确性**事（第十二轮把 KaTeX 样式改成按需加载，会不会把公式弄坏）：
   * 插一条行内公式、等一小会儿，再看 `.katex` 的计算字体是不是 KaTeX 自己的字体族，
   * 以及页面里有没有那份按需 CSS。少了 CSS，`.katex` 的 `font-family` 会落回 Inter
   * —— 那是"公式排版错"而不是"慢"，必须能被这个探针抓到（不是靠人眼看截图）。
   */
  let formulaStyle = null
  try {
    await app.ev(`(() => {
      const pinia = ${PINIA}
      const ed = pinia && pinia._s.get('editor')?.instance
      if (!ed) return 'no-editor'
      ed.commands.insertContent(' $x^2$ ')
      return 'ok'
    })()`)
    await sleep(700)
    const raw = await app.ev(`(() => {
      const el = document.querySelector('.katex')
      const links = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href') || '')
      return JSON.stringify({
        hasKatex: !!el,
        fontFamily: el ? getComputedStyle(el).fontFamily : null,
        katexLinks: links.filter((h) => /katex/i.test(h)).length,
        fontFacesReady: document.fonts ? document.fonts.status : null
      })
    })()`)
    formulaStyle = raw ? JSON.parse(raw) : null
  } catch (e) {
    formulaStyle = { error: String((e && e.message) || e) }
  }
  const rssMB = electronRssMB()
  app.close()

  // 主进程那些行（t+ 是相对主进程 startupT0=模块加载完 的时刻；uptime 是进程真实年龄）
  let mainLines = []
  try {
    mainLines = fs
      .readFileSync(outLog, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('[startup]'))
      .map((l) => l.trim())
  } catch {
    /* 读不到就算了，报告里会显示空 */
  }

  return {
    run: idx,
    cold,
    pageMs: tPage - t0,
    bootMs: tBoot ? tBoot - t0 : null,
    editorMs: tEditor ? tEditor - t0 : null,
    rssMB,
    timeline,
    formulaStyle,
    assets: entryAssets(),
    mainLines
  }
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.floor(v.length / 2)]
}

function summarize(rows, label) {
  const pick = (fn) => rows.map(fn).filter((x) => typeof x === 'number')
  const mark = (name) => median(rows.map((r) => r.timeline?.marks?.[name]))
  return {
    label,
    runs: rows.length,
    pageMs: median(pick((r) => r.pageMs)),
    bootMs: median(pick((r) => r.bootMs)),
    editorMs: median(pick((r) => r.editorMs)),
    rssMB: median(pick((r) => r.rssMB)),
    heapMB: median(pick((r) => r.timeline?.heapMB)),
    fcp: median(pick((r) => r.timeline?.fcp)),
    domInteractive: median(pick((r) => r.timeline?.nav?.domInteractive)),
    marks: {
      'entry-exec': mark('entry-exec'),
      'boot-start': mark('boot-start'),
      settings: mark('settings'),
      shell: mark('shell'),
      files: mark('files'),
      'editor-mounted': mark('editor-mounted'),
      'editor-bind': mark('editor-bind'),
      'decorations-first': mark('decorations-first'),
      'css-ready': mark('css-ready'),
      'first-frame': mark('first-frame'),
      'fonts-ready': mark('fonts-ready'),
      'doc-visible': mark('doc-visible'),
      'idle-tasks-started': mark('idle-tasks-started'),
      notifications: mark('notifications'),
      'editor-menu': mark('editor-menu')
    },
    entryCssKB: median(rows.map((r) => r.assets?.cssKB)),
    entryJsKB: median(rows.map((r) => r.assets?.jsKB)),
    katexCssInEntry: rows.every((r) => r.assets?.katexCssInEntry === true),
    fontFiles: median(rows.map((r) => r.assets?.fontFiles)),
    fontBytesOnDisk: median(rows.map((r) => r.assets?.fontBytes)),
    startupFontCount: median(rows.map((r) => r.timeline?.fontCount))
  }
}

/** 主进程两条相邻 mark 之间的耗时（t+ 是相对量，差值才是区间） */
function mainPhases(rows) {
  const phases = {}
  const labels = rows.map((r) => r.mainLines)
  const all = new Set(
    labels.flat().map((l) => (/\][ ]([a-z-]+) t\+/.exec(l) || [])[1]).filter(Boolean)
  )
  for (const label of all) {
    const times = rows
      .map((r) => {
        const line = r.mainLines.find((l) => l.includes(`] ${label} t+`))
        const m = line && /t\+(\d+)ms uptime=(\d+)ms/.exec(line)
        return m ? { t: Number(m[1]), up: Number(m[2]) } : null
      })
      .filter(Boolean)
    phases[label] = { t: median(times.map((x) => x.t)), uptime: median(times.map((x) => x.up)) }
  }
  return phases
}

async function main() {
  const coldRows = []
  const warmRows = []
  console.log(`## 启动基线 tag=${TAG} 冷启动 ${COLD} 轮 / 热启动 ${WARM} 轮（端口 ${PORT}）`)
  for (let i = 1; i <= COLD; i++) {
    try {
      const r = await oneRun(`cold${i}`, true)
      coldRows.push(r)
      console.log(
        `冷#${i} 页面 ${r.pageMs}ms | 首屏可用 ${r.bootMs}ms | 编辑器就绪 ${r.editorMs}ms |RSS ${r.rssMB}MB | 堆 ${r.timeline?.heapMB}MB | CSS ${r.timeline?.entry?.find((e) => e.n.endsWith('.css'))?.kb}KB | 字体 ${r.timeline?.fontCount} 个 ${Math.round((r.timeline?.fontBytes || 0) / 1024)}KB`
      )
      console.log('    marks ' + JSON.stringify(r.timeline?.marks))
    } catch (e) {
      console.log(`冷#${i} 失败：${e && e.message}`)
    }
  }
  // 热启动：**第一轮**把 profile 养起来（不计入），之后 WARM 轮复用同一份 userData
  if (WARM > 0) {
    try {
      await oneRun('warmup', false)
    } catch (e) {
      console.log(`热启动预热失败：${e && e.message}`)
    }
    for (let i = 1; i <= WARM; i++) {
      try {
        const r = await oneRun(`warm${i}`, false)
        warmRows.push(r)
        console.log(
          `热#${i} 页面 ${r.pageMs}ms | 首屏可用 ${r.bootMs}ms | 编辑器就绪 ${r.editorMs}ms |RSS ${r.rssMB}MB | 堆 ${r.timeline?.heapMB}MB`
        )
        console.log('    marks ' + JSON.stringify(r.timeline?.marks))
      } catch (e) {
        console.log(`热#${i} 失败：${e && e.message}`)
      }
    }
  }
  await cleanSlate(false)

  const cold = summarize(coldRows, 'cold')
  const warm = summarize(warmRows, 'warm')
  const mainCold = mainPhases(coldRows)
  console.log('SUMMARY ' + JSON.stringify({ tag: TAG, cold, warm, mainPhases: mainCold }))

  // 自判（探针档用）：只拦"明显退化"，绝对值随机器变
  const checks = [
    ['冷启动编辑器就绪 ≤ ' + BUDGET.coldEditorMs + 'ms', cold.editorMs !== null && cold.editorMs <= BUDGET.coldEditorMs, cold.editorMs],
    ['热启动编辑器就绪 ≤ ' + BUDGET.warmEditorMs + 'ms', warm.editorMs === null || warm.editorMs <= BUDGET.warmEditorMs, warm.editorMs],
    ['入口 CSS ≤ ' + BUDGET.entryCssKB + 'KB', cold.entryCssKB !== null && cold.entryCssKB <= BUDGET.entryCssKB, cold.entryCssKB],
    ['入口 CSS 里没有 KaTeX 的 @font-face', cold.katexCssInEntry === false, cold.katexCssInEntry],
    [
      'KaTeX 样式按需就位（.katex 的 font-family 是 KaTeX 的）',
      (coldRows[0]?.formulaStyle?.fontFamily || '').toLowerCase().includes('katex') &&
        (coldRows[0]?.formulaStyle?.katexLinks || 0) > 0,
      coldRows[0]?.formulaStyle ?? null
    ]
  ]
  for (const [name, ok, value] of checks) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' | 实测 ' + JSON.stringify(value))
  }
  const out = path.join(os.tmpdir(), `lumin-boot-${TAG}.json`)
  fs.writeFileSync(out, JSON.stringify({ summary: { tag: TAG, cold, warm, mainPhases: mainCold }, coldRows, warmRows }, null, 2), 'utf-8')
  console.log('saved ' + out)
  return checks.every(([, ok]) => ok) ? 0 : 1
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('ERROR ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
