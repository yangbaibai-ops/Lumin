const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
const start = s.indexOf('      ptText(prefix, frac) {')
const end = s.indexOf('      /** 某文档位置附近的可点坐标', start)
if (start < 0 || end < 0) { console.log('MARKER MISS', start, end); process.exit(1) }
const body = `      ptText(prefix, frac) {
        const cands = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror pre, .ProseMirror li, .ProseMirror td, .ProseMirror th')]
        const hits = cands.filter((x) => (x.textContent || '').indexOf(prefix) >= 0)
        if (!hits.length) return null
        // 取"最小的命中元素"（避免命中祖先）
        const el = hits.reduce((a, b) => ((a.textContent || '').length <= (b.textContent || '').length ? a : b))
        el.scrollIntoView({ block: 'center' })
        const full = el.textContent || ''
        const off = full.indexOf(prefix) + Math.round((frac || 0) * prefix.length)
        // 把 full 的偏移映射到具体文本节点（KaTeX/高亮会把文本拆成很多节点）
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let acc = 0
        let n = null
        let local = 0
        while ((n = w.nextNode())) {
          const L = (n.textContent || '').length
          if (off < acc + L) { local = off - acc; break }
          acc += L
        }
        if (!n) return null
        const L = (n.textContent || '').length
        const a = Math.max(0, Math.min(L - 1, local))
        const rg = document.createRange()
        rg.setStart(n, a)
        rg.setEnd(n, Math.min(L, a + 1))
        const r = rg.getBoundingClientRect()
        if (!(r.width || r.height)) {
          const pr = el.getBoundingClientRect()
          return [Math.round(pr.left + 20), Math.round((pr.top + pr.bottom) / 2)]
        }
        return [Math.round(r.left + (r.width || 4) / 2), Math.round((r.top + r.bottom) / 2)]
      },
`
s = s.slice(0, start) + body + s.slice(end)
fs.writeFileSync(p, s, 'utf8')
console.log('ptText replaced')
