'use strict'
// ─── 冷启动 / 资源占用基线（可重复测量，给「轻量化」改动做前后对照）──────────────
//
// 为什么单独一个工具：`start-isolated.ps1` 末尾自带 3 秒等待，测不了真实冷启动；而
// 「应用变轻了没有」必须有一个**可复现的数字**（不然优化只能靠感觉）。这里自己起实例、
// 自己轮询调试端口，把冷启动拆成三段：
//   t1 = Electron 进程起来 → index.html 出现在 CDP（≈ 主进程启动 + 窗口 + 首帧）
//   t2 = → `ui.booting === false`（渲染层启动完成：store 水合 + 首屏可用）
//   t3 = → 编辑器实例就绪（有文档时才有意义）
// 另外记录：渲染进程的 navigation timing 分项、JS 堆、以及全部 electron 进程的常驻内存。
//
// 跑法：node tools/_probe-startup.js [--runs=3] [--tag=before]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { DEFAULT_PORT } = require('./lib/harness')

const ROOT = path.join(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), 'lumin-startup-ud')
// 用**独立端口**：默认 9222 上可能还挂着手工起的隔离实例（实测踩过 —— 轮询立刻拿到旧页面，
// 量出来的「冷启动 148ms」是假的）。同时把命令行里带 lumin-* 数据目录的旧实例一并清掉。
const PORT = Number(process.env.LUMIN_STARTUP_PORT || 9224)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  })
)
const RUNS = Number(args.get('runs') || 3)
const TAG = args.get('tag') || 'run'

/** 用 PowerShell 起进程（stdio: ignore —— 受限环境下管道 stdio 会 EPERM） */
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

/** 页面（index.html）出现即返回；超时抛错 */
async function waitPage(timeoutMs = 40000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {
      /* 端口还没起来 */
    }
    await sleep(50)
  }
  throw new Error('等待页面超时')
}

/** 连 CDP（只需要 Runtime.evaluate） */
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
    if (r.result?.exceptionDetails) throw new Error('页面异常：' + String(r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  return { sock, send, ev, close: () => sock.close() }
}

/** 全部 electron 进程的常驻内存（KB） */
function electronRss() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "$p = Get-Process electron -ErrorAction SilentlyContinue; if ($p) { ($p | Measure-Object WorkingSet64 -Sum).Sum } else { 0 }"
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  return Number(String(r.stdout || '0').trim()) || 0
}

const PINIA = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return null
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  return vals.find((v) => v && typeof v === 'object' && v._s instanceof Map) ?? null
})()`

async function oneRun(idx) {
  // 清场：把命令行里带 `lumin-` 数据目录的旧实例全杀掉（包含手工起的隔离实例与套件实例），
  // 否则调试端口上会立刻出现**旧页面**，量出来的「冷启动」是假的（实测踩过：148ms）。
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*lumin-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  )
  await sleep(900)
  // 端口必须是空的，否则量的是别人的页面
  let busy = true
  for (let i = 0; i < 20 && busy; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      busy = true
      ps(
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      )
      await sleep(500)
    } catch {
      busy = false
    }
  }
  if (fs.existsSync(USER_DATA)) {
    ps(`cmd.exe /c rmdir /s /q "${USER_DATA}"`)
    await sleep(300)
  }

  const outLog = path.join(os.tmpdir(), `lumin-startup-${idx}-out.log`)
  const errLog = path.join(os.tmpdir(), `lumin-startup-${idx}-err.log`)
  const t0 = Date.now()
  ps(
    `$env:LUMIN_DEBUG_PORT='${PORT}'; Remove-Item Env:\\ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue; ` +
      `Start-Process -FilePath '${path.join(ROOT, 'node_modules\\.bin\\electron.cmd')}' ` +
      `-ArgumentList '.', '--user-data-dir=${USER_DATA}' -WorkingDirectory '${ROOT}' ` +
      `-RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'`
  )

  const page = await waitPage()
  const tPage = Date.now()

  const app = await attach(page)
  // 页面必须是**新**的：performance.now() 还很小才算数（旧页面会 > 10s）
  const age = await app.ev('Math.round(performance.now())').catch(() => null)
  if (typeof age === 'number' && age > 10000) throw new Error(`拿到的是旧页面（performance.now=${age}ms），本次测量作废`)
  let tBoot = 0
  let tEditor = 0
  const end = Date.now() + 30000
  let nav = null
  let heap = null
  let marks = null
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
      if (!tBoot) {
        tBoot = Date.now()
        const info = await app
          .ev(`(() => {
            const n = performance.getEntriesByType('navigation')[0]
            return JSON.stringify({
              domInteractive: n ? Math.round(n.domInteractive) : null,
              domContentLoaded: n ? Math.round(n.domContentLoadedEventEnd) : null,
              loadEnd: n ? Math.round(n.loadEventEnd) : null,
              firstPaint: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime ?? null,
              marks: performance.getEntriesByType('mark').map((m) => m.name + '=' + Math.round(m.startTime)),
              measures: performance.getEntriesByType('measure').map((m) => m.name + '=' + Math.round(m.duration)),
              heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
            })
          })()`)
          .catch(() => null)
        if (info) {
          const o = JSON.parse(info)
          nav = o
          heap = o.heapMB
          marks = { marks: o.marks, measures: o.measures }
        }
      }
      if (st.editor) {
        tEditor = Date.now()
        break
      }
    }
    await sleep(40)
  }
  const rss = electronRss()
  app.close()
  return {
    run: idx,
    pageMs: tPage - t0,
    bootMs: tBoot ? tBoot - t0 : null,
    editorMs: tEditor ? tEditor - t0 : null,
    rssMB: rss ? Math.round(rss / 1048576) : null,
    heapMB: heap,
    nav,
    marks
  }
}

async function main() {
  const rows = []
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await oneRun(i)
      rows.push(r)
      console.log(
        `#${i} 页面 ${r.pageMs}ms | 首屏可用 ${r.bootMs}ms | 编辑器就绪 ${r.editorMs}ms | ` +
          `RSS ${r.rssMB}MB | JS 堆 ${r.heapMB}MB`
      )
      const nav = r.nav || {}
      console.log(
        `    nav: domInteractive=${nav.domInteractive} DCL=${nav.domContentLoaded} load=${nav.loadEnd} FCP=${nav.firstPaint}`
      )
      if (r.marks && (r.marks.measures.length || r.marks.marks.length)) {
        console.log(`    marks: ${JSON.stringify(r.marks.marks)} measures: ${JSON.stringify(r.marks.measures)}`)
      }
    } catch (err) {
      console.log(`#${i} 失败：${err && err.message}`)
    }
  }
  const med = (key) => {
    const v = rows.map((r) => r[key]).filter((x) => typeof x === 'number').sort((a, b) => a - b)
    return v.length ? v[Math.floor(v.length / 2)] : null
  }
  const summary = {
    tag: TAG,
    runs: rows.length,
    pageMsMedian: med('pageMs'),
    bootMsMedian: med('bootMs'),
    editorMsMedian: med('editorMs'),
    rssMBMedian: med('rssMB'),
    heapMBMedian: med('heapMB')
  }
  console.log('SUMMARY ' + JSON.stringify(summary))
  const out = path.join(os.tmpdir(), `lumin-startup-${TAG}.json`)
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2), 'utf-8')
  console.log('saved ' + out)
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*lumin-startup-ud*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  )
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('ERROR ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
