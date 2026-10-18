'use strict'
// ─── Lumin 性能基线 / 复测（同一夹具、同一脚本、前后对比）────────────────────────
//
// 隔离实例：ports 9468/9469、userData=%TEMP%\xw-perf-ud（名字不含 lumin）、
// 删除 ELECTRON_RUN_AS_NODE、--disable-features=CalculateNativeWinOcclusion、Page.bringToFront。
// 夹具：真实文档逐字节副本 + 8 倍大文档（见 fixtures.js）。
//
// 跑法（先 `npm run build`，确保 out/ 比 src/ 新）：
//   node tools/perf/run-perf.js --doc=big --out=tmp/perf-before.json --profile
//   node tools/perf/run-perf.js --doc=big --only=drag --profile
//   node tools/perf/run-perf.js --doc=real --out=tmp/perf-real-before.json
//   node tools/perf/run-perf.js --doc=big --toggles
//
// 产出 JSON 里的每个延迟都是**页面内 rAF 计时**：事件发生 → 两帧 rAF（≈ 下一帧画完）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, spawn } = require('child_process')
const { connect, settle, waitEditor, sleep, bringToFront, launchStable, openDocWith } = require(
  path.join(__dirname, '..', 'lib', 'harness')
)
const { build } = require('./fixtures')
const { PROBE_SRC } = require('./probe')

const ROOT = path.join(__dirname, '..', '..')
const TMP = path.join(ROOT, 'tmp')
let UD_LEAF = 'xw-perf-ud'

const args = {}
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  if (m) args[m[1]] = m[2] === undefined ? true : m[2]
}
const DOC = args.doc === 'real' ? 'real' : 'big'
const OUT = path.resolve(ROOT, args.out || path.join('tmp', `perf-${DOC}.json`))
const WANT_PROFILE = !!args.profile
const WANT_TOGGLES = !!args.toggles
const ONLY = String(args.only || 'all')
const WANT_TYPING = ONLY === 'all' || ONLY === 'typing'
const WANT_DRAG = ONLY === 'all' || ONLY === 'drag'
const WANT_SCROLL = ONLY === 'all' || ONLY === 'scroll'
const WANT_TOGGLE_RUN = (WANT_TOGGLES || ONLY === 'toggles') && ONLY !== 'profile'
const WANT_PROFILE_RUN = WANT_PROFILE || ONLY === 'profile'
const PORT = Number(args.port || 9468)
const TAG = args.tag || (DOC === 'real' ? 'real' : 'big')

// 防止"CDP socket 被外部杀掉 → 事件循环空转 → Node 静默 0 退出"（见 harness.attach.onclose）
const keepAlive = setInterval(() => {}, 60000)

const pct = (arr, p) => {
  if (!arr.length) return null
  const a = [...arr].sort((x, y) => x - y)
  const i = (a.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return +(lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo)).toFixed(2)
}
const stats = (arr) => ({
  n: arr.length,
  p50: pct(arr, 0.5),
  p95: pct(arr, 0.95),
  max: arr.length ? +Math.max(...arr).toFixed(2) : null,
  mean: arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null
})
const diffCounts = (a, b) => {
  const out = {}
  for (const k of Object.keys(b || {})) out[k] = (b[k] || 0) - ((a && a[k]) || 0)
  return out
}
const git = (argv) => spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).stdout.trim()

const buildInfo = () => {
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else files.push({ p, m: fs.statSync(p).mtimeMs })
    }
  }
  try {
    walk(path.join(ROOT, 'out', 'renderer'))
  } catch (e) {
    /* ignore */
  }
  const newest = files.sort((a, b) => b.m - a.m)[0]
  const src = []
  const walkSrc = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkSrc(p)
      else src.push({ p, m: fs.statSync(p).mtimeMs })
    }
  }
  try {
    walkSrc(path.join(ROOT, 'src'))
  } catch (e) {
    /* ignore */
  }
  const newestSrc = src.sort((a, b) => b.m - a.m)[0]
  return {
    newestOut: newest
      ? { path: path.relative(ROOT, newest.p), mtime: new Date(newest.m).toISOString() }
      : null,
    newestSrc: newestSrc
      ? { path: path.relative(ROOT, newestSrc.p), mtime: new Date(newestSrc.m).toISOString() }
      : null,
    outNewerThanSrc: !!(newest && newestSrc && newest.m >= newestSrc.m)
  }
}

