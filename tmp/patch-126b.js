const fs = require('fs')
const p = 'tmp/settle-126.js'
let s = fs.readFileSync(p, 'utf8')
// ptText 改成"任意文本节点里找 prefix"（支持句中匹配）
const a1 = `      ptText(prefix, frac) {
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
      },`
const b1 = `      ptText(prefix, frac) {
        const root = document.querySelector('.ProseMirror')
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let n = null
        while ((n = w.nextNode())) {
          const t = n.textContent || ''
          if (!t.trim().length) continue
          if (t.includes(prefix)) break
        }
        if (!n) return null
        const t = n.textContent || ''
        const i = Math.max(0, t.indexOf(prefix))
        const L = Math.max(1, prefix.length)
        const a = Math.max(0, Math.min(t.length - 1, Math.round(i + (frac || 0) * L)))
        const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, Math.min(t.length, a + 2))
        const r = rg.getBoundingClientRect()
        if (!(r.width || r.height)) { const pr = n.parentElement.getBoundingClientRect(); return [Math.round(pr.left + 20), Math.round((pr.top + pr.bottom) / 2)] }
        return [Math.round(r.left + (r.width || 4) / 2), Math.round((r.top + r.bottom) / 2)]
      },`
if (!s.includes(a1)) console.log('MISS a1')
s = s.split(a1).join(b1)
// 打印落定输入诊断
s = s.replace("const post = await json(`(() => { const d = document.querySelector('.ProseMirror'); const s = window.__vt.ed().state.selection; return { fallback: d.getAttribute('data-img-settle-fallback')",
  "const post = await json(`(() => { const d = document.querySelector('.ProseMirror'); const s = window.__vt.ed().state.selection; return { fallback: d.getAttribute('data-img-settle-fallback'), settleIn: d.getAttribute('data-img-settle-in')")
s = s.replace("log(`   松手后: 模型=${settled.sel}${settled.empty ? 'E' : ''} type=${settled.type} 原生=${JSON.stringify(settled.nat)} | fallback=${post.fallback} 残留带=${post.band}`)",
  "log(`   松手后: 模型=${settled.sel}${settled.empty ? 'E' : ''} type=${settled.type} 原生=${JSON.stringify(settled.nat)} | fallback=${post.fallback} 残留带=${post.band}`)\n    log(`   落定输入: ${post.settleIn}`)")
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
