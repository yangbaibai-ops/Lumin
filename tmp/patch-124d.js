const fs = require('fs')
const p = 'tmp/sel-user-124.js'
let s = fs.readFileSync(p, 'utf8')
const a = `    const idx = bk.findIndex((b) => b.text.includes('行内公式'))`
const b = `    const curPos = await ev(\`(() => { const v = window.__vt.ed().view; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); try { return v.posAtDOM(p, 0) } catch (e) { return -1 } })()\`)
    const idx = bk.findIndex((bl) => bl.from <= curPos && curPos <= bl.to)`
if (!s.includes(a)) console.log('MISS idx')
s = s.split(a).join(b)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
