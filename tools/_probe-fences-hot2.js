'use strict'
// ─── 一次性探针：精确复刻压力套件「切到源码」的时序 + CPU 归因 ─────────────────────
//
// 与 _verify-surface-stress.js 的 many-fences-2000 同路径：
//   预热小文档 → LOAD(setContent 2000 围栏) → FLUSH → sleep(150)
//   → [profile] ui.editorMode='source' → sleep(500) → 读 TEXTAREA → [profile stop]
// 打印每一段的耗时与 top 自带时间，用来定位「切到源码 1.4s → 18.8s」的回退在哪。
//
// 跑法：node tools/run-suites.js --suite=_probe-fences-hot2.js --timeout=900000
const fs = require('fs')
const path = require('path')
const P = require('./lib/surface-probe')
const { connect, settle, waitEditor, sleep, fatal } = require('./lib/harness')

const fences = (n) =>
  Array.from({ length: n }, (_, i) => '```js\nconst v' + i + ' = ' + i + '\n```\n\n').join('')

function topFrames(file, top = 25) {
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

  // 与套件一致：先预热一次
  await P.loadDoc(app, '# 预热\n\n暖一下。\n')
  await sleep(150)

  const md = fences(2000)
  let t0 = Date.now()
  const loaded = await P.loadDoc(app, md)
  const loadMs = Date.now() - t0
  console.log(
    `setContent 装载 2000 围栏: ${loadMs}ms（真源 ${loaded ? loaded.length : 'null'} 字符）`
  )

  await app.send('Profiler.enable')
  await app.send('Profiler.setSamplingInterval', { interval: 200 })
  await app.send('Profiler.start')
  t0 = Date.now()
  await app.ev(`(() => { window.__L.ui().editorMode = 'source'; return 'ok' })()`)
  const setModeMs = Date.now() - t0
  await sleep(500)
  t0 = Date.now()
  const ta = await P.readJson(app, P.TEXTAREA)
  const taMs = Date.now() - t0
  const prof = await app.send('Profiler.stop')
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', '_probe-fences-hot2.cpuprofile'),
    JSON.stringify(prof.result.profile)
  )
  console.log(
    `切到源码: setMode=${setModeMs}ms + sleep500 + 读textarea=${taMs}ms | textarea 长度=${ta?.value?.length}`
  )

  t0 = Date.now()
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  for (let i = 0; i < 100; i++) {
    if (await app.ev('!!window.__L?.ed()')) break
    await sleep(100)
  }
  console.log(`切回渲染: ${Date.now() - t0}ms`)

  console.log('\n热点（切到源码的全部三段）:')
  topFrames(path.join(__dirname, '..', 'out', '_probe-fences-hot2.cpuprofile'))
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', '_probe-fences-hot2.txt'),
    `load=${loadMs}ms setMode=${setModeMs}ms ta=${taMs}ms\n`
  )
  app.close()
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
