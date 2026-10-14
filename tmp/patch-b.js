const fs = require('fs')
const p = 'tmp/sel-formula-123.js'
let s = fs.readFileSync(p, 'utf8')
const a = 'log(`    公式[${m.s},${m.e}) 矩形=${JSON.stringify(m.rect)} 旧口径命中=${m.oldHit} 新口径命中=${m.newHit}`)'
const b = 'log(`    公式[${m.s},${m.e}) 矩形=${JSON.stringify(m.rect)} 实际画到=${m.painted} 旧口径命中=${m.oldHit} 新口径命中=${m.newHit} 模型含=${m.modelCovered}`)'
const c = 'log(`    选区∩公式数=${rec.mid.selInMath}  松手后 sel=${rec.settledSel} 松手后公式命中=${JSON.stringify(rec.settledMaths.map((m) => m.newHit))}`)'
const d = 'log(`    选区∩公式数=${rec.mid.selInMath} 负责区间=${JSON.stringify(rec.mid.union)}  松手后 sel=${rec.settledSel} 松手后实际画到=${JSON.stringify(rec.settledMaths.map((m) => m.painted))}`)'
const e = 'frames: frames.map((f) => `${f.sel}|own${f.own}|bands${f.bands.length}|minL${f.bandMinLeft}|maxR${f.bandMaxRight}|old${f.maths.filter((m) => m.oldHit).length}|new${f.maths.filter((m) => m.newHit).length}`)'
const f2 = 'frames: frames.map((f) => `${f.sel}|own${f.own}|bands${f.bands.length}|minL${f.bandMinLeft}|maxR${f.bandMaxRight}|oldHit${f.maths.filter((m) => m.oldHit).length}|newHit${f.maths.filter((m) => m.newHit).length}|painted${f.maths.filter((m) => m.painted).length}`)'
let n = 0
for (const [from, to] of [[a, b], [c, d], [e, f2]]) {
  if (s.includes(from)) { s = s.split(from).join(to); n++ } else console.log('MISS:', from.slice(0, 50))
}
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
