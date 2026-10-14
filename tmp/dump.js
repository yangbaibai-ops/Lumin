'use strict'
/** 像素取证小工具：node tmp/dump.js <png> col <x> <y0> <y1> | row <y> <x0> <x1> */
const fs = require('fs')
const { decodePng, paperColor } = require('./png-util.js')
const [f, mode, a, b, c] = process.argv.slice(2)
const img = decodePng(fs.readFileSync(f))
const paper = paperColor(img)
console.log(`# ${f} ${img.w}x${img.h} paper=${paper.join(',')}`)
if (mode === 'col') {
  const x = +a
  for (let y = +b; y <= +c; y++) {
    const p = img.px(x, y)
    console.log(`${y}\t${p.join(',')}`)
  }
} else if (mode === 'row') {
  const y = +a
  let line = ''
  for (let x = +b; x <= +c; x++) {
    const p = img.px(x, y)
    line += `${x}:${p[0]},${p[1]},${p[2]}  `
  }
  console.log(line)
} else if (mode === 'fine') {
  const [x0, x1, y0, y1] = [+a, +b, +c, +process.argv[7]]
  const px = []
  for (let y = y0; y <= y1; y++) {
    let s = ''
    for (let x = x0; x <= x1; x++) {
      const p = img.px(x, y)
      const d = Math.abs(p[0] - paper[0]) + Math.abs(p[1] - paper[1]) + Math.abs(p[2] - paper[2])
      s += d <= 4 ? '.' : p[0] < 150 ? '#' : Math.abs(p[0] - 229) < 12 ? 'B' : '?'
    }
    px.push(`${String(y).padStart(4)} ${s}`)
  }
  console.log(px.join('\n'))
} else if (mode === 'map') {
  // 稀疏映射：每 step 像素打一个字符（'.'=纸面, '#'=深色, '-'=中灰/带）
  const step = +a || 2
  for (let y = +b; y <= +c; y += step) {
    let s = ''
    for (let x = 300; x <= 1100; x += step) {
      const p = img.px(x, y)
      const d = Math.abs(p[0] - paper[0]) + Math.abs(p[1] - paper[1]) + Math.abs(p[2] - paper[2])
      s += d <= 4 ? '.' : p[0] < 150 ? '#' : '-'
    }
    console.log(`${String(y).padStart(4)} ${s}`)
  }
}
