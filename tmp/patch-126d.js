const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
const a = "'行内公式E'"
const b = "'行内公式$E'"
const n = s.split(a).length - 1
s = s.split(a).join(b)
fs.writeFileSync(p, s, 'utf8')
console.log('replaced', n)
