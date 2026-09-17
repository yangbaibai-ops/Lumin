'use strict'
// ─── 一次性探针：2000 围栏代码块「装载 + 切面」全程的 CPU 归因（定位性能回退）──────
//
// 为什么量全程：CDP 的 Runtime.evaluate 会**阻塞到渲染进程主线程空闲**，所以
// 「哪一段慢」会随下一个 evaluate 落在哪里而漂移（实测同一构建：装载 54s/切面 18.8s
// 与 装载 195s/切面 0.3s 两种归因）。⇒ 只比**总时长 + 全程 CPU 自带时间**才有意义。
//
// 跑法：node tools/run-suites.js --suite=_probe-fences-total.js --timeout=900000
const fs = require('fs')
const path = require('path')
const P = require('./lib/surface-probe')
const { connect, settle, waitEditor, sleep, fatal } = require('./lib/harness')

const FENCES = Number(process.env.LUMIN_PROBE_FENCES || 2000)
const TAG = process.env.LUMIN_PROBE_TAG || 'x'

const fences = (n) =>
  Array.from({ length: n }, (_, i) => '```js\nconst v' + i + ' = ' + i + '\n```\n\n').join('')

const INTERESTING =
  /normalizeAtoms|blockInventory|buildRevealDecorations|pushEscape|styleList|collectRuns|collectEscape|appendTransaction|resolveBlockContent|fromAtoms|toAtoms|literalize|recognizeTyped|repairPolluted|reLift|materialize|scanDelims|emphasisTokenize|decorations|apply @|init @|(garbage collector)|Program|compile|parse|MarkdownParser|CodeMirror|EditorView.*constructor|createNodeViews|updateChildren|updateState|updateInner|readDOMChange/

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
        ? 'pm/vendor(index chunk)'
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
  lines.push('  总 top 20:')
  for (const [k, us] of rows.slice(0, 20))
    lines.push(`    ${(us / 1000).toFixed(1).padStart(9)}ms  ${k}`)
  const text = lines.join('\n')
  console.log(text)
  return text
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(200)
  await P.loadDoc(app, '# 预热\n\n暖一下。\n')
  await sleep(150)

  const md = fences(FENCES)
  await app.send('Profiler.enable')
  await app.send('Profiler.setSamplingInterval', { interval: 300 })
  await app.send('Profiler.start')
  const t0 = Date.now()
  await P.loadDoc(app, md)
  const t1 = Date.now()
  await app.ev(`(() => { window.__L.ui().editorMode = 'source'; return 'ok' })()`)
  await sleep(500)
  const ta = await P.readJson(app, P.TEXTAREA)
  const t2 = Date.now()
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  for (let i = 0; i < 100; i++) {
    if (await app.ev('!!window.__L?.ed()')) break
    await sleep(100)
  }
  const t3 = Date.now()
  const prof = await app.send('Profiler.stop')
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', `_probe-fences-total-${TAG}.cpuprofile`),
    JSON.stringify(prof.result.profile)
  )
  const head =
    `[${TAG}] fences=${FENCES} load+flush=${t1 - t0}ms 切源码(+读textarea)=${t2 - t1}ms ` +
    `切回=${t3 - t2}ms 全程=${t3 - t0}ms textarea=${ta?.value?.length}`
  console.log(head)
  const body = dumpProfile(
    path.join(__dirname, '..', 'out', `_probe-fences-total-${TAG}.cpuprofile`)
  )
  fs.writeFileSync(
    path.join(__dirname, '..', 'out', `_probe-fences-total-${TAG}.txt`),
    head + '\n' + body + '\n',
    'utf-8'
  )
  app.close()
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
