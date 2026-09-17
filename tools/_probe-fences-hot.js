'use strict'
// ─── 一次性探针：2000 围栏代码块文档的「切到源码」热点（定位本轮性能回退）──────────
//
// 跑法：node tools/run-suites.js --suite=_probe-fences-hot.js --timeout=900000
// 只做一件事：装载 2000 个围栏 → 采一份 CPU profile 覆盖「切到源码」→ 打印 top 自带时间。
const fs = require('fs')
const path = require('path')
const { connect, settle, waitEditor, sleep, openDocWith, fatal } = require('./lib/harness')

const fences = (n) =>
  Array.from({ length: n }, (_, i) => '```js\nconst v' + i + ' = ' + i + '\n```\n\n').join('')

const SET_MODE = (idx) => `(() => {
  const list = [...document.querySelectorAll('[role="tablist"]')].find(
    (l) => l.querySelectorAll('[role="tab"]').length === 3
  )
  const btn = list?.querySelectorAll('[role="tab"]')[${idx}]
  if (!btn) return 'no-btn'
  btn.click()
  return 'ok'
})()`

async function restore(app, waitMs = 20000) {
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    const busy = await app.ev(`!!document.querySelector('.view-restoring')`).catch(() => false)
    if (!busy) return
    await sleep(50)
  }
}

function topFrames(file, top = 22) {
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
    console.log(`    ${(us / 1000).toFixed(1).padStart(9)}ms  ${k}`)
  }
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(200)

  const md = fences(2000)
  let t0 = Date.now()
  await openDocWith(app, md)
  await sleep(500)
  const loadMs = Date.now() - t0
  console.log(`装载 2000 围栏（${(md.length / 1024).toFixed(0)}KB）: ${loadMs}ms`)

  await app.send('Profiler.enable')
  await app.send('Profiler.setSamplingInterval', { interval: 200 })
  await app.send('Profiler.start')
  t0 = Date.now()
  await app.ev(SET_MODE(2))
  await restore(app)
  const toSourceMs = Date.now() - t0
  const prof = await app.send('Profiler.stop')
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', '_probe-fences-hot.cpuprofile'),
    JSON.stringify(prof.result.profile)
  )
  console.log(`切到源码: ${toSourceMs}ms`)

  t0 = Date.now()
  await app.ev(SET_MODE(0))
  await restore(app)
  console.log(`切回渲染: ${Date.now() - t0}ms`)

  console.log('\n热点（切到源码）:')
  topFrames(path.join(__dirname, '..', 'out', '_probe-fences-hot.cpuprofile'))
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', '_probe-fences-hot.txt'),
    `load=${loadMs}ms toSource=${toSourceMs}ms\n`
  )
  app.close()
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
