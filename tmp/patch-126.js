const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// 用"文本起头"找元素 → Range 取坐标（domAtPos 对块边界取不到矩形）
const a1 = `      /** 某文档位置附近的可点坐标（用 Range 客户端矩形） */
      caret(pos) {`
const b1 = `      /** 用"文本起头"定位元素，然后在该元素前两个字上取点（拖动起/终点用） */
      ptText(prefix, frac) {
        const els = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror pre, .ProseMirror li')]
        const el = els.find((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(prefix))
        if (!el) return null
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let n = null
        while ((n = w.nextNode())) { if ((n.textContent || '').trim().length) break }
        if (!n) { const r = el.getBoundingClientRect(); return [Math.round(r.left + 20), Math.round((r.top + r.bottom) / 2)] }
        const L = n.length
        const a = Math.max(0, Math.min(L - 1, Math.floor((frac || 0) * L)))
        const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, Math.min(L, a + 2))
        const r = rg.getBoundingClientRect()
        return [Math.round(r.left + (r.width || 4) / 2), Math.round((r.top + r.bottom) / 2)]
      },
      /** 某文档位置附近的可点坐标（用 Range 客户端矩形） */
      caret(pos) {`
if (!s.includes(a1)) console.log('MISS a1')
s = s.split(a1).join(b1)
// 端点改用 ptText
const a2 = `  const caseList = []
  if (ONLY === 'all' || ONLY === 'table') {
    const before = B.find((b) => b.name === 'paragraph') || first
    const after = B[B.length - 1]
    caseList.push(['table-fwd', await pt(before.from + 3), await pt(Math.max(after.from + 2, after.to - 3))])
    caseList.push(['table-back', await pt(Math.max(after.from + 2, after.to - 3)), await pt(before.from + 3)])
  }`
const b2 = `  const P = (prefix, frac) => json(\`window.__P.ptText(\${JSON.stringify(prefix)}, \${frac || 0})\`)
  const caseList = []
  const mk = async (label, a1, f1, a2, f2) => {
    const A = await P(a1, f1), Bp = await P(a2, f2)
    if (!A || !Bp) { log(\`# \${label} 端点取不到：\${a1} / \${a2}\`); return }
    caseList.push([label, A, Bp])
  }
  if (ONLY === 'all' || ONLY === 'table') {
    await mk('table-fwd', '工作方式', 0.9, 'flowchart LR', 0.05)
    await mk('table-back', 'flowchart LR', 0.05, '工作方式', 0.9)
  }
  if (ONLY === 'all' || ONLY === 'math') {
    await mk('math-block-fwd', '块级公式', 0.9, '2', 0.5)
    await mk('math-block-back', '2', 0.5, '块级公式', 0.9)
    await mk('math-inline-fwd', '下划线不当斜体', 0.05, '结束', 0.9)
    await mk('math-inline-back', '结束', 0.9, '下划线不当斜体', 0.05)
  }
  if (ONLY === 'all' || ONLY === 'img') {
    await mk('img-fwd', '行内公式$E', 0.02, '工作方式', 0.9)
    await mk('img-back', '工作方式', 0.9, '行内公式$E', 0.02)
  }`
if (!s.includes(a2)) console.log('MISS a2')
s = s.split(a2).join(b2)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
