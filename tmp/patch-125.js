const fs = require('fs')
const p = 'tmp/sel-live-125.js'
let s = fs.readFileSync(p, 'utf8')
const reps = [
  ['const resMax = fs2.map((f) => f.residue.filter((r) => !r.coveredVisible).length)',
    'const resMax = fs2.map((f) => (f.residue || []).filter((r) => !r.coveredVisible).length)'],
  ['    fs2.push(await json(`window.__P.frame()`))',
    '    const f0 = await json(`window.__P.frame()`); f0.residue = await json(`window.__P.residue()`); fs2.push(f0)'],
  ["log(`# 环境：view.dom 背景=${info.domBg}  .sel-band=${JSON.stringify(info.bandCss)}`)",
    "log(`# 环境：令牌 sel=${info.tokens.sel} edge=${info.tokens.edge} panel2=${info.tokens.panel2}`)\n  log(`# 环境：view.dom 背景=${info.domBg}  .sel-band=${JSON.stringify(info.bandCss)}`)"]
]
let n = 0
for (const [a, b] of reps) { if (s.includes(a)) { s = s.split(a).join(b); n++ } else console.log('MISS', a.slice(0, 50)) }
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
