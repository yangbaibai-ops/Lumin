'use strict'
/** 最小 PNG 解码（8bit / 非隔行 / 灰度·RGB·RGBA）+ 取像素；CDP 截图足够用，零依赖。 */
const zlib = require('zlib')

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let off = 8
  let w = 0
  let h = 0
  let ct = 0
  let bd = 0
  let inter = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bd = data[8]
      ct = data[9]
      inter = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bd !== 8) throw new Error('unsupported bit depth ' + bd)
  if (inter !== 0) throw new Error('interlaced png unsupported')
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : 0
  if (!channels) throw new Error('unsupported color type ' + ct)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      } else if (f !== 0) throw new Error('filter ' + f)
      cur[i] = v
    }
  }
  return {
    w,
    h,
    channels,
    data: out,
    px(x, y) {
      const o = (y * w + x) * channels
      return [out[o], out[o + 1], out[o + 2]]
    }
  }
}

const DIFF = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

/**
 * 某一列上「非纸面」像素的连续游程（在 [y0,y1] 窗口内）。
 * 返回最长游程 {top,bottom,height, colors:{edge,mid}, glyph:boolean}
 * edge = 游程顶部 +2px 的颜色（带底、没有字形墨迹）；mid = 游程中心颜色。
 */
function columnRun(img, x, y0, y1, paper, tol = 8) {
  let best = null
  let cur = null
  for (let y = y0; y <= y1; y++) {
    const c = img.px(x, y)
    const painted = DIFF(c, paper) > tol
    if (painted) {
      if (!cur) cur = { top: y, bottom: y }
      else cur.bottom = y
    } else if (cur) {
      if (!best || cur.bottom - cur.top > best.bottom - best.top) best = cur
      cur = null
    }
  }
  if (cur && (!best || cur.bottom - cur.top > best.bottom - best.top)) best = cur
  if (!best) return null
  const edgeY = Math.min(best.bottom, best.top + 2)
  const midY = Math.round((best.top + best.bottom) / 2)
  return {
    x,
    top: best.top,
    bottom: best.bottom,
    height: best.bottom - best.top + 1,
    edge: img.px(x, edgeY),
    mid: img.px(x, midY),
    center: img.px(x, Math.round((best.top + best.bottom) / 2))
  }
}

/** 某一行上「被涂色」像素的连续段（用于连续性：带内不应有 ≥1px 的空档） */
function rowRuns(img, y, x0, x1, paper, tol = 8) {
  const runs = []
  let cur = null
  for (let x = x0; x <= x1; x++) {
    const painted = DIFF(img.px(x, y), paper) > tol
    if (painted) {
      if (!cur) cur = { left: x, right: x }
      else cur.right = x
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  return runs
}

/** 整幅图里最常见的亮色 = 纸面底色（避开选区/文字） */
function paperColor(img) {
  const hist = new Map()
  for (let y = 0; y < img.h; y += 3) {
    for (let x = 0; x < img.w; x += 3) {
      const c = img.px(x, y)
      if (c[0] < 200 || c[1] < 200 || c[2] < 200) continue
      const k = c[0] + ',' + c[1] + ',' + c[2]
      hist.set(k, (hist.get(k) || 0) + 1)
    }
  }
  let bestK = null
  let bestN = -1
  for (const [k, n] of hist) if (n > bestN) { bestN = n; bestK = k }
  return bestK.split(',').map(Number)
}

module.exports = { decodePng, columnRun, rowRuns, paperColor, DIFF }
