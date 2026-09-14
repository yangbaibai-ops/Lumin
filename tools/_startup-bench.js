// 启动耗时基准（生产包）：直接跑 `electron .`（已 build 的 out/），从「spawn 进程」开始计时，
// 记录每个窗口「文档可见」的时刻（首个窗口 = 用户第一眼看到的，最后一个 = 全部就绪）。
// 用法：node tools/_startup-bench.js <label> [轮数]
// 前提：已 npm run build；且当前没有其它 Lumin 实例（单实例锁 / 9222 被占用会直接报错）。
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const LABEL = process.argv[2] || 'run'
const ROUNDS = Number(process.argv[3] || 1)
const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(pathname) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: 9222, path: pathname, timeout: 800 }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try {
          res(JSON.parse(d))
        } catch (e) {
          rej(e)
        }
      })
    })
    req.on('error', rej)
    req.on('timeout', () => {
      req.destroy()
      rej(new Error('timeout'))
    })
  })
}

const debuggerUp = async () => {
  try {
    await get('/json/version')
    return true
  } catch {
    return false
  }
}

/** 复用同一个 WebSocket 轮询（每次新建连接会引入几十毫秒噪声） */
function session(url) {
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
  const ev = (expr) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, (m) => res(m.result?.exceptionDetails ? undefined : m.result?.result?.value))
      try {
        ws.send(
          JSON.stringify({
            id: i,
            method: 'Runtime.evaluate',
            params: { expression: expr, returnByValue: true, awaitPromise: true }
          })
        )
      } catch {
        res(undefined)
      }
    })
  return { ws, ready, ev }
}

// 「文档可见」= 编辑器已挂载且骨架屏已退场（两个版本都成立的判据）
const SNAP_EXPR = `JSON.stringify({
  ready: !!document.querySelector('.ProseMirror') && document.querySelectorAll('.skeleton').length === 0 && !document.querySelector('.lm-boot'),
  visible: document.visibilityState === 'visible',
  booting: document.querySelectorAll('.skeleton').length > 0,
  inlineSkeleton: !!document.querySelector('.lm-boot'),
  pmLen: (document.querySelector('.ProseMirror')?.textContent || '').trim().length,
  marks: Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, Math.round(m.startTime)])),
  paint: Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))
})`

async function round() {
  const t0 = Date.now()
  const child = spawn(ELECTRON, ['.'], {
    cwd: ROOT,
    env: { ...process.env, LUMIN_DEBUG_PORT: '9222', LUMIN_STARTUP_LOG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))

  const out = { label: LABEL, windows: [] }
  for (let i = 0; i < 800; i++) {
    if (await debuggerUp()) break
    await sleep(10)
  }
  out.debuggerMs = Date.now() - t0

  const watched = new Map() // id -> { session, readyAt, snapshots }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const list = await get('/json/list')
      for (const t of list) {
        if (t.type !== 'page' || !/index\.html/.test(t.url) || watched.has(t.id)) continue
        const s = session(t.webSocketDebuggerUrl)
        const rec = { id: t.id, createdAt: Date.now() - t0, session: s, readyAt: null, visibleAt: null, first: null, last: null }
        watched.set(t.id, rec)
        s.ready
          .then(async () => {
            for (let i = 0; i < 1500 && rec.readyAt === null; i++) {
              const raw = await s.ev(SNAP_EXPR)
              if (raw) {
                const snap = JSON.parse(raw)
                rec.last = snap
                if (!rec.first) rec.first = { at: Date.now() - t0, ...snap }
                if (snap.visible && rec.visibleAt === null) rec.visibleAt = Date.now() - t0
                if (snap.ready) rec.readyAt = Date.now() - t0
              }
              if (rec.readyAt === null) await sleep(10)
            }
          })
          .catch(() => {})
      }
    } catch {}
    const all = [...watched.values()]
    if (all.length && all.every((r) => r.readyAt !== null)) break
    await sleep(15)
  }
  // 给还在跑的窗口 1.5s 收尾
  const all = [...watched.values()]
  for (const r of all) {
    if (r.readyAt === null) {
      const t = Date.now() + 1500
      while (Date.now() < t && r.readyAt === null) await sleep(25)
    }
  }
  out.windows = all.map((r) => ({
    id: r.id,
    firstSeenMs: r.createdAt,
    visibleAtMs: r.visibleAt,
    docVisibleMs: r.readyAt,
    first: r.first ? { at: r.first.at, booting: r.first.booting, inlineSkeleton: r.first.inlineSkeleton, paint: r.first.paint } : null,
    marks: r.last?.marks ?? null,
    paint: r.last?.paint ?? null,
    pmLen: r.last?.pmLen ?? null
  }))
  out.mainLog = log
    .split(/\r?\n/)
    .filter((l) => l.includes('[startup]'))
    .map((l) => l.trim())
  for (const r of all) {
    try {
      r.session.ws.close()
    } catch {}
  }
  try {
    child.kill()
  } catch {}
  await sleep(200)
  spawn('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' })
  await sleep(1200)
  return out
}

;(async () => {
  const results = []
  for (let i = 0; i < ROUNDS; i++) {
    if (await debuggerUp()) {
      console.error('ERROR: 9222 已被占用（已有 Lumin 在跑）')
      process.exit(2)
    }
    const r = await round()
    results.push(r)
    const docs = r.windows.map((w) => w.docVisibleMs).filter((x) => typeof x === 'number')
    console.log(
      `ROUND ${i + 1} ${r.label} debugger=${r.debuggerMs}ms windows=${r.windows.length} ` +
        `windowVisible=${JSON.stringify(r.windows.map((w) => w.visibleAtMs))} docVisible=${JSON.stringify(docs)} fcp=${JSON.stringify(r.windows.map((w) => w.paint?.['first-contentful-paint'] ?? null))}`
    )
    for (const w of r.windows) {
      console.log(
        `   win ${w.id.slice(0, 8)} seen=${w.firstSeenMs}ms visible=${w.visibleAtMs}ms doc=${w.docVisibleMs}ms pmLen=${w.pmLen} marks=${JSON.stringify(w.marks)}`
      )
    }
    if (r.mainLog.length) console.log('  main: ' + r.mainLog.join(' | '))
    if (i < ROUNDS - 1) await sleep(1200)
  }
  const nums = (f) => results.flatMap((r) => r.windows.map(f)).filter((x) => typeof x === 'number')
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
  const perRound = (f) => results.map((r) => f(r.windows))
  const firsts = perRound((ws) => Math.min(...ws.map((w) => w.docVisibleMs ?? Infinity))).filter((x) => Number.isFinite(x))
  const lasts = perRound((ws) => Math.max(...ws.map((w) => w.docVisibleMs ?? -1))).filter((x) => x >= 0)
  const visibles = perRound((ws) => Math.min(...ws.map((w) => w.visibleAtMs ?? Infinity))).filter((x) => Number.isFinite(x))
  console.log(
    `SUMMARY ${LABEL} rounds=${results.length} medianDebugger=${med(nums((w) => w.firstSeenMs))}ms ` +
      `medianWindowVisible=${med(visibles)}ms medianFirstWindow=${med(firsts)}ms medianAllWindows=${med(lasts)}ms ` +
      `windowVisibleAll=${JSON.stringify(visibles)} firstAll=${JSON.stringify(firsts)}`
  )
  fs.writeFileSync(path.join(os.tmpdir(), `lumin-startup-${LABEL}.json`), JSON.stringify(results, null, 2))
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
