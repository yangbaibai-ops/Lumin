'use strict'
// 读 CPU profile，按 functionName + url:line 聚合自带时间（self time）
const fs = require('fs')
const path = require('path')

function topFrames(file, top = 20) {
  const p = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byId = new Map()
  for (const n of p.nodes) byId.set(n.id, n)
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
  console.log(
    `\n### ${path.basename(file)}  采样合计 ${(total / 1000).toFixed(0)}ms  (${p.samples.length} samples)`
  )
  for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`  ${(us / 1000).toFixed(1).padStart(9)}ms  ${k}`)
  }
  return total
}

for (const f of process.argv.slice(2)) {
  try {
    topFrames(f)
  } catch (e) {
    console.log('ERR ' + f + ' ' + e.message)
  }
}
