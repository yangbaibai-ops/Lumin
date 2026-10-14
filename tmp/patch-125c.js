const fs = require('fs')
const p = 'tmp/sel-live-125.js'
let s = fs.readFileSync(p, 'utf8')
// ① residue() 里把"带中心处的元素栈 + 各自背景"一并给出（判"被不透明背景盖住"的依据）
const a1 = `        const out = []
        for (const r of nat) {
          if (r[2] - r[0] < 1 || r[3] - r[1] < 1) continue
          const cov = cover.some((b) => b[0] <= r[0] + 0.5 && b[2] >= r[2] - 0.5 && Math.min(b[3], r[3]) - Math.max(b[1], r[1]) > 0)
          const vis = cov && !hidden(r)
          out.push({ nat: r.map((v) => +v.toFixed(2)), covered: cov, coveredVisible: vis, hiddenByBg: hidden(r) })
        }
        return out`
const b1 = `        const stack0 = (() => {
          if (!cover.length) return []
          const r = cover[0]
          return document.elementsFromPoint((r[0] + r[2]) / 2, (r[1] + r[3]) / 2).map((el) => ({
            tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
            inDom: d.contains(el), bg: getComputedStyle(el).backgroundColor, z: getComputedStyle(el).zIndex
          }))
        })()
        const out = []
        for (const r of nat) {
          if (r[2] - r[0] < 1 || r[3] - r[1] < 1) continue
          const cov = cover.some((b) => b[0] <= r[0] + 0.5 && b[2] >= r[2] - 0.5 && Math.min(b[3], r[3]) - Math.max(b[1], r[1]) > 0)
          const vis = cov && !hidden(r)
          out.push({ nat: r.map((v) => +v.toFixed(2)), covered: cov, coveredVisible: vis, hiddenByBg: hidden(r) })
        }
        return { rects: out, stack: stack0, bands: bands.map((b) => b.map((v) => +v.toFixed(2))) }`
if (!s.includes(a1)) console.log('MISS a1')
s = s.split(a1).join(b1)
// ② 残差统计改用 .rects
s = s.split('const resMax = fs2.map((f) => (f.residue || []).filter((r) => !r.coveredVisible).length)')
  .join('const resMax = fs2.map((f) => ((f.residue && f.residue.rects) || []).filter((r) => !r.coveredVisible).length)')
// ③ 像素点改为"同一帧"的带/原生矩形派生
const a3 = `    const mid = fs2[fs2.length - 1]
    const midImg = imgs[imgs.length - 1].img
    const dragSamples = samplePts.map((p) => ({ ...p, drag: px(midImg, p.x, p.y) }))`
const b3 = `    const mid = fs2[fs2.length - 1]
    const midImg = imgs[imgs.length - 1].img
    // 采样点用**同一帧**的带/原生矩形派生（避免布局漂移导致取错像素）
    const band0 = mid.bands[0]
    const nat0 = mid.nat[0]
    const derived = []
    if (band0) derived.push({ name: '带中心', x: Math.round((band0[0] + band0[2]) / 2), y: Math.round((band0[1] + band0[3]) / 2) })
    if (band0) derived.push({ name: '带内字形下方4px', x: Math.round((band0[0] + band0[2]) / 2), y: Math.round(band0[3] - 4) })
    if (nat0) derived.push({ name: '原生rect中心', x: Math.round((nat0[0] + nat0[2]) / 2), y: Math.round((nat0[1] + nat0[3]) / 2) })
    for (const p of samplePts) derived.push(p)
    const dragSamples = derived.map((p) => ({ ...p, drag: px(midImg, p.x, p.y) }))`
if (!s.includes(a3)) console.log('MISS a3')
s = s.split(a3).join(b3)
s = s.split('const samples = dragSamples.map((p) => ({ ...p, settled: px(settledImg, p.x, p.y) }))')
  .join('const samples = dragSamples.map((p) => ({ ...p, settled: px(settledImg, p.x, p.y) }))')
// ④ 残差打印加元素栈
s = s.split("log(`   ★ 未被\"可见覆盖\"的原生 rect 数：最大 ${rec.resMax}，出现该情况的帧 ${rec.resFramesBad}/${fs2.length}`)")
  .join("log(`   ★ 未被\"可见覆盖\"的原生 rect 数：最大 ${rec.resMax}，出现该情况的帧 ${rec.resFramesBad}/${fs2.length}`)\n    log(`   带中心处元素栈(自上而下): ${JSON.stringify(((mid.residue && mid.residue.stack) || []).slice(0, 6))}`)")
fs.writeFileSync(p, s, 'utf8')
console.log('patched')
