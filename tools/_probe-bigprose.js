'use strict'
// ─── 探针：大**散文**文档的装载/切面耗时与常驻内存（报告 §4.2 / §7.4 的第二个数字）──
//
// 为什么单开一个探针：`_probe-cb-scale.js` / `_probe-fences-total.js` 量的是**代码围栏**
// 文档（瓶颈在块数），而桌面评审报告里还有一条独立的主张 ——「977 KB 文档装载/回灌各 ≈16 s」，
// 那说的是**纯散文**的长文档（瓶颈在字符数/排版）。两者的优化路径完全不同，必须分开量。
//
// 量什么（每一档一个**全新隔离实例**，互不背账）：
//   * `openMs`：`files().openPath()` 返回的耗时（真读盘 + 真解析 + 真判定 heavyMode）；
//   * `renderMs`：DOM 稳定（元素数与 PM doc 尺寸连续两次采样一致）的耗时；
//   * `sourceMs`：切到源码面 + 读到 textarea 内容（"回灌"那一半）；
//   * `backMs`：切回渲染面并再次稳定；
//   * `rssMB`：本实例所有 electron 进程的 WorkingSet 之和。
//
// 用法（探针不在默认矩阵里，必须点名；每档约 20–60s）：
//   node tools/run-suites.js --suite=_probe-bigprose.js --timeout=2400000
//   LUMIN_PROBE_BYTES=977000,1100000   # 默认 977000（≈报告里那份 977 KB 的文档）
//   LUMIN_PROBE_TAG=wave2-before        # 产物落 out/_probe-bigprose-<tag>.txt
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { connect, settle, sleep, fatal } = require('./lib/harness')

