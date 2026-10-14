const fs = require('fs')
const p = 'tmp/sel-anchor-124.js'
let s = fs.readFileSync(p, 'utf8')
const a = `  const hold = async (label, from, to, frames = 16) => {
    await click(950, 830, 260)
    // 每次都重新确认源码显形（点空白带）
    if (!(await ev(\`document.querySelectorAll('.ProseMirror [data-img-revealed]').length\`))) await click(Math.round(img2[2] + 26), Math.round((img2[1] + img2[3]) / 2), 420)`
const b = `  /** 保证处于"**源码显形且非编辑态**"（用户报障的那个状态）：编辑态下 bandAt 不接管，量出来的不是我们要的场景 */
  const ensureRevealed = async () => {
    for (let k = 0; k < 5; k++) {
      const st = await json(\`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? { editing: String(el.className).includes('--editing') } : null })()\`)
      if (st && !st.editing) return true
      await click(950, 830, 320)
      await sleep(150)
    }
    await click(Math.round(img2[2] + 26), Math.round((img2[1] + img2[3]) / 2), 500)
    return false
  }

  const hold = async (label, from, to, frames = 16) => {
    await click(950, 830, 260)
    await ensureRevealed()`
if (!s.includes(a)) { console.log('MISS A'); } else { s = s.split(a).join(b); }
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
