'use strict'
// ─── 一次性探针：围栏代码块文档的「切到源码」耗时（定位本轮性能回退）─────────────
//
// 现场：`_verify-surface-stress.js` 的 `many-fences-2000 切到源码` 从 ~1.4s 涨到 ~19.6s。
// 这里把规模缩小成 N=100/300/600/1200 个围栏，量「切到源码」的耗时随块数的增长曲线
// （线性 or 超线性），并在最大的一档上采一份 CPU profile 归因到函数。
//
// 跑法：node tools/run-suites.js --suite=_probe-modeswitch.js --timeout=600000
const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  openDocWith,
  Reporter,
  fatal
} = require('./lib/harness')

const N = [100, 300, 600, 1200]

const fences = (n) =>
  Array.from({ length: n }, (_, i) => '```js\nconst v' + i + ' = ' + i + '\n```\n\n').join('')

/** 切到源码模式（与压力套件同一条路径：点模式分段控件的第 3 个） */
const SET_MODE = (idx) => `(() => {
  const list = [...document.querySelectorAll('[role="tablist"]')].find(
    (l) => l.querySelectorAll('[role="tab"]').length === 3
  )
  const btn = list?.querySelectorAll('[role="tab"]')[${idx}]
  if (!btn) return 'no-btn'
  btn.click()
  return 'ok'
})()`

async function switchMode(app, idx, waitMs = 15000) {
  const t0 = Date.now()
  const r = await app.ev(SET_MODE(idx))
  if (r !== 'ok') return { ms: -1, err: r }
  // 等视图恢复完成（与 harness.waitRestored 同一判据）
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    const busy = await app.ev(`!!document.querySelector('.view-restoring')`).catch(() => false)
    if (!busy) break
    await sleep(50)
  }
  return { ms: Date.now() - t0 }
}

function topFrames(file, top = 14) {
  const p = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map()
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i])
    if (!n) continue
    const cf = n.callFrame
    const key = `${cf.functionName || '(anon)'} @ ${String(cf.url).split('/').pop()}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0))
  }
  console.log(
    `  CPU 采样 top（合计 ${(p.timeDeltas.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}ms）:`
  )
  for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`    ${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`)
  }
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)

  const out = []
  for (const n of N) {
    const md = fences(n)
    const t0 = Date.now()
    await openDocWith(app, md)
    await sleep(400)
    const loadMs = Date.now() - t0
    const profile = n === N[N.length - 1]
    if (profile) {
      await app.send('Profiler.enable')
      await app.send('Profiler.setSamplingInterval', { interval: 200 })
      await app.send('Profiler.start')
    }
    const fwd = await switchMode(app, 2)
    if (profile) {
      const prof = await app.send('Profiler.stop')
      fs.writeFileSync(
        path.join(__dirname, '..', 'out', `_probe-modeswitch-${n}.cpuprofile`),
        JSON.stringify(prof.result.profile)
      )
    }
    const back = await switchMode(app, 0)
    const line = `N=${String(n).padStart(4)} ${(md.length / 1024).toFixed(0).padStart(3)}KB load=${String(loadMs).padStart(6)}ms  source=${String(fwd.ms).padStart(6)}ms  back=${String(back.ms).padStart(6)}ms`
    console.log(line)
    out.push(line)
    await sleep(300)
  }
  console.log('\n热点（最大一档切到源码）:')
  try {
    topFrames(path.join(__dirname, '..', 'out', `_probe-modeswitch-${N[N.length - 1]}.cpuprofile`))
  } catch (e) {
    console.log('  profile 解析失败: ' + e.message)
  }
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', '_probe-modeswitch.txt'),
    out.join('\n'),
    'utf-8'
  )
  app.close()
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
