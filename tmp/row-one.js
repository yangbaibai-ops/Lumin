'use strict'
// 打印 sweep 里指定窗口/widget 的完整明细
const fs = require('fs')
const o = JSON.parse(fs.readFileSync('tmp/row-sweep.json', 'utf8'))
const w = Number(process.argv[2] || 1424)
const idx = Number(process.argv[3] || 1)
for (const e of o.widths) {
  if (e.window !== w) continue
  const s = e.sources.find((x) => x.widgetIndex === idx)
  if (!s) continue
  console.log(`--- window=${e.window} innerWidth=${e.innerWidth} widget#${idx} revealedFrom=${s.revealedFrom} len=${s.revealedLen}`)
  console.log('block', JSON.stringify(s.block))
  console.log('imgsAll', JSON.stringify(s.imgsAll))
  console.log('overlayRects', JSON.stringify(s.overlayRects))
  s.frags.forEach((f, i) => console.log(`frag#${i}`, JSON.stringify(f.frag), 'line', JSON.stringify(f.line), 'lineImgs', JSON.stringify(f.lineImgs), 'assessment', JSON.stringify(s.assessment[i])))
}