function raiseWindow(leaf) {
  try {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'raise-window.ps1'),
        '-Leaf',
        leaf
      ],
      { encoding: 'utf8' }
    )
    return (r.stdout || '').trim()
  } catch (e) {
    return ''
  }
}

/**
 * 常驻「把测量窗口钉在最上层」：一次性 `SetWindowPos` 会被并行套件新起的置顶窗口盖掉，
 * 一被遮住 Chromium 就停 rAF（实测样本从 30 掉到 0~3）。这里每 700ms 重新置顶/还原最小化，
 * 直到收尾写 stop 文件。
 */
function startWindowPin(leaf) {
  if (process.platform !== 'win32') return { stop: () => {} }
  const stopFile = path.join(os.tmpdir(), `xw-perf-pin-${process.pid}.stop`)
  try {
    fs.rmSync(stopFile, { force: true })
  } catch (e) {
    /* ignore */
  }
  let child = null
  try {
    child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'pin-window.ps1'),
        '-Leaf',
        leaf,
        '-StopFile',
        stopFile
      ],
      { stdio: 'ignore' }
    )
  } catch (e) {
    child = null
  }
  return {
    stop: () => {
      try {
        fs.writeFileSync(stopFile, 'stop')
      } catch (e) {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child?.kill()
        } catch (e) {
          /* ignore */
        }
      }, 1200)
    }
  }
}

/**
 * 用页面自己的 rAF 计数确认「窗口在出帧」（即需求里的 rafFramesIn500ms）。
 * 不依赖 `window.__RAF` 那个一次性探针：这里直接把 p50 / 帧数写进结果。
 */
async function ensureFrames(app, ms = 400, min = 8) {
  let stats = { n: 0, p50: null, max: null, hz: null }
  for (let i = 0; i < 3; i += 1) {
    try {
      await app.send('Page.setWebLifecycleState', { state: 'active' })
    } catch (e) {
      /* 老版本没有：忽略 */
    }
    try {
      await app.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch (e) {
      /* 忽略 */
    }
    stats = JSON.parse(await app.ev(`(async () => JSON.stringify(await window.__P.idle(${ms})))()`))
    // timedOut = 采样窗口内 rAF 中途停摆 ⇒ 这批数字不可用，即便前几帧看着正常
    if (!stats.timedOut && stats.n >= min) return { ok: true, ...stats }
    raiseWindow(UD_LEAF)
    await bringToFront(app)
    await sleep(500)
  }
  return { ok: false, ...stats }
}

async function assertFrames(app, where) {
  const f = await ensureFrames(app)
  if (!f.ok) throw new Error(`${where}: 窗口不出帧（rAF ${f.n}/${f.p50}ms）——数字会失真`)
  return f
}

function killOwn(ud) {
  const leaf = path.basename(ud)
  const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${leaf}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  } catch (e) {
    /* ignore */
  }
}

const mouse = (send, type, x, y, buttons) =>
  send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1
  })

async function metricsSnapshot(app) {
  try {
    const r = await app.send('Performance.getMetrics')
    const out = {}
    for (const m of r.result?.metrics || []) out[m.name] = m.value
    return out
  } catch (e) {
    return {}
  }
}
const metricsDelta = (a, b) => {
  const out = {}
  for (const k of [
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
    'RecalcStyleDuration',
    'JSHeapUsedSize'
  ]) {
    if (a[k] != null && b[k] != null) out[k] = +(b[k] - a[k]).toFixed(4)
  }
  return out
}

async function ensureEditorFocus(app) {
  await bringToFront(app)
  return await app.ev(`(() => {
    const el = document.activeElement
    return !!(el && el.closest && el.closest('.ProseMirror'))
  })()`)
}

async function collapseSelection(app) {
  await app.ev(`(() => {
    const ed = window.__L.ed()
    const size = ed.state.doc.content.size
    ed.chain().setTextSelection(Math.max(1, size - 2)).run()
    return 'ok'
  })()`)
  await sleep(260)
}

