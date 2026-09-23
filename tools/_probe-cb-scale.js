'use strict'
// ─── P0 探针：大文档（N 个代码围栏）打开耗时 / CM 实例数 / 常驻内存 ───────────────
//
// 施工图《Lumin-F项实施方案-代码块CM虚拟化》的 P0「观测与护栏」：先把**可复现的数字**
// 固定下来，后面每个阶段都拿同一支探针比。目标（施工图给出的验收线）：
//   * 500 个围栏的文档：**打开 ≤2s**
//   * 1500 个围栏：**打开 ≤5s**
//   * 进程常驻内存回到 **<600MB**
//   * 交互与现在完全一致（那部分由 `_verify-cb-virtualization.js` / `_regress-cb*` 守）
//
// 为什么这样量：
//   * **走真实文件打开**（`files().openPath()`，真读盘 + 真解码 + 真判定 heavyMode），
//     不用探针常用的 `files.current = {...}` 直接赋值 —— 后者绕开了打开路径；
//   * **每个尺寸一个全新隔离实例**：内存必须这么量。同一实例里连着开两篇（500 再 1500）时
//     第二篇的「打开前 RSS」里还背着上一篇的堆（实测 673MB 起步），拿它当基线等于把上一轮的
//     账记到这一轮头上。`_probe-startup.js` 也是每轮起新实例；
//   * 打开时间分两段报：`open`（openPath 返回）与 `render`（块 DOM 稳定）。CDP 的
//     Runtime.evaluate 会阻塞到主线程空闲，所以 openPath 的 await 本身就含了绝大部分装载；
//     `render` 补上 NodeView 挂载与首屏排版那一段；
//   * heavyMode（≥200 围栏自动进源码模式）会把「打开」变成源码模式的开销 —— 探针照实报
//     `heavy` 与**切回渲染面**的耗时，绝不拿源码模式的数字冒充渲染面。
//
// 内存：只统计命令行里带本实例 userData 的 electron 进程（用户自己的 Lumin 实例不算进来，
// 实测不加这条会虚高几百 MB）。
//
// 用法（探针不在默认矩阵里，必须点名；每个尺寸约 15s）：
//   node tools/run-suites.js --suite=_probe-cb-scale.js --timeout=2400000
//   LUMIN_PROBE_FENCES=500,1500   # 默认 500
//   LUMIN_PROBE_TAG=before        # 产物落 out/_probe-cb-scale-<tag>.txt
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { connect, settle, sleep, fatal } = require('./lib/harness')

const SIZES = (process.env.LUMIN_PROBE_FENCES || '500')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const TAG = process.env.LUMIN_PROBE_TAG || 'x'
const PROBE_PORT = Number(process.env.LUMIN_PROBE_PORT || 9224)
const REPO = path.resolve(__dirname, '..')
const TOOLS = __dirname

/** 造 n 个围栏（每块约 40 字符，与「36k 字符 / 500 块」同量级） */
function fencesMd(n) {
  return Array.from({ length: n }, (_, i) => '```js\nfunction f' + i + '() {\n  return ' + i + '\n}\n```\n\n').join('')
}

/** 杀掉命令行里带这个 userData 的 electron（只碰本探针自己的实例） */
function killInstance(ud) {
  const token = path.basename(ud)
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${token}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true
  })
}

/** 本实例的 electron 常驻内存（MB）+ 进程数 */
function appRss(ud) {
  const token = path.basename(ud)
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${token}*' }; ` +
    `if ($p) { "$(($p | Measure-Object WorkingSetSize -Sum).Sum) $($p.Count)" } else { "0 0" }`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })
  const [sum, count] = String(r.stdout || '0 0').trim().split(/\s+/)
  return { mb: Math.round((Number(sum) || 0) / 1048576), procs: Number(count) || 0 }
}

/** 起一个全新隔离实例（输出重定向到文件：直接管道会把 launcher 的 Start-Process 挂住） */
function startInstance(ud, port) {
  const log = path.join(os.tmpdir(), `lumin-cbscale-${path.basename(ud)}.log`)
  const fd = fs.openSync(log, 'w')
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(TOOLS, 'start-isolated.ps1'),
      '-UserData',
      ud,
      '-Port',
      String(port)
    ],
    { cwd: REPO, stdio: ['ignore', fd, fd] }
  )
  fs.closeSync(fd)
  return r.status === 0
}

