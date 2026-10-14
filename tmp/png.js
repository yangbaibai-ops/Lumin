'use strict'
// 极简 PNG 解码 + 像素分析（CDP 截图用；不引第三方依赖，Node 自带 zlib 足够）
const zlib = require('zlib')

function decodePNG(buf) {
  let pos = 8
  let w = 0
  let h = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('unsupported bitDepth ' + bitDepth)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 4
  const bpp = ch
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let rp = 0
  const zero = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zero
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return {
    w,
    h,
    ch,
    data: out,
    px(x, y) {
      const o = y * stride + x * bpp
      return [out[o], out[o + 1], out[o + 2]]
    }
  }
}

/** 两图在矩形窗口内逐行比较：返回"有 ≥minPx 个像素变化（通道差和 > thr）"的行区间 */
function diffRows(A, B, win, thr = 24, minPx = 2) {
  const rows = []
  for (let y = win.y0; y <= win.y1; y++) {
    let n = 0
    for (let x = win.x0; x <= win.x1; x++) {
      const a = A.px(x, y)
      const b = B.px(x, y)
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > thr) n++
    }
    if (n >= minPx) rows.push(y)
  }
  if (!rows.length) return null
  return { top: rows[0], bottom: rows[rows.length - 1], height: rows[rows.length - 1] - rows[0] + 1, rows: rows.length }
}

/** 某色（±tol）的行区间 */
function colorRows(img, color, win, tol = 6, minPx = 3) {
  const rows = []
  for (let y = win.y0; y <= win.y1; y++) {
    let n = 0
    for (let x = win.x0; x <= win.x1; x++) {
      const p = img.px(x, y)
      if (
        Math.abs(p[0] - color[0]) <= tol &&
        Math.abs(p[1] - color[1]) <= tol &&
        Math.abs(p[2] - color[2]) <= tol
      )
        n++
    }
    if (n >= minPx) rows.push({ y, n })
  }
  if (!rows.length) return null
  return {
    top: rows[0].y,
    bottom: rows[rows.length - 1].y,
    height: rows[rows.length - 1].y - rows[0].y + 1,
    maxRun: Math.max(...rows.map((r) => r.n))
  }
}

/**
 * 某色（±tol）的**最长连续行段**：每行要求"命中像素数 ≥ 窗口宽的 frac 比例"才算命中，
 * 再取最长的一段。用于排除浮层/工具栏之类"局部也是这个颜色"的干扰（整段底色才是我们要量的带）。
 */
function colorRunRows(img, color, win, tol = 6, frac = 0.5) {
  const w = win.x1 - win.x0 + 1
  const need = Math.max(3, Math.round(w * frac))
  const rows = []
  for (let y = win.y0; y <= win.y1; y++) {
    let n = 0
    for (let x = win.x0; x <= win.x1; x++) {
      const p = img.px(x, y)
      if (Math.abs(p[0] - color[0]) <= tol && Math.abs(p[1] - color[1]) <= tol && Math.abs(p[2] - color[2]) <= tol) n++
    }
    rows.push(n >= need)
  }
  let best = null
  let cur = null
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]) {
      if (!cur) cur = { s: i, e: i }
      else cur.e = i
      if (!best || cur.e - cur.s > best.e - best.s) best = { s: cur.s, e: cur.e }
    } else cur = null
  }
  if (!best) return null
  return {
    top: win.y0 + best.s,
    bottom: win.y0 + best.e,
    height: best.e - best.s + 1,
    runs: rows.filter(Boolean).length
  }
}

function countColor(img, color, win, tol = 6) {
  let n = 0
  for (let y = win.y0; y <= win.y1; y++)
    for (let x = win.x0; x <= win.x1; x++) {
      const p = img.px(x, y)
      if (
        Math.abs(p[0] - color[0]) <= tol &&
        Math.abs(p[1] - color[1]) <= tol &&
        Math.abs(p[2] - color[2]) <= tol
      )
        n++
    }
  return n
}

module.exports = { decodePNG, diffRows, colorRows, colorRunRows, countColor }
