const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// ptText：先 scrollIntoView（否则元素在视口外，按下落空）
const a = `        const els = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror pre, .ProseMirror li')]
        const el = els.find((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(prefix))
        if (!el) return null`
const b = `        const els = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror pre, .ProseMirror li')]
        const el = els.find((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(prefix))
        if (!el) return null
        el.scrollIntoView({ block: 'center' })`
if (!s.includes(a)) console.log('MISS scroll')
s = s.split(a).join(b)
// 跨表用例存截图（验收 ⑦）
s = s.replace("    await shot(`${label}-live`)", "    await shot(`${label}-live`)\n    if (label === 'table-fwd') { try { fs.copyFileSync(path.join(OUTDIR, `${TAG}-${label}-live.png`), path.join(__dirname, 'cross-table-settle.png')) } catch (e) { /* ignore */ } }")
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