const SHAPE = `(() => {
  const blocks = [...document.querySelectorAll('.code-block-wrapper')]
  const first = blocks[0]
  // 文本节点也要数：DOM 节点统计里 option/gutter/code 的文本子节点占一半，
  // 只数元素会低估一倍（第一版就被这个差了一倍）。
  let texts = 0
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) texts += 1
  return JSON.stringify({
    blocks: blocks.length,
    cm: blocks.filter((b) => b.querySelector('.cm-editor')).length,
    static: blocks.filter((b) => b.querySelector('.cb-static')).length,
    options: document.querySelectorAll('.code-block-select option').length,
    elems: document.getElementsByTagName('*').length,
    texts,
    firstElems: first ? first.querySelectorAll('*').length + 1 : 0,
    firstHtml: first ? first.outerHTML.length : 0,
    mode: window.__L.ui().editorMode,
    heavy: window.__L.files().heavyMode
  })
})()`

const shape = async (ev) => JSON.parse(await ev(SHAPE))

/**
 * 归因用的渲染进程指标（`Performance.getMetrics`）。
 * 光看 RSS 只能知道「涨了 400MB」，看不出涨在 DOM / 样式 / 堆 —— 这一组才有指向性：
 * `Nodes`（元素+文本+注释）、`LayoutObjects`、`JSEventListeners`、`JSHeapUsedSize`、
 * `Documents`。P2/P3 的每一刀都对着其中一个砍，砍完再看数字。
 */
async function rendererMetrics(app) {
  try {
    await app.send('Performance.enable')
    const r = await app.send('Performance.getMetrics')
    const map = {}
    for (const m of r.result?.metrics ?? []) map[m.name] = m.value
    return {
      nodes: map.Nodes ?? null,
      layoutObjects: map.LayoutObjects ?? null,
      listeners: map.JSEventListeners ?? null,
      heapMB: map.JSHeapUsedSize ? Math.round(map.JSHeapUsedSize / 1048576) : null,
      documents: map.Documents ?? null
    }
  } catch {
    return null
  }
}

/**
 * 等「块 DOM 稳定」：块数到齐 + 连续两次采样的挂载/静态数完全一致。
 * 不用固定 sleep，否则慢机器上量到的是半截状态。
 */
async function waitStable(ev, want, t0, budgetMs = 120000) {
  let last = null
  let same = 0
  let cmMax = 0
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    const s = await shape(ev)
    cmMax = Math.max(cmMax, s.cm)
    if (s.blocks >= want && last && s.cm === last.cm && s.static === last.static) same += 1
    else same = 0
    last = s
    if (same >= 2) return { ms: Date.now() - t0, shape: s, cmMax }
    await sleep(120)
  }
  return { ms: null, shape: last, cmMax, timedOut: true }
}

/** 源码模式下没有 .code-block-wrapper：别在这儿空等（第一版就白等了 120s/尺寸） */
async function waitSource(ev, t0, budgetMs = 120000) {
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    if ((await ev(`!!document.querySelector('textarea.source-editor')`)) === true)
      return Date.now() - t0
    await sleep(120)
  }
  return null
}