const BYTES = (process.env.LUMIN_PROBE_BYTES || '977000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const TAG = process.env.LUMIN_PROBE_TAG || 'x'
const PROFILE = process.env.LUMIN_PROBE_PROFILE === '1'
const PROBE_PORT = Number(process.env.LUMIN_PROBE_PORT || 9226)
const REPO = path.resolve(__dirname, '..')
const TOOLS = __dirname

/**
 * 造一段**真实感**的散文：标题 / 粗斜体 / 列表 / 引用 / 行内代码 / 少量代码块与表格。
 * 目标按**字节数**（不是字符数）对齐报告的口径 —— 中文一个字 3 字节，按字符数凑会差三倍。
 */
function proseMd(bytes) {
  const parts = []
  let i = 0
  while (Buffer.byteLength(parts.join(''), 'utf-8') < bytes) {
    i += 1
    parts.push(
      `## 第 ${i} 节　关于写作与工具的一点体会\n\n` +
        `这是一段用于压测的正文，含**加粗**、*斜体*、\`行内代码\` 与中文标点（，。：；「」）。` +
        `写作工具的价值不在于功能多少，而在于它**不会弄坏你已经写下的东西**：` +
        `原子写、写前留档、编码保真、外部改动可见 —— 这四件事做不到，其余都是装饰。\n\n` +
        `- 第一条：源文件是资产，任何"顺手规范化"都必须可解释、可回退。\n` +
        `- 第二条：本地历史与草稿属于底线能力，不能只放在付费档里。\n` +
        `- 第三条：性能是体验的一部分 —— 卡住的编辑器等于不可用。\n\n` +
        `> 引用块也放一段：把风险挡在"保存路径"与"Markdown 保真"这两件写作工具的信托上。\n\n` +
        `正文继续。${'细节决定可信度。'.repeat(6)}\n\n` +
        (i % 12 === 0
          ? '```js\nconst meaning = 42\nfunction answer() {\n  return meaning\n}\n```\n\n'
          : '') +
        (i % 15 === 0 ? '| 列 A | 列 B |\n| --- | --- |\n| 值 1 | 值 2 |\n\n' : '')
    )
  }
  return parts.join('')
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
  const [sum, count] = String(r.stdout || '0 0')
    .trim()
    .split(/\s+/)
  return { mb: Math.round((Number(sum) || 0) / 1048576), procs: Number(count) || 0 }
}

/** 起一个全新隔离实例（输出重定向到文件：直接管道会把 launcher 的 Start-Process 挂住） */
function startInstance(ud, port) {
  const log = path.join(os.tmpdir(), `lumin-bigprose-${path.basename(ud)}.log`)
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

/**
 * 采样归因：把一段 CPU 采样的**自身时间**按"函数 @ chunk:行"聚合。
 * 用来回答"渲染那 4.4 秒花在谁身上"——是 PM 建 DOM（动不了），还是我们自己的 pass（能优化）。
 */
const INTERESTING =
  /normalizeAtoms|blockInventory|buildRevealDecorations|pushEscape|styleList|collectRuns|collectEscape|appendTransaction|resolveBlockContent|fromAtoms|toAtoms|literalize|recognizeTyped|repairPolluted|reLift|materialize|scanDelims|emphasisTokenize|decorations|apply @|init @|(garbage collector)|Program|compile|parse|MarkdownParser|CodeMirror|EditorView.*constructor|createNodeViews|updateChildren|updateState|updateInner|readDOMChange|cjk|Emphasis|staticHighlight|outline|resolveBlock|computeBlockInventory/

function dumpProfile(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map()
  let total = 0
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i])
    const dt = p.timeDeltas[i] ?? 0
    total += dt
    if (!n) continue
    const cf = n.callFrame
    const key = `${cf.functionName || '(anon)'} @ ${String(cf.url).split('/').pop()}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + dt)
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1])
  const agg = {}
  for (const [k, us] of rows) {
    const kind = /EditorView-/.test(k)
      ? 'app(EditorView chunk)'
      : /index-/.test(k)
        ? 'vendor(index chunk)'
        : /\(program\)|\(garbage collector\)|\(idle\)/.test(k)
          ? k.split(' @')[0]
          : 'other'
    agg[kind] = (agg[kind] ?? 0) + us
  }
  const lines = []
  lines.push(`  采样合计 ${(total / 1000).toFixed(0)}ms`)
  lines.push(
    '  粗分: ' +
      Object.entries(agg)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${(v / 1000).toFixed(0)}ms`)
        .join('  ')
  )
  lines.push('  关注帧:')
  for (const [k, us] of rows) {
    if (INTERESTING.test(k)) lines.push(`    ${(us / 1000).toFixed(1).padStart(9)}ms  ${k}`)
  }
  lines.push('  总 top 15:')
  for (const [k, us] of rows.slice(0, 15))
    lines.push(`    ${(us / 1000).toFixed(1).padStart(9)}ms  ${k}`)
  return lines.join('\n')
}

/** 一帧 DOM/状态快照（元素数 + PM doc 尺寸 + 模式 + **标签/类名构成**） */
const SHAPE = `JSON.stringify((() => {
  const ed = window.__L.ed()
  const tags = {}
  const classes = {}
  for (const el of document.getElementsByTagName('*')) {
    const t = el.tagName.toLowerCase()
    tags[t] = (tags[t] || 0) + 1
    // 只统计带 class 的元素里最常见的前几类（找"谁是 DOM 大头"）
    for (const c of el.classList) classes[c] = (classes[c] || 0) + 1
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  return {
    elems: document.getElementsByTagName('*').length,
    size: ed ? ed.state.doc.content.size : -1,
    mode: window.__L.ui().editorMode,
    heavy: window.__L.files().heavyMode === true,
    topTags: top(tags, 8),
    topClasses: top(classes, 12),
    paragraphs: document.querySelectorAll('.ProseMirror p').length,
    headings: document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length
  }
})())`

const shape = async (ev) => JSON.parse(await ev(SHAPE))

/**
 * 归因用的渲染进程指标（`Performance.getMetrics`）：只看 RSS 只能知道"涨了 700MB"，
 * 看不出涨在 DOM 还是 JS 堆。这一组才有指向性 —— 报告 §4.2 的"常驻 1.4GB"到底该往哪砍。
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

/** 等 DOM 与 PM doc 连续两次采样一致（不靠固定 sleep） */
async function waitStable(ev, t0, budgetMs = 120000) {
  let last = null
  let same = 0
  const end = Date.now() + budgetMs
  while (Date.now() < end) {
    const s = await shape(ev)
    if (last && s.elems === last.elems && s.size === last.size) same += 1
    else same = 0
    last = s
    if (same >= 2) return { ms: Date.now() - t0, shape: s }
    await sleep(120)
  }
  return { ms: null, shape: last, timedOut: true }
}

