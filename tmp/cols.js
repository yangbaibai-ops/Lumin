'use strict'
/** node tmp/cols.js <png> <y0> <y1> <x1> <x2> ... → 每列上"非纸面"连续段（含纸面/带/墨迹分类） */
const fs = require('fs')
const { decodePng, paperColor, DIFF } = require('./png-util.js')
const [f, y0, y1, ...xs] = process.argv.slice(2)
const img = decodePng(fs.readFileSync(f))
const paper = paperColor(img)
console.log(`# ${f} paper=${paper.join(',')}`)
for (const xx of xs) {
  const x = +xx
  const runs = []
  let cur = null
  for (let y = +y0; y <= +y1; y++) {
    const p = img.px(x, y)
    const nb = DIFF(p, paper) > 6
    if (nb) { if (!cur) cur = { t: y, b: y, ink: 0 } ; cur.b = y; if (p[0] < 150) cur.ink++ }
    else if (cur) { runs.push(cur); cur = null }
  }
  if (cur) runs.push(cur)
  console.log(`x=${String(x).padStart(4)} runs=` + JSON.stringify(runs.map((r) => `[${r.t}..${r.b}]h${r.b - r.t + 1}ink${r.ink}`)))
}
