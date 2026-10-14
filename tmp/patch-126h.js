const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// 加一个"按选择器/bounding box 取点"的助手（不依赖文本节点切分）
const start = s.indexOf('      /** 某文档位置附近的可点坐标')
if (start < 0) { console.log('MISS'); process.exit(1) }
const helper = `      /** 按"地标名"取点（矩形法，不依赖文本节点切分） */
      ptMark(kind, frac) {
        const q = (sel) => [...document.querySelectorAll(sel)]
        let el = null
        if (kind === 'heading') el = q('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')[0]
        else if (kind === 'codeblock') el = q('.ProseMirror pre').find((x) => (x.textContent || '').includes('flowchart'))
        else if (kind === 'imgpara') {
          const p = q('.ProseMirror p').find((x) => x.querySelector('[data-img-widget]'))
          el = p || null
        }
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        const x = Math.round(r.left + Math.max(6, r.width * (frac == null ? 0.5 : frac)))
        const y = Math.round((r.top + r.bottom) / 2)
        return [x, y]
      },
`
s = s.slice(0, start) + helper + s.slice(start)
// 四个用例改用 ptMark
const a = `  if (ONLY === 'all' || ONLY === 'table') {
    await mk('table-fwd', '工作方式', 0.9, 'flowchart', 0.05)
    await mk('table-back', 'flowchart', 0.05, '工作方式', 0.9)
  }`
const b = `  const mk2 = async (label, k1, f1, k2, f2) => {
    const A = await json(\`window.__P.ptMark(\${JSON.stringify(k1)}, \${f1})\`)
    const Bp = await json(\`window.__P.ptMark(\${JSON.stringify(k2)}, \${f2})\`)
    if (!A || !Bp) { log(\`# \${label} 端点取不到：\${k1} / \${k2}\`); return }
    caseList.push([label, A, Bp])
  }
  if (ONLY === 'all' || ONLY === 'table') {
    await mk2('table-fwd', 'heading', 0.9, 'codeblock', 0.05)
    await mk2('table-back', 'codeblock', 0.05, 'heading', 0.9)
  }`
if (!s.includes(a)) console.log('MISS table list')
s = s.split(a).join(b)
const a2 = `    await mk('img-fwd', '行内公式$E', 0.02, '工作方式', 0.9)
    await mk('img-back', '工作方式', 0.9, '行内公式$E', 0.02)`
const b2 = `    await mk2('img-fwd', 'imgpara', 0.02, 'heading', 0.9)
    await mk2('img-back', 'heading', 0.9, 'imgpara', 0.02)`
if (!s.includes(a2)) console.log('MISS img list')
s = s.split(a2).join(b2)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
