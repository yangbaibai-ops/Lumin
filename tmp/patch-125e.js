const fs = require('fs')
const p = 'tmp/sel-live-125.js'
let s = fs.readFileSync(p, 'utf8')
// ① 增加"原生 rect 下方 40px"（源码下方空白带）采样点
const a1 = `    if (nat0) derived.push({ name: '原生rect中心', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round((nat0[1] + nat0[3]) / 2) })`
const b1 = `    if (nat0) derived.push({ name: '原生rect中心', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round((nat0[1] + nat0[3]) / 2) })
    if (nat0) derived.push({ name: '原生rect下方40px(空白带)', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round(nat0[3] + 40) })
    if (nat0) derived.push({ name: '原生rect上方8px', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round(nat0[1] - 8) })`
if (!s.includes(a1)) console.log('MISS a1')
s = s.split(a1).join(b1)
// ② REPEAT 模式：连做 5 次
const a2 = `  fs.writeFileSync(path.join(OUTDIR, \`sellive125-\${TAG}.json\`), JSON.stringify(out, null, 1))`
const b2 = `  if (WHICH === 'repeat') {
    const reps = []
    for (let k = 1; k <= 5; k++) {
      const g = await json(\`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')].pop(); const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3); const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length)); return { img: R(w.getBoundingClientRect()), text: R(rg.getBoundingClientRect()) } })()\`)
      const r = await runDrag(\`S-rep\${k}\`, { x: 0, y: 0 }, { x: 0, y: 0 }, [{ name: '正文行(源码外)', x: Math.round((g.text[0] + g.text[2]) / 2), y: Math.round((g.text[1] + g.text[3]) / 2) }], 10)
      reps.push({ k, frames: r.frames.map((f) => \`\${f.sel}|闸\${f.own}|带\${f.bands.length}|兜底\${f.hl.length}|原生\${f.nat.length}\`), samples: r.samples, ok: r.samples.every((x) => x.拖动期有样式) })
      if (k === 1) { try { fs.copyFileSync(path.join(OUTDIR, \`\${TAG}-S-rep1-drag-9.png\`), path.join(__dirname, 'fresh-source-visible.png')) } catch (e) { /* ignore */ } }
    }
    out.repeat = reps
    log(\`\\n# 5 次连续复测：\` + JSON.stringify(reps.map((r) => ({ k: r.k, ok: r.ok, 帧数: r.frames.length, 去重: [...new Set(r.frames)].length, 首帧: r.frames[0], 末帧: r.frames[r.frames.length - 1] }))))
    // 表头也连做 5 次（第一条报障）
    const treps = []
    for (let k = 1; k <= 5; k++) {
      const r = await runDrag(\`T-rep\${k}\`, { x: 0, y: 0 }, { x: 0, y: 0 }, [], 10)
      treps.push({ k, ok: r.samples.every((x) => x.拖动期有样式) || r.samples.length === 0, samples: r.samples })
      if (k === 1) { try { fs.copyFileSync(path.join(OUTDIR, \`\${TAG}-T-rep1-drag-9.png\`), path.join(__dirname, 'table-header-live.png')) } catch (e) { /* ignore */ } }
    }
    out.trepeat = treps
    log(\`# 表头 5 次：\` + JSON.stringify(treps.map((r) => ({ k: r.k, ok: r.ok, samples: r.samples.map((x) => \`\${x.name}:Δ\${x.Δ}\`) }))))
  }
  fs.writeFileSync(path.join(OUTDIR, \`sellive125-\${TAG}.json\`), JSON.stringify(out, null, 1))`
if (!s.includes(a2)) console.log('MISS a2')
s = s.split(a2).join(b2)
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
