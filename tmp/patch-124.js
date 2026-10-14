const fs = require('fs')
const p = 'tmp/sel-anchor-124.js'
let s = fs.readFileSync(p, 'utf8')
const reps = [
  [
    'const badModel = fs2.filter((f) => f.fromBlk === prevIdx || f.toBlk === prevIdx || (f.anchorBlk === prevIdx))',
    [
      "const SRC = (typeof S !== 'undefined' && S) ? S : { from: NaN, to: NaN }",
      '    const anchorInSrc = (f) => f.anchor != null && SRC.from <= f.anchor && f.anchor < SRC.to',
      '    const badAnchor = fs2.filter((f) => f.anchor != null && !anchorInSrc(f))',
      '    const badModel = fs2.filter((f) => f.fromBlk === prevIdx || f.toBlk === prevIdx || (f.anchorBlk === prevIdx))'
    ].join('\n')
  ],
  [
    'log(`   ★ 模型/锚点越界帧=${badModel.length}/${fs2.length}',
    'log(`   ★ 锚点不在源码区间[${SRC.from},${SRC.to})的帧=${badAnchor.length}/${fs2.length}${badAnchor.length ? \' \' + JSON.stringify(badAnchor.slice(0, 3).map((f) => ({ t: f.t, sel: f.sel, anchor: f.anchor, fromBlk: f.fromBlk, toBlk: f.toBlk }))) : \'\'}`)\n    log(`   ★ 模型/锚点越界帧=${badModel.length}/${fs2.length}'
  ],
  [
    'return { label, from, to, frames: fs2, mid, settled, rowScan, badModel: badModel.length, badNat: badNat.length, bandTop, prevRow }',
    'return { label, from, to, frames: fs2, mid, settled, rowScan, badModel: badModel.length, badAnchor: badAnchor.length, badNat: badNat.length, bandTop, prevRow, srcRange: [SRC.from, SRC.to] }'
  ]
]
let n = 0
for (const [a, b] of reps) {
  if (s.includes(a)) { s = s.split(a).join(b); n++ } else console.log('MISS:', a.slice(0, 60))
}
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
