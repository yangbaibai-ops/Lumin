const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// off 越界 clamp（frac=0.9 时 indexOf+len 会等于全长 ⇒ 走 null）
s = s.replace(
  "        const off = full.indexOf(prefix) + Math.round((frac || 0) * prefix.length)",
  "        const off = Math.max(0, Math.min(full.length - 1, full.indexOf(prefix) + Math.round((frac || 0) * prefix.length)))"
)
// 代码块前缀换成单节点可见词
s = s.split("'flowchart LR'").join("'flowchart'")
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
