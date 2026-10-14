const fs = require('fs')
const p = 'tmp/sel-user-124.js'
let s = fs.readFileSync(p, 'utf8')
const a = 'const rows = [{ 行中部: 372 }, { 行盒上方: 358 }, { 下方空白: 470 }]'
const b = "const rows = [['行中部', 372], ['行盒上方', 358], ['下方空白', 470]]"
const c = 'const xs = { 左: 342, 中: 640, 右: 1000 }'
const d = "const xs = [['左', 342], ['中', 640], ['右', 1000]]"
let n = 0
for (const [x, y] of [[a, b], [c, d]]) { if (s.includes(x)) { s = s.split(x).join(y); n++ } else console.log('MISS', x.slice(0, 40)) }
fs.writeFileSync(p, s, 'utf8')
console.log('patched', n)
