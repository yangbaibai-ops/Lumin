'use strict'
// 汇总 row-repro 结果
const fs = require('fs')
const W = process.argv[2] || '1920'
const o = JSON.parse(fs.readFileSync(`tmp/row-repro-${W}.json`, 'utf8'))
const lines = []
lines.push(`innerWidth=${o.innerWidth} blockW=${JSON.stringify(o.doc)} press=${o.press} release=${o.release}`)
lines.push('FRAMES ' + JSON.stringify(o.frames.map((f) => f.open + '/' + f.n + '/' + f.ov).filter((v, i, a) => i === 0 || v !== a[i - 1])))
for (const g of o.geom) {
  lines.push(`== revealed ${g.cls} from=${g.from} len=${g.textLen} block=${JSON.stringify(g.block)}`)
  lines.push('   imgs ' + JSON.stringify(g.imgs))
  lines.push('   widgetSpans ' + JSON.stringify(g.widgetSpans))
  lines.push(`   overlay ${JSON.stringify(g.overlayRects)} count=${g.overlayCount}`)
  g.frags.forEach((f, i) => {
    lines.push(`   frag#${i} ${JSON.stringify(f.frag)} strut=${f.strut} union=${JSON.stringify(f.union)} union>strut:${f.unionGtStrut} union>frag:${f.unionGtFrag}`)
    lines.push('      participants: ' + JSON.stringify(f.participants.map((p) => `${p.src}:${p.tag}.${p.cls} ${p.t}-${p.b} h${p.h}`)))
  })
}
lines.push('PIXELS ' + JSON.stringify(o.pixels, null, 1))
fs.writeFileSync(`tmp/row-repro-${W}.txt`, lines.join('\n'))
console.log(lines.join('\n'))