/** 在视口里点一段正文，把光标放进去 */
async function clickIntoText(app, yMin = 150) {
  const pick = await app.ev(
    `(() => { const p = window.__P.pickText(${yMin}, 30); return p ? JSON.stringify(p) : null })()`
  )
  if (!pick) return null
  const p = JSON.parse(pick)
  await mouse(app.send, 'mouseMoved', p.x, p.y, 0)
  await sleep(60)
  await mouse(app.send, 'mousePressed', p.x, p.y, 1)
  await sleep(40)
  await mouse(app.send, 'mouseReleased', p.x, p.y, 0)
  await sleep(280)
  return p
}

async function rawTyping(app, n = 30) {
  const frames = await assertFrames(app, 'typing')
  let t = await clickIntoText(app, 150)
  if (!t) throw new Error('typing: 视口里找不到可点的正文段落')
  // 关键：activeElement 是 PM 不代表**窗口**有焦点（被遮挡时 CDP 注入会被丢掉）。
  // 先确认 document.hasFocus()，再用一次真实插入验证「字真的进去了」，否则重来一遍。
  let probeOk = false
  let size0 = 0
  for (let attempt = 0; attempt < 3 && !probeOk; attempt += 1) {
    await bringToFront(app)
    if (!(await app.ev(`document.hasFocus()`))) {
      raiseWindow(UD_LEAF)
      await sleep(400)
    }
    t = (await clickIntoText(app, 150)) || t
    if (!(await ensureEditorFocus(app))) continue
    size0 = await app.ev(`window.__L.ed().state.doc.content.size`)
    await app.send('Input.insertText', { text: 'a' })
    await sleep(140)
    const size1 = await app.ev(`window.__L.ed().state.doc.content.size`)
    probeOk = size1 > size0
    if (!probeOk) {
      // 这一下没进去：把光标挪到另一个段落再试（有些块是原子/只读）
      await collapseSelection(app)
      await app.ev(`(() => {
        const ed = window.__L.ed()
        const p = document.querySelector('.ProseMirror p')
        if (p) { const r = p.getBoundingClientRect(); return 'ok' }
        return 'no-p'
      })()`)
    }
  }
  if (!probeOk) throw new Error('typing: 3 次都没能把字插进编辑器（窗口焦点/遮挡）')
  await app.ev(`(() => { window.__P.begin('typing'); return 'ok' })()`)
  const m0 = await metricsSnapshot(app)
  const keeper = setInterval(() => {
    app.send('Page.bringToFront').catch(() => {})
  }, 1200)
  try {
    for (let i = 0; i < n; i += 1) {
      await app.send('Input.insertText', { text: 'a' })
      await sleep(50)
    }
    await sleep(220)
  } finally {
    clearInterval(keeper)
  }
  const m1 = await metricsSnapshot(app)
  const samples = JSON.parse(await app.ev(`JSON.stringify(window.__P.samples().typing)`))
  const work = JSON.parse(await app.ev(`JSON.stringify(window.__P.work)`))
  const dispatch = JSON.parse(await app.ev(`JSON.stringify(window.__P.dispatch)`))
  const longtask = JSON.parse(await app.ev(`JSON.stringify(window.__P.summary())`))
  await app.ev(`(() => { window.__P.end(); return 'ok' })()`)
  const valid = samples.filter((s) => s.dt != null && s.dt <= 200)
  const counts0 = valid.length ? valid[0].before : {}
  const counts1 = valid.length ? valid[valid.length - 1].snap.counts : {}
  return {
    n: valid.length,
    nRaw: samples.length,
    frames,
    lat: stats(valid.map((s) => s.dt)),
    lat1: stats(valid.map((s) => s.dt1)),
    work: stats(work),
    dispatch: stats(dispatch),
    longtask: longtask.longtasks,
    metrics: metricsDelta(m0, m1),
    counts: diffCounts(counts0, counts1),
    samples,
    at: { x: t.x, y: t.y, text: t.text }
  }
}