async function oneSize(n) {
  const ud = path.join(os.tmpdir(), `lumin-cbscale-${process.pid}-${n}`)
  fs.rmSync(ud, { recursive: true, force: true })
  killInstance(ud)
  await sleep(400)
  if (!startInstance(ud, PROBE_PORT)) throw new Error(`隔离实例起不来：${n}`)

  const app = await connect({ port: PROBE_PORT })
  const { ev } = app
  if (!(await settle(ev))) throw new Error(`实例未就绪：${n}`)
  await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(300)

  const md = fencesMd(n)
  const dir = path.join(os.tmpdir(), 'lumin-cb-scale')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `fences-${n}.md`)
  fs.writeFileSync(file, md, 'utf-8')

  const metricsBefore = await rendererMetrics(app)
  const rssBefore = appRss(ud)
  const t0 = Date.now()
  const opened = await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(file)}); return 'ok' })()`
  )
  const openMs = Date.now() - t0
  const first = await shape(ev)
  let afterOpen
  if (first.mode === 'source') {
    // 源码模式：等它把 textarea/CM 挂出来，别等代码块
    afterOpen = { ms: await waitSource(ev, t0), shape: first, cmMax: 0, sourceMode: true }
  } else {
    afterOpen = await waitStable(ev, n, t0)
  }

  // heavyMode 时渲染面的数字要单独量（施工图的目标说的是渲染面）
  let wysiwyg = null
  if (first.mode === 'source') {
    const t1 = Date.now()
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    const wr = await waitStable(ev, n, t1)
    wysiwyg = { ms: wr.ms, shape: wr.shape, cmMax: wr.cmMax }
  }
  await sleep(800)
  const rssAfter = appRss(ud)
  const metricsAfter = await rendererMetrics(app)
  const finalShape = await shape(ev)

  const renderShape = wysiwyg?.shape ?? afterOpen.shape
  const row = {
    n,
    chars: md.length,
    opened,
    openMs,
    renderMs: afterOpen.ms,
    cm: renderShape?.cm ?? null,
    static: renderShape?.static ?? null,
    options: renderShape?.options ?? null,
    elems: renderShape?.elems ?? null,
    texts: renderShape?.texts ?? null,
    firstElems: renderShape?.firstElems ?? null,
    firstHtml: renderShape?.firstHtml ?? null,
    cmMax: Math.max(afterOpen.cmMax ?? 0, wysiwyg?.cmMax ?? 0),
    heavy: finalShape.heavy === true,
    openMode: first.mode,
    wysiwygMs: wysiwyg?.ms ?? null,
    rssBeforeMB: rssBefore.mb,
    rssAfterMB: rssAfter.mb,
    procs: rssAfter.procs,
    metricsBefore,
    metricsAfter,
    // 施工图的验收线：打开 ≤2s(500) / ≤5s(1500)
    targetMs: n >= 1000 ? 5000 : 2000
  }
  // 「能在渲染面用」的耗时：heavyMode 时是 open+切面，否则就是 open+render
  row.usableMs = row.heavy ? (row.wysiwygMs === null ? null : row.openMs + row.wysiwygMs) : (row.openMs + (row.renderMs ?? 0))
  row.withinTarget = row.usableMs !== null && row.usableMs <= row.targetMs
  row.rssWithinTarget = row.rssAfterMB < 600

  app.close()
  killInstance(ud)
  await sleep(600)
  fs.rmSync(ud, { recursive: true, force: true })
  return row
}

async function main() {
  const rows = []
  for (const n of SIZES) {
    console.log(`… 量 ${n} 个围栏（${fencesMd(n).length} 字符）`)
    rows.push(await oneSize(n))
  }

  const lines = [
    '围栏 | 字符 | 打开ms | 渲染ms | 可用ms | 验收线 | CM(峰) | 静态 | select选项 | 打开后模式 | heavy | 切渲染面ms | RSS前/后MB | 验收 | 内存<600 | 进程'
  ]
  for (const r of rows) {
    lines.push(
      [
        r.n,
        r.chars,
        r.openMs,
        r.renderMs ?? 'timeout',
        r.usableMs ?? 'timeout',
        r.targetMs,
        r.cmMax,
        r.static,
        r.options,
        r.openMode,
        r.heavy ? 'yes' : 'no',
        r.wysiwygMs ?? '-',
        `${r.rssBeforeMB}/${r.rssAfterMB}`,
        r.withinTarget ? 'PASS' : 'FAIL',
        r.rssWithinTarget ? 'PASS' : 'FAIL',
        r.procs
      ].join(' | ')
    )
    const b = r.metricsBefore
    const a = r.metricsAfter
    if (b && a) {
      lines.push(
        `     归因: DOM 节点 ${b.nodes}→${a.nodes}（+${a.nodes - b.nodes}, 每块 ${((a.nodes - b.nodes) / r.n).toFixed(1)}）` +
          ` · 元素 ${r.elems} + 文本 ${r.texts} · 首块 ${r.firstElems} 元素/${r.firstHtml} 字符` +
          ` · LayoutObject ${b.layoutObjects}→${a.layoutObjects}` +
          ` · 监听器 ${b.listeners}→${a.listeners}` +
          ` · JS 堆 ${b.heapMB}→${a.heapMB}MB` +
          ` · RSS Δ+${r.rssAfterMB - r.rssBeforeMB}MB（每块 ${(((r.rssAfterMB - r.rssBeforeMB) * 1024) / r.n).toFixed(0)}KB）`
      )
    }
  }
  const text = lines.join('\n')
  console.log('\n' + text)
  const out = path.join(REPO, 'out', `_probe-cb-scale-${TAG}.txt`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text + '\n' + JSON.stringify(rows, null, 2) + '\n', 'utf-8')
  console.log(`产物 → ${out}`)
  console.log('--- 1/1 PASS')
}

main()
  .then(() => process.exit(0))
  .catch(fatal)
