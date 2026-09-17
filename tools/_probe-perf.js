'use strict'
// ─── 取证探针（一次性，非套件）：打字每键耗时的量化 + 热点定位 ────────────────────
//
// 跑法：node tools/run-suites.js --suite=_probe-perf.js
//
// 每个场景都在**页面里**用 performance.now() 逐键包住 ed.commands.insertContent，
// 给出 avg / p50 / p95 / max；同时统计 markdown-it 解析（storage.markdown.parser.parse）
// 的调用次数与总耗时（「整段重解析」这一路的直接证据），最后用 CDP Profiler
// 采一份 CPU 采样，把自带时间（self time）归到具体函数上。
const fs = require('fs')
const path = require('path')
const { connect, settle, waitEditor, sleep, openDocWith, fatal } = require('./lib/harness')

const KEYS = 100
const RUNS = 3

/** 一页一段的中等长度正文（含标记，模拟真实写作） */
function longParagraph(chars) {
  const unit = '这是一段用于压测的中文正文**重点**，含标点、顿号、以及*斜体*与`代码`。'
  let s = ''
  while (s.length < chars) s += unit
  return s.slice(0, chars)
}
/** 多块长文档：每个块都带样式（模拟「一篇有很多加粗的文档」） */
function manyBlocks(blocks, per) {
  const out = []
  for (let i = 0; i < blocks; i++) {
    out.push(`第${i}段：这一段有**加粗**与普通文字，长度约${'x'.repeat(Math.max(0, per - 30))}。`)
  }
  return out.join('\n\n')
}

const typingExpr = (n) => `(async () => {
  const ed = window.__L.ed()
  const pm = document.querySelector('.ProseMirror')
  if (pm) pm.focus()
  ed.commands.focus('end')
  const parser = ed.storage && ed.storage.markdown && ed.storage.markdown.parser
  // 计数器挂在 window 上（**不还原**包装）：每次调用只读差值，避免「第一次包装后
  // __probeWrapped 为真、后续测量全都不计数」这个坑（实测踩到，mdCalls 恒为 0）
  const P = (window.__perfProbe = window.__perfProbe || { n: 0, ms: 0, rn: 0, rms: 0 })
  if (parser && !parser.__probeWrapped) {
    const origParse = parser.parse.bind(parser)
    parser.parse = (c, o) => {
      const t = performance.now()
      try {
        return origParse(c, o)
      } finally {
        P.n++
        P.ms += performance.now() - t
      }
    }
    parser.__probeWrapped = true
    // markdown-it 实例上的 render 才是「整段重解析」的真正入口，两个都挂上做交叉验证
    if (parser.md && parser.md.render) {
      const origRender = parser.md.render.bind(parser.md)
      parser.md.render = (c, e) => {
        const t = performance.now()
        try {
          return origRender(c, e)
        } finally {
          P.rn++
          P.rms += performance.now() - t
        }
      }
    }
  }
  const before = { n: P.n, ms: P.ms, rn: P.rn, rms: P.rms }
  const diag = {
    hasParser: !!parser,
    hasMd: !!(parser && parser.md),
    maxRuns: !!window.__perfMaxRuns
  }
  const times = []
  for (let i = 0; i < ${n}; i++) {
    const t0 = performance.now()
    ed.commands.insertContent('甲')
    times.push(performance.now() - t0)
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0))
  }
  return JSON.stringify({
    times,
    mdCalls: P.n - before.n,
    mdMs: +(P.ms - before.ms).toFixed(2),
    renderCalls: P.rn - before.rn,
    renderMs: +(P.rms - before.rms).toFixed(2),
    diag,
    docLen: ed.state.doc.content.size
  })
})()`

function stats(times) {
  const s = [...times].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  return {
    avg: +avg.toFixed(2),
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +Math.max(...times).toFixed(2)
  }
}

let app = null
let lastDiag = null
const lines = []
function out(s) {
  lines.push(s)
  console.log(s)
}

async function openDoc(md) {
  await openDocWith(app, md)
  await sleep(700)
}