async function oneSize(bytes) {
  const ud = path.join(os.tmpdir(), `lumin-bigprose-${process.pid}-${bytes}`)
  fs.rmSync(ud, { recursive: true, force: true })
  killInstance(ud)
  await sleep(400)
  if (!startInstance(ud, PROBE_PORT)) throw new Error(`隔离实例起不来：${bytes}`)

  const app = await connect({ port: PROBE_PORT })
  const { ev } = app
  if (!(await settle(ev))) throw new Error(`实例未就绪：${bytes}`)
  await ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(300)

  const md = proseMd(bytes)
  const dir = path.join(os.tmpdir(), 'lumin-bigprose')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `prose-${bytes}.md`)
  fs.writeFileSync(file, md, 'utf-8')
  const realBytes = fs.statSync(file).size

  const rssBefore = appRss(ud)
  const metricsBefore = await rendererMetrics(app)
  if (PROFILE) {
    await app.send('Profiler.enable')
    await app.send('Profiler.setSamplingInterval', { interval: 300 })
    await app.send('Profiler.start')
  }
  const t0 = Date.now()
  await ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(file)}); return 'ok' })()`
  )
  const openMs = Date.now() - t0
  const first = await shape(ev)

  /**
   * 两种入口各量各的（波次 2 的关键口径）：
   *   * 降级文档（heavy）**默认**进源码面 —— 用户真正等的时间是"open + 源码面就绪"，
   *     这时**不**去切渲染面（切了就等于把那份 1.2GB 的内存又算回它头上，冤枉）；
   *   * 正常文档默认进渲染面 —— 等到 DOM 稳定。
   * 想量"用户硬要切回渲染面"的代价，加 `LUMIN_PROBE_SWITCH=1`。
   */
  const SWITCH = process.env.LUMIN_PROBE_SWITCH === '1'
  let sourceReadyMs = null
  let rssAfterEntry = null
  let wysiwyg = null
  if (first.mode === 'source') {
    const ts = Date.now()
    for (let i = 0; i < 100; i++) {
      const ready = await ev(`!!document.querySelector('textarea.source-editor')`)
      if (ready === true) break
      await sleep(100)
    }
    sourceReadyMs = Date.now() - ts
    await sleep(600)
    rssAfterEntry = appRss(ud)
    if (SWITCH) {
      const t1 = Date.now()
      await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
      wysiwyg = await waitStable(ev, t1)
    }
  } else {
    wysiwyg = await waitStable(ev, t0)
    rssAfterEntry = appRss(ud)
  }
  const renderMs = first.mode === 'source' ? (wysiwyg ? wysiwyg.ms : null) : wysiwyg.ms

  // 回灌：读 textarea（真源）。降级文档本来就在源码面，不必来回切。
  // 非降级文档才切一次源码面再切回来，量"回灌"那两段。
  const t2 = Date.now()
  let ta = null
  if (first.mode === 'source') {
    ta = await ev(
      `(() => { const t = document.querySelector('textarea.source-editor'); return t ? t.value.length : -1 })()`
    )
  } else {
    await ev(`(() => { window.__L.ui().editorMode = 'source'; return 'ok' })()`)
    for (let i = 0; i < 100; i++) {
      ta = await ev(
        `(() => { const t = document.querySelector('textarea.source-editor'); return t ? t.value.length : -1 })()`
      )
      if (Number(ta) > 0) break
      await sleep(120)
    }
  }
  const sourceMs = Date.now() - t2
  let backMs = null
  if (first.mode !== 'source') {
    const t3 = Date.now()
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    const back = await waitStable(ev, t3)
    backMs = back.ms ?? -1
  }

  await sleep(800)
  const rssAfter = appRss(ud)
  const metricsAfter = await rendererMetrics(app)
  const finalShape = await shape(ev)
  let profileText = ''
  if (PROFILE) {
    const prof = await app.send('Profiler.stop')
    const pf = path.join(REPO, 'out', `_probe-bigprose-${TAG}-${realBytes}.cpuprofile`)
    fs.writeFileSync(pf, JSON.stringify(prof.result.profile))
    profileText = dumpProfile(pf)
  }

  const row = {
    bytes: realBytes,
    chars: md.length,
    openMs,
    /** 降级文档默认进源码面：这就是"默认可用"的耗时（null = 没量/不需要） */
    defaultUsableMs:
      first.mode === 'source' ? openMs + (sourceReadyMs ?? 0) : openMs + (renderMs ?? 0),
    renderMs,
    entryMode: first.mode,
    sourceReadyMs,
    sourceMs,
    textareaChars: Number(ta) || 0,
    backMs,
    totalMs: openMs + (renderMs ?? 0) + sourceMs + (backMs ?? 0),
    rssBeforeMB: rssBefore.mb,
    /** 入口刚稳定后的常驻（降级文档这里**不含**渲染面那份 DOM） */
    rssAfterEntryMB: rssAfterEntry?.mb ?? null,
    rssAfterMB: rssAfter.mb,
    procs: rssAfter.procs,
    metricsBefore,
    metricsAfter,
    heavy: finalShape.heavy === true,
    elems: finalShape.elems,
    docSize: finalShape.size,
    topTags: finalShape.topTags ?? null,
    topClasses: finalShape.topClasses ?? null,
    paragraphs: finalShape.paragraphs ?? null,
    headings: finalShape.headings ?? null,
    // 报告 §7.4 A 的验收线：977 KB 装载 ≤5s（按**默认入口**算，不按"用户硬要渲染"算）
    targetMs: 5000,
    withinTarget:
      (first.mode === 'source' ? openMs + (sourceReadyMs ?? 0) : openMs + (renderMs ?? 0)) <= 5000,
    rssWithinTarget: (rssAfterEntry?.mb ?? rssAfter.mb) < 800,
    profile: profileText || null
  }

  app.close()
  killInstance(ud)
  await sleep(600)
  fs.rmSync(ud, { recursive: true, force: true })
  return row
}

async function main() {
  const rows = []
  for (const n of BYTES) {
    console.log(`… 量 ${Math.round(n / 1024)}KB 散文`)
    rows.push(await oneSize(n))
  }
  const lines = rows.map(
    (r) =>
      `[${TAG}] bytes=${r.bytes} chars=${r.chars} 入口=${r.entryMode} heavy=${r.heavy} ` +
      `open=${r.openMs}ms 默认可用=${r.defaultUsableMs}ms(源码就绪=${r.sourceReadyMs}ms 渲染=${r.renderMs}ms) ` +
      `回灌=${r.sourceMs}ms(textarea=${r.textareaChars}) 切回=${r.backMs}ms ` +
      `RSS=${r.rssBeforeMB}→入口${r.rssAfterEntryMB}MB→末${r.rssAfterMB}MB(${r.procs} 进程) ` +
      `堆=${r.metricsAfter?.heapMB ?? '?'}MB ` +
      `DOM节点=${r.metricsAfter?.nodes ?? '?'} 布局对象=${r.metricsAfter?.layoutObjects ?? '?'} ` +
      `监听器=${r.metricsAfter?.listeners ?? '?'} heavy=${r.heavy} elems=${r.elems} ` +
      `入口=${r.entryMode} 验收≤${r.targetMs}ms ${r.withinTarget ? 'PASS' : 'FAIL'}` +
      `${r.rssWithinTarget ? '' : ' RSS超线'}`
  )
  const text =
    lines.join('\n') +
    rows.map((r) => (r.profile ? `\n--- 采样归因（${r.bytes}）\n${r.profile}` : '')).join('')
  console.log(text)
  fs.writeFileSync(path.join(REPO, 'out', `_probe-bigprose-${TAG}.txt`), text + '\n', 'utf-8')
  fs.writeFileSync(
    path.join(REPO, 'out', `_probe-bigprose-${TAG}.json`),
    JSON.stringify(rows, null, 2),
    'utf-8'
  )
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