async function rawDrag(app, steps = 24) {
  const frames = await assertFrames(app, 'drag')
  await collapseSelection(app)
  const pickRaw = await app.ev(
    `(() => { const p = window.__P.pickText(150, 40); return p ? JSON.stringify(p) : null })()`
  )
  if (!pickRaw) throw new Error('drag: 视口里找不到可拖的正文段落')
  const p = JSON.parse(pickRaw)
  const vh = await app.ev('window.innerHeight')
  // 前 8 步在同一行内向右；之后 16 步向下（纵向跨块，逼近用户“选一段”的真实路径）
  const dx = Math.max(6, Math.floor((p.x2 - p.x) / 8))
  const dy = Math.max(6, Math.min(22, Math.floor((vh - 90 - p.y) / 16)))
  await app.ev(`(() => { window.__P.begin('drag'); return 'ok' })()`)
  const m0 = await metricsSnapshot(app)
  let x = p.x
  let y = p.y
  const keeper = setInterval(() => {
    app.send('Page.bringToFront').catch(() => {})
  }, 1200)
  try {
    await mouse(app.send, 'mouseMoved', p.x, p.y, 0)
    await sleep(90)
    await mouse(app.send, 'mousePressed', p.x, p.y, 1)
    await sleep(70)
    for (let i = 1; i <= steps; i += 1) {
      if (i <= 8) x = Math.min(p.x2, p.x + dx * i)
      else y = Math.min(vh - 50, p.y + dy * (i - 8))
      await mouse(app.send, 'mouseMoved', x, y, 1)
      await sleep(34)
    }
    await sleep(80)
    await mouse(app.send, 'mouseReleased', x, y, 0)
    await sleep(420)
  } finally {
    clearInterval(keeper)
  }
  const m1 = await metricsSnapshot(app)
  const rawSamples = JSON.parse(await app.ev(`JSON.stringify(window.__P.samples().drag)`))
  const longtask = JSON.parse(await app.ev(`JSON.stringify(window.__P.summary())`))
  const finalState = JSON.parse(await app.ev(`JSON.stringify(window.__P.snap())`))
  await app.ev(`(() => { window.__P.end(); return 'ok' })()`)
  const valid = rawSamples.filter((s) => s.dt != null && s.dt <= 200)
  const counts0 = valid.length ? valid[0].before : {}
  const counts1 = valid.length ? valid[valid.length - 1].snap.counts : {}
  return {
    n: valid.length,
    nRaw: rawSamples.length,
    frames,
    lat: stats(valid.map((s) => s.dt)),
    lat1: stats(valid.map((s) => s.dt1)),
    longtask: longtask.longtasks,
    metrics: metricsDelta(m0, m1),
    counts: diffCounts(counts0, counts1),
    steps: rawSamples,
    final: finalState,
    start: { x: p.x, y: p.y },
    end: { x, y },
    picked: p.text
  }
}

