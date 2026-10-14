'use strict'
const fs = require('fs')
const o = JSON.parse(fs.readFileSync(`tmp/row107-${process.argv[2] || 'a'}.json`, 'utf8'))
const L = []
const R = (x) => (x ? `${x.top}..${x.bottom} h${x.height}` : 'null')
L.push(`innerWidth=${o.innerWidth} mdLen=${o.fixture.mdLen} press/release=${o.bysource.map((b) => b.press + '/' + b.release).join(',')} bg=${o.bysource.map((b) => b.bg).join(',')}`)
L.push('FRAMES(逐帧去重) ' + JSON.stringify(o.bysource.map((b) => b.frames)))
for (const b of o.bysource) {
  L.push(`== widget#${b.widget}（revealed from=${b.from} len=${b.len}）block=${JSON.stringify(b.block)}`)
  L.push('   overlay(DOM) ' + JSON.stringify(b.overlays.map((x) => `l${x.l} t${x.t} b${x.b} h${x.h}`)))
  L.push('   同行图片 ' + JSON.stringify(b.widgets.map((w) => `t${w.t}..${w.b} h${w.h}`)))
  b.frags.forEach((f, i) => {
    const p = b.pix[i] || {}
    const css = p.bgOff
    const ov = p.bgOn
    const real = css && ov ? { top: Math.min(css.top, ov.top), bottom: Math.max(css.bottom, ov.bottom) } : css || ov
    const realH = real ? +(real.bottom - real.top + 1).toFixed(2) : null
    const rowH = f.row ? f.row.h : null
    L.push(`   frag#${i} ${JSON.stringify(f.frag)}  行盒=${JSON.stringify(f.row)}`)
    L.push(`        同行图片=${JSON.stringify(b.widgets.map((w) => w.h))} | 实画(并集)=${real ? real.top + '..' + real.bottom + ' h' + realH : 'null'} | CSS 带=${R(css)} | 覆盖层净增=${R(ov)}`)
    L.push(`        Δh(实画 vs 行盒)=${realH != null && rowH != null ? +(realH - rowH).toFixed(2) : 'n/a'} | Δtop=${real && f.row ? +(real.top - f.row.t).toFixed(2) : 'n/a'} | Δbottom=${real && f.row ? +(real.bottom - f.row.b).toFixed(2) : 'n/a'} | 原生选区实画=${R(p.selBand)} | 选区API=${JSON.stringify(p.selApi)}`)
  })
}
L.push('EDIT ' + JSON.stringify(o.editing))
L.push('HIDDEN ' + JSON.stringify(o.hiddenAfter) + ' mdRoundtripSame=' + o.mdRoundtripSame)
L.push('MOUSE ' + JSON.stringify(o.mouse))
L.push('AB(覆盖层开/关布局一致) same=' + o.ab.same + ' on=' + JSON.stringify(o.ab.on))
L.push('BLOCK ' + JSON.stringify(o.block))
L.push('layoutHidden ' + JSON.stringify(o.layoutHidden) + ' modalAtEnd=' + o.modalAtEnd)
fs.writeFileSync(`tmp/row107-${process.argv[2] || 'a'}.txt`, L.join('\n'))
console.log(L.join('\n'))
