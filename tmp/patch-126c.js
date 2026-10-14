const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
const a = `  if (ONLY === 'all' || ONLY === 'math') {
    await mk('math-block-fwd', '块级公式', 0.9, '2', 0.5)
    await mk('math-block-back', '2', 0.5, '块级公式', 0.9)
    await mk('math-inline-fwd', '下划线不当斜体', 0.05, '结束', 0.9)
    await mk('math-inline-back', '结束', 0.9, '下划线不当斜体', 0.05)
  }
  if (ONLY === 'all' || ONLY === 'img') {
    await mk('img-fwd', '行内公式$E', 0.02, '工作方式', 0.9)
    await mk('img-back', '工作方式', 0.9, '行内公式$E', 0.02)
  }`
const b = `  if (ONLY === 'all' || ONLY === 'math') {
    await mk('math-block-fwd', '块级公式', 0.9, 'gyg', 0.5)
    await mk('math-block-back', 'gyg', 0.5, '块级公式', 0.9)
    await mk('math-inline-fwd', '下划线不当斜体', 0.05, '结束', 0.9)
    await mk('math-inline-back', '结束', 0.9, '下划线不当斜体', 0.05)
  }
  if (ONLY === 'all' || ONLY === 'img') {
    await mk('img-fwd', '行内公式E', 0.02, '工作方式', 0.9)
    await mk('img-back', '工作方式', 0.9, '行内公式E', 0.02)
  }`
if (!s.includes(a)) console.log('MISS')
s = s.split(a).join(b)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
