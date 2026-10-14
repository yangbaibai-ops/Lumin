(() => {
  const out = []
  const m = document.querySelector('.ProseMirror [data-md-math-rendered]')
  if (!m) return 'NO-MATH'
  const walk = (el, d) => {
    if (d > 6) return
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    out.push(`${'  '.repeat(d)}${el.tagName}${el.className ? '.' + String(el.className).split(' ').join('.') : ''} disp=${cs.display} lh=${cs.lineHeight} fs=${cs.fontSize} va=${cs.verticalAlign} box=[${r.left.toFixed(1)},${r.top.toFixed(1)},${r.right.toFixed(1)},${r.bottom.toFixed(1)}] h=${r.height.toFixed(2)}`)
    for (const c of el.children) walk(c, d + 1)
    if (el.children.length === 0 || d <= 2) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          const rg = document.createRange(); rg.selectNodeContents(n)
          const rs = [...rg.getClientRects()].map((q) => `${q.left.toFixed(1)},${q.top.toFixed(1)},${q.right.toFixed(1)},${q.bottom.toFixed(1)}`)
          out.push(`${'  '.repeat(d + 1)}#text "${n.textContent.slice(0, 6)}" rects=${JSON.stringify(rs)}`)
        }
      }
    }
  }
  walk(m, 0)
  const par = m.closest('p')
  out.push(`P lh=${getComputedStyle(par).lineHeight} font=${getComputedStyle(par).font} boxH=${par.getBoundingClientRect().height.toFixed(2)}`)
  const src = m.parentElement && m.parentElement.querySelector('.md-math-source')
  if (src) { const cs = getComputedStyle(src); out.push(`SOURCE disp=${cs.display} fs=${cs.fontSize} lh=${cs.lineHeight} rect=${JSON.stringify(src.getBoundingClientRect())}`) }
  return out.join('\n')
})()