/** 跑一次打字测量，返回 { stats, mdCalls, mdMs, runs } */
async function measure(label, md, useProfile) {
  await openDoc(md)
  // 预热（第一次纳入会让 p95 失真：块刚装载 + 样式归一化）
  await app.ev(typingExpr(10))
  await sleep(300)
  const all = []
  let mdCalls = 0
  let mdMs = 0
  let renderCalls = 0
  let renderMs = 0
  const perRun = []
  for (let r = 0; r < RUNS; r++) {
    if (useProfile && r === 1) {
      await app.send('Profiler.enable')
      await app.send('Profiler.setSamplingInterval', { interval: 200 })
      await app.send('Profiler.start')
    }
    const res = JSON.parse(await app.ev(typingExpr(KEYS)))
    if (useProfile && r === 1) {
      const prof = await app.send('Profiler.stop')
      fs.writeFileSync(
        path.join(
          __dirname,
          '..',
          'out',
          `_probe-perf-${label.replace(/[^\w.-]/g, '_')}.cpuprofile`
        ),
        JSON.stringify(prof.result.profile)
      )
    }
    perRun.push(stats(res.times))
    all.push(...res.times)
    mdCalls += res.mdCalls
    mdMs += res.mdMs
    renderCalls += res.renderCalls
    renderMs += res.renderMs
    lastDiag = res.diag
    await sleep(150)
  }
  const st = stats(all)
  out(
    `\n[${label}] 每键耗时(ms) avg=${st.avg} p50=${st.p50} p95=${st.p95} max=${st.max}` +
      ` | MarkdownParser.parse ${mdCalls} 次/${mdMs.toFixed(1)}ms` +
      ` | md.render ${renderCalls} 次/${renderMs.toFixed(1)}ms` +
      ` | 三次重复 p95=${perRun.map((x) => x.p95).join('/')}`
  )
  return { ...st, mdCalls, mdMs, perRun, diag: lastDiag }
}

/** 汇总 CPU profile：按 functionName + url:line 聚合自带时间 */
function topFrames(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byId = new Map()
  for (const n of p.nodes) byId.set(n.id, n)
  const self = new Map()
  let total = p.timeDeltas.reduce((a, b) => a + b, 0)
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i])
    if (!n) continue
    const cf = n.callFrame
    const key = `${cf.functionName || '(anonymous)'} @ ${String(cf.url).split('/').pop()}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0))
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
  out(`  CPU 采样合计 ${(total / 1000).toFixed(0)}ms，自带时间 top:`)
  for (const [k, us] of rows) out(`    ${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`)
  const mdTotal = [...self.entries()]
    .filter(([k]) => /markdown|MarkdownIt|parse @|scanDelims|emphasis/.test(k))
    .reduce((a, b) => a + b[1], 0)
  out(`    （含 markdown-it 相关帧合计 ≈ ${(mdTotal / 1000).toFixed(1)}ms）`)
}

async function main() {
  app = await connect()
  if (!(await settle(app.ev))) throw new Error('应用未就绪')
  if (!(await waitEditor(app.ev))) throw new Error('编辑器未就绪')
  const backup = JSON.parse(
    await app.ev(`JSON.stringify({ autoSave: window.__L.settings().autoSave })`)
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(150)

  out(`## 打字每键耗时（每键 = 一次 ed.commands.insertContent，页面内 performance.now() 包裹）`)
  out(`KEYS=${KEYS} RUNS=${RUNS}`)
  out(`A/B/C 与 D/E、F/G 分别量两个维度：①「被编辑的那个块有多长」②「文档有多长」`)

  // ① 被编辑块长度维度
  await measure('A 空段落（对照）', '\n', true)
  await measure('B 单段 500 字', longParagraph(500) + '\n', false)
  await measure('C 单段 3000 字', longParagraph(3000) + '\n', true)
  // ② 文档长度维度（被编辑的段落等长，只在末尾追加别的段落）
  await measure('D 8 段 ≈500 字（都有加粗）', manyBlocks(8, 60) + '\n', false)
  await measure('E 50 段 ≈3000 字（都有加粗）', manyBlocks(50, 60) + '\n', false)
  await measure(
    'F 500 字被编辑段 + 2000 字别的段',
    longParagraph(500) + '\n\n' + manyBlocks(33, 60) + '\n',
    false
  )
  await measure(
    'G 500 字被编辑段 + 8000 字别的段',
    longParagraph(500) + '\n\n' + manyBlocks(133, 60) + '\n',
    false
  )

  out(`\n诊断（最后一个场景）：${JSON.stringify(lastDiag)}`)

  for (const [title, key] of [
    ['A 空段落（对照）', 'A'],
    ['C 单段 3000 字', 'C'],
    ['E 50 段 ≈3000 字（都有加粗）', 'E']
  ]) {
    out(`\n## 热点（${title} CPU 采样）`)
    try {
      const want = `${key} `
      const f = fs
        .readdirSync(path.join(__dirname, '..', 'out'))
        .find((n) => n.startsWith('_probe-perf-') && n.includes(want))
      if (!f) throw new Error('找不到 profile 文件')
      topFrames(path.join(__dirname, '..', 'out', f))
    } catch (e) {
      out('  (profile 解析失败: ' + e.message + ')')
    }
  }

  await app.ev(
    `(() => { window.__L.settings().set('autoSave', ${JSON.stringify(backup.autoSave)}); return 'ok' })()`
  )
  app.close()
  const dest = path.join(__dirname, '..', 'out', '_probe-perf.txt')
  fs.writeFileSync(dest, lines.join('\n'), 'utf-8')
  console.log('\n(完整输出已写入 ' + dest + ')')
  console.log('--- 1/1 PASS')
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
