const fs = require('fs')
const p = 'tmp/sel-live-125.js'
let s = fs.readFileSync(p, 'utf8')
// T 用例：按下前**重新读一次**表头字形盒（避免 click-away 造成的滚动/布局漂移）
const a1 = `  const runDrag = async (label, from, to, samplePts, frames = 14) => {
    await click(away.x, away.y, 320)`
const b1 = `  const headerGlyph = () => json(\`(() => { const th = document.querySelector('.ProseMirror th, .ProseMirror thead td, .ProseMirror td'); if (!th) return null; const w = document.createTreeWalker(th, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()\`)

  const runDrag = async (label, from, to, samplePts, frames = 14) => {
    await click(away.x, away.y, 320)`
if (!s.includes(a1)) console.log('MISS a1')
s = s.split(a1).join(b1)
// 在 runDrag 内部（click-away 之后）对 T 用例刷新坐标
const a2 = `    if (label.startsWith('S')) { // 点图显形，然后**立刻**在源码上按下`
const b2 = `    if (label.startsWith('T')) { // 按下前重新量一次表头字形（避免漂移）
      const g = await headerGlyph()
      if (g) { from = { x: Math.round((g[0] + g[2]) / 2), y: Math.round((g[1] + g[3]) / 2) }; to = { x: from.x + Math.min(140, Math.max(60, g[2] - g[0] + 100)), y: from.y } }
    }
    if (label.startsWith('S')) { // 点图显形，然后**立刻**在源码上按下`
if (!s.includes(a2)) console.log('MISS a2')
s = s.split(a2).join(b2)
// 表头用例的采样点：同一帧派生的已经有了，额外加"表头行中心偏下"
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