async function rawScroll(app, ticks = 30) {
  const alive = await assertFrames(app, 'scroll')
  await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); if (s) s.scrollTop = 0; return 'ok' })()`
  )
  await sleep(900)
  const top0 = await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); return s ? Math.round(s.scrollTop) : -1 })()`
  )
  await app.ev(
    `(() => { window.__P.longTaskMark(); window.__P.begin('scroll'); window.__P.startFrames(); return 'ok' })()`
  )
  const m0 = await metricsSnapshot(app)
  const cx = await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); const r = s.getBoundingClientRect(); return Math.round(r.left + r.width / 2) })()`
  )
  const cy = await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); const r = s.getBoundingClientRect(); return Math.round(r.top + Math.min(r.height / 2, 300)) })()`
  )
  for (let i = 0; i < ticks; i += 1) {
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: cx,
      y: cy,
      deltaX: 0,
      deltaY: 120,
      button: 'none',
      buttons: 0
    })
    await sleep(30)
  }
  await sleep(650)
  const frames = JSON.parse(await app.ev(`JSON.stringify(window.__P.stopFrames())`))
  const m1 = await metricsSnapshot(app)
  const longtask = JSON.parse(await app.ev(`JSON.stringify(window.__P.summary())`))
  const top1 = await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); return s ? Math.round(s.scrollTop) : -1 })()`
  )
  await app.ev(`(() => { window.__P.end(); return 'ok' })()`)
  return {
    ticks,
    framesAlive: alive,
    from: top0,
    to: top1,
    frames,
    longtask: longtask.longtasks,
    metrics: metricsDelta(m0, m1)
  }
}

function topSelf(profile, limit = 15) {
  const nodes = new Map()
  for (const n of profile.nodes) nodes.set(n.id, n)
  const self = new Map()
  const inclusive = new Map()
  const { samples = [], timeDeltas = [] } = profile
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i]
    const dt = timeDeltas[i] || 0
    self.set(id, (self.get(id) || 0) + dt)
    // 反向累加调用栈：inclusive 时间能指出"我们代码里的哪个入口吃掉了时间"
    let cur = id
    const seen = new Set()
    while (cur && nodes.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      inclusive.set(cur, (inclusive.get(cur) || 0) + dt)
      cur = nodes.get(cur).parentId
    }
  }
  const rowsOf = (map) => {
    const rows = []
    for (const [id, us] of map) {
      const n = nodes.get(id)
      if (!n) continue
      const cf = n.callFrame || {}
      rows.push({
        fn: cf.functionName || '(anonymous)',
        url: (cf.url || '').replace(/^file:\/\//, '').replace(/\//g, '\\'),
        file: (cf.url || '').split('/').pop(),
        line: (cf.lineNumber ?? -1) + 1,
        col: (cf.columnNumber ?? -1) + 1,
        selfMs: +(us / 1000).toFixed(2),
        hits: n.hitCount ?? 0
      })
    }
    const merged = new Map()
    for (const r of rows) {
      const k = `${r.fn}|${r.file}|${r.line}`
      const cur = merged.get(k)
      if (cur) {
        cur.selfMs = +(cur.selfMs + r.selfMs).toFixed(2)
        cur.hits += r.hits
      } else merged.set(k, { ...r })
    }
    return [...merged.values()].sort((a, b) => b.selfMs - a.selfMs)
  }
  const selfRows = rowsOf(self)
  const inclRows = rowsOf(inclusive)
  const total = selfRows.reduce((s, r) => s + r.selfMs, 0)
  const named = (r) => !/^\((anonymous|program|idle|garbage collector)\)$/.test(r.fn)
  return {
    totalActiveMs: +total.toFixed(2),
    rows: selfRows.slice(0, limit),
    inclusive: inclRows.filter(named).slice(0, 20)
  }
}

async function profileTyping(app) {
  await assertFrames(app, 'profile-typing')
  await collapseSelection(app)
  const t = await clickIntoText(app, 150)
  if (!t) throw new Error('profile-typing: 找不到可点的正文段落')
  await app.send('Profiler.enable')
  try {
    await app.send('Profiler.setSamplingInterval', { interval: 250 })
  } catch (e) {
    /* ignore */
  }
  await app.send('Profiler.start')
  for (let i = 0; i < 30; i += 1) {
    await app.send('Input.insertText', { text: 'a' })
    await sleep(50)
  }
  await sleep(120)
  const r = await app.send('Profiler.stop')
  await app.send('Profiler.disable')
  return r.result.profile
}

async function profileDrag(app) {
  const framesAlive = await assertFrames(app, 'profile')
  await app.send('Profiler.enable')
  try {
    await app.send('Profiler.setSamplingInterval', { interval: 250 })
  } catch (e) {
    /* 旧版本忽略 */
  }
  await app.ev(
    `(() => { const s = document.querySelector('.editor-scroll'); if (s) s.scrollTop = 0; return 'ok' })()`
  )
  await sleep(900)
  await collapseSelection(app)
  const p = JSON.parse(
    await app.ev(
      `(() => { const x = window.__P.pickText(150, 40); return x ? JSON.stringify(x) : null })()`
    )
  )
  if (!p) throw new Error('profile: 找不到拖选段落')
  await app.send('Profiler.start')
  await mouse(app.send, 'mouseMoved', p.x, p.y, 0)
  await sleep(80)
  await mouse(app.send, 'mousePressed', p.x, p.y, 1)
  const vh = await app.ev('window.innerHeight')
  const dy = Math.max(6, Math.min(22, Math.floor((vh - 90 - p.y) / 24)))
  for (let i = 1; i <= 24; i += 1) {
    await mouse(
      app.send,
      'mouseMoved',
      Math.min(p.x2, p.x + i * 24),
      Math.min(vh - 60, p.y + dy * i),
      1
    )
    await sleep(70)
  }
  await mouse(
    app.send,
    'mouseReleased',
    Math.min(p.x2, p.x + 24 * 24),
    Math.min(vh - 60, p.y + dy * 24),
    0
  )
  await sleep(150)
  const r = await app.send('Profiler.stop')
  await app.send('Profiler.disable')
  return r.result.profile
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true })
  const fx = build()
  const meta = {
    kind: 'lumin-perf',
    tag: TAG,
    measuredAt: new Date().toISOString(),
    commit: git(['rev-parse', '--short', 'HEAD']),
    commitFull: git(['rev-parse', 'HEAD']),
    build: buildInfo(),
    fixture: DOC === 'real' ? fx.real : fx.big,
    node: process.version,
    window: {}
  }
  if (!meta.build.outNewerThanSrc) {
    console.error('⚠️ 构建产物不比源码新：先 npm run build；本次数字不作数')
    process.exit(3)
  }
  /**
   * ⚠️ userData 放到 %LOCALAPPDATA%（**不是** %TEMP%）：本机的 `tools/run-suites.js`
   * 每轮开跑/收尾都会 `killTempInstances()`，把「--user-data-dir 落在 %TEMP% 下」的
   * 所有 electron 杀掉 —— 并行跑套件时会把正在测量的实例一起收走。
   * 目录名仍不含 `lumin`；夹具仍放 %TEMP%（LUMIN_TRUSTED_PATHS 指向那里）。
   */
  const USER_DATA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'xw-perf-ud')
  killOwn(USER_DATA)
  const fixture = DOC === 'real' ? fx.real : fx.big
  const inst = await launchStable({
    tag: 'perf' + DOC,
    userData: USER_DATA,
    ports: [PORT, PORT + 1],
    tries: 1,
    readyMs: 120000,
    rootDir: ROOT,
    extraArgs: [
      `--lumin-open=${encodeURIComponent(fixture.path)}`,
      // 被别的窗口遮住时也不许把渲染进程降级/冻结：否则 rAF 停摆，所有延迟数字失真
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ]
  })
  if (!inst.ok) {
    console.error(JSON.stringify(inst.attempts, null, 2))
    process.exit(1)
  }
  console.log(`instance ready port=${inst.port} ud=${inst.userData}`)
  const windowPin = startWindowPin(path.basename(inst.userData))
  try {
    const app = await connect({ port: inst.port })
    // 页面主线程被卡住时 CDP evaluate 可能永远不回；所有求值都加硬超时，
    // 让「窗口不出帧 / 主线程卡死」变成一条可读的失败，而不是整轮挂住。
    const rawEv = app.ev.bind(app)
    app.ev = async (expr) => {
      let timer
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Error('CDP evaluate timeout: ' + String(expr).slice(0, 120))),
          15000
        )
      })
      try {
        return await Promise.race([rawEv(expr), timeout])
      } finally {
        clearTimeout(timer)
      }
    }
    if (!(await settle(app.ev))) throw new Error('应用没就绪（settle 超时）')
    if (!(await waitEditor(app.ev))) throw new Error('编辑器没挂上')
    await app.send('Performance.enable')
    await app.ev(PROBE_SRC)
    // 打开探针计数（只计数 + A/B 开关；关闭时热路径只有一次布尔判断）
    await app.ev(`(() => { if (window.__LPERF) window.__LPERF.on = true; return 'ok' })()`)
    await sleep(800)

    const loaded = await app.ev(
      `(() => { const f = window.__L.files().current; return f ? JSON.stringify({path:f.path,name:f.name,contentLen:(f.content||'').length}) : null })()`
    )
    let opened = loaded ? JSON.parse(loaded) : null
    const loadedFixture = !!(opened && /(real|big)\.md$/.test(String(opened.path || '')))
    if (!loadedFixture) {
      // 启动参数没打开文件时的兜底：按同一份字节走 store 替换（与真实打开同一条渲染路径）
      const content = fs.readFileSync(fixture.path, 'utf8')
      await openDocWith(app, content, path.basename(fixture.path))
      await waitEditor(app.ev)
      await sleep(1000)
      opened = { path: '(store-replace)', contentLen: content.length, fallback: true }
    }
    meta.window = JSON.parse(
      await app.ev(
        'JSON.stringify({innerWidth:innerWidth,innerHeight:innerHeight,devicePixelRatio:devicePixelRatio})'
      )
    )
    meta.opened = opened
    const leaf = path.basename(USER_DATA)
    UD_LEAF = leaf
    console.log('raise-window', raiseWindow(leaf))
    await bringToFront(app)
    await sleep(800)
    meta.frames = await ensureFrames(app, 600, 10)
    console.log('idle-frames', JSON.stringify(meta.frames))
    if (!meta.frames.ok) {
      throw new Error('窗口不出帧（被遮挡？）——rAF 停摆，数字会失真')
    }
    await app.ev(`(() => { window.__P.rebind(); return 'ok' })()`)

    if (args.trace) {
      const t = await clickIntoText(app, 150)
      if (!t) throw new Error('trace: 找不到可点的正文段落')
      await ensureEditorFocus(app)
      await app.ev(`(() => { window.__P.traceRects(true); return 'ok' })()`)
      for (let i = 0; i < 10; i += 1) {
        await app.send('Input.insertText', { text: 'a' })
        await sleep(80)
      }
      const tr = await app.ev(`JSON.stringify(window.__P.traceRects(false))`)
      const outFile = path.join(TMP, `perf-trace-${TAG}.json`)
      fs.writeFileSync(outFile, tr, 'utf8')
      console.log(`TRACE ${path.relative(ROOT, outFile)}`)
      console.log(tr)
      app.close()
      return 0
    }

    let typing = null
    let drag = null
    let scroll = null
    if (WANT_TYPING) {
      console.log('▶ typing 30 chars …')
      typing = await rawTyping(app, 30)
      if (typing.n < 20) {
        console.log(`typing 只收到 ${typing.n} 个有效样本（帧停摆？）——重试一次`)
        await sleep(600)
        typing = await rawTyping(app, 30)
      }
      if (typing.n < 20) throw new Error(`typing: 有效样本不足（${typing.n}/30，rAF 被停摆）`)
      console.log(
        'typing',
        JSON.stringify(typing.lat),
        JSON.stringify(typing.longtask),
        JSON.stringify(typing.counts)
      )
      await collapseSelection(app)
    }

    if (WANT_DRAG) {
      console.log('▶ drag selection 24 steps …')
      drag = await rawDrag(app, 24)
      if (drag.n < 18) {
        console.log(`drag 只收到 ${drag.n} 步（帧停摆？）——重试一次`)
        await sleep(600)
        drag = await rawDrag(app, 24)
      }
      if (drag.n < 18) throw new Error(`drag: 有效步数不足（${drag.n}/24，rAF 被停摆）`)
      console.log(
        'drag',
        JSON.stringify(drag.lat),
        JSON.stringify(drag.longtask),
        JSON.stringify(drag.counts)
      )
      console.log(
        'drag final',
        JSON.stringify({
          from: drag.final.from,
          to: drag.final.to,
          bands: drag.final.bands,
          hl: drag.final.hl,
          own: drag.final.own
        })
      )
    }

    if (WANT_SCROLL) {
      console.log('▶ scroll 30 ticks …')
      scroll = await rawScroll(app, 30)
      if (scroll.frames.n < 50) {
        console.log(`scroll 只收到 ${scroll.frames.n} 帧（帧停摆？）——重试一次`)
        await sleep(600)
        scroll = await rawScroll(app, 30)
      }
      if (scroll.frames.n < 50) throw new Error(`scroll: 有效帧不足（${scroll.frames.n}）`)
      console.log(
        'scroll',
        JSON.stringify({
          p50: scroll.frames.p50,
          p95: scroll.frames.p95,
          max: scroll.frames.max,
          dropped: scroll.frames.dropped,
          n: scroll.frames.n
        }),
        JSON.stringify(scroll.longtask)
      )
    }

    let toggles = null
    if (WANT_TOGGLE_RUN) {
      const flags = await app.ev(`(() => {
        const l = window.__LPERF
        return l && l.toggles ? JSON.stringify(Object.keys(l.toggles)) : null
      })()`)
      if (!flags) {
        console.log('toggles: 构建里没有 __LPERF.toggles（基线构建），跳过')
        toggles = { skipped: 'no-toggle-surface' }
      } else {
        console.log('toggles available:', flags)
        toggles = {}
        const configs = [
          { name: 'all-on', t: {} },
          { name: 'selband-off', t: { selBand: false } },
          { name: 'imgdeco-off', t: { imgDeco: false } },
          { name: 'livepaint-off', t: { livePaint: false } },
          { name: 'imgcache-off', t: { imgCache: false } },
          { name: 'fastscroll-off', t: { fastScroll: false } }
        ]
        for (const cfg of configs) {
          await app.ev(`(() => {
            const l = window.__LPERF
            for (const k of Object.keys(l.toggles)) l.toggles[k] = true
            Object.assign(l.toggles, ${JSON.stringify(cfg.t)})
            return 'ok'
          })()`)
          await collapseSelection(app)
          await app.ev(
            `(() => { const s=document.querySelector('.editor-scroll'); if(s) s.scrollTop=0; return 'ok' })()`
          )
          await sleep(400)
          const d = await rawDrag(app, 24)
          console.log(`toggle ${cfg.name}: drag`, JSON.stringify(d.lat), JSON.stringify(d.counts))
          toggles[cfg.name] = {
            lat: d.lat,
            longtask: d.longtask,
            metrics: d.metrics,
            counts: d.counts,
            bands: d.final.bands,
            own: d.final.own
          }
        }
        await app.ev(`(() => {
          const l = window.__LPERF
          for (const k of Object.keys(l.toggles)) l.toggles[k] = true
          return 'ok'
        })()`)
      }
    }

    let profile = null
    if (WANT_PROFILE_RUN) {
      console.log(ONLY === 'typing' ? '▶ profiler: typing 30 keys …' : '▶ profiler: drag 2s …')
      const prof = ONLY === 'typing' ? await profileTyping(app) : await profileDrag(app)
      const rawFile = path.join(TMP, `perf-profile-${TAG}.json`)
      fs.writeFileSync(rawFile, JSON.stringify(prof), 'utf8')
      const top = topSelf(prof, 15)
      profile = { rawFile: path.relative(ROOT, rawFile), ...top }
      console.log(`profile totalActiveMs=${top.totalActiveMs} raw=${rawFile}`)
      for (const r of top.rows)
        console.log(
          `  ${String(r.selfMs).padStart(8)}ms ${String(r.hits).padStart(5)}h ${r.fn} @ ${r.file}:${r.line}`
        )
      console.log('  --- inclusive ---')
      for (const r of top.inclusive)
        console.log(
          `  ${String(r.selfMs).padStart(8)}ms ${String(r.hits).padStart(5)}h ${r.fn} @ ${r.file}:${r.line}`
        )
    }

    const out = { meta, typing, drag, scroll, toggles, profile }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
    console.log(`\nWROTE ${path.relative(ROOT, OUT)}`)
    console.log(
      JSON.stringify(
        {
          typing: typing ? typing.lat : null,
          drag: drag ? drag.lat : null,
          scroll: scroll
            ? {
                p50: scroll.frames.p50,
                p95: scroll.frames.p95,
                max: scroll.frames.max,
                dropped: scroll.frames.dropped
              }
            : null,
          longtasks: {
            typing: typing ? typing.longtask : null,
            drag: drag ? drag.longtask : null,
            scroll: scroll ? scroll.longtask : null
          },
          counts: { typing: typing ? typing.counts : null, drag: drag ? drag.counts : null }
        },
        null,
        2
      )
    )
    app.close()
    return 0
  } finally {
    try {
      windowPin.stop()
    } catch (e) {
      /* ignore */
    }
    try {
      inst.close()
    } catch (e) {
      /* ignore */
    }
    killOwn(USER_DATA)
  }
}

main()
  .then((c) => {
    clearInterval(keepAlive)
    process.exit(c)
  })
  .catch((e) => {
    clearInterval(keepAlive)
    console.error('ERROR', e && e.stack ? e.stack : e)
    process.exit(1)
  })
