const fs = require('fs')
const p = 'tmp/sel-live-125.js'
let s = fs.readFileSync(p, 'utf8')
const reps = [
  ['const px = (img, x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]] }',
    'const px = (img, x, y) => img.px(Math.round(x), Math.round(y))'],
  // frame(): 加 editing 与选区类型
  ["        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), own: d.getAttribute('data-sel-own'), miss: d.getAttribute('data-sel-band-miss'),",
    "        const rev = document.querySelector('.ProseMirror [data-img-revealed]')\n        return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), type: (s.jsonID || (s.constructor && s.constructor.name) || '?'), own: d.getAttribute('data-sel-own'), miss: d.getAttribute('data-sel-band-miss'), editing: rev ? String(rev.className).includes('--editing') : null,"],
  // 表头：按在**真实字形**上
  ["    const thT = info.thText\n    const cx = Math.round((thT[0] + thT[2]) / 2)\n    const cy = Math.round((thT[1] + thT[3]) / 2)",
    "    const thT = await json(`(() => { const th = document.querySelector('.ProseMirror th, .ProseMirror thead td'); if (!th) return null; const w = document.createTreeWalker(th, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()`)\n    log(`# 表头字形盒=${JSON.stringify(thT)}`)\n    const cx = Math.round((thT[0] + thT[2]) / 2)\n    const cy = Math.round((thT[1] + thT[3]) / 2)"],
  // S 用例：按在**源码第一个字形**上
  ["      if (rv && rv.length) { from = { x: Math.round(rv[0][0] + 12), y: Math.round((rv[0][1] + rv[0][3]) / 2) }; to = { x: Math.round(rv[0][2] - 30), y: from.y } }",
    "      const glyph = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = null; while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break } if (!n) return null; const rg = document.createRange(); rg.setStart(n, 0); rg.setEnd(n, Math.min(2, n.length)); const r = rg.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] })()`)\n      if (glyph) { from = { x: Math.round((glyph[0] + glyph[2]) / 2), y: Math.round((glyph[1] + glyph[3]) / 2) }; to = { x: from.x + 150, y: from.y } }\n      else if (rv && rv.length) { from = { x: Math.round(rv[0][0] + 12), y: Math.round((rv[0][1] + rv[0][3]) / 2) }; to = { x: Math.round(rv[0][2] - 30), y: from.y } }"]
]
let n = 0
for (const [a, b] of reps) { if (s.includes(a)) { s = s.split(a).join(b); n++ } else console.log('MISS', a.slice(0, 60)) }
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
