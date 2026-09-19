// ⚠️ 已过时（会覆盖现行图标，别随手跑）：本脚本生成的是**第一版**设计（靛蓝渐变 + 星光 Logo，256×256），
// 而 resources/icon.png 现在装的是**用户交付的位图**（1024×1024，见
// docs/typora-wysiwyg-manual.md §4.36 的「图标更换记录」）。跑本脚本会把 resources/icon.png 覆盖回旧设计，
// 让「同一个应用两种图标」重现。
// 换图标的正确做法：替换 `resources/icon.png` → 跑 `node tools/pack-ico.js`（打出七档 DIB 的
// `resources/icon.ico`）→ 跑 `node tools/sync-app-icon.js`（同步应用内标识）。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const px = new Uint8Array(SIZE * SIZE * 4)

function roundedRectAlpha(x, y, radius) {
  const r = radius
  const cx = Math.min(Math.max(x, r), SIZE - 1 - r)
  const cy = Math.min(Math.max(y, r), SIZE - 1 - r)
  const dx = x - cx
  const dy = y - cy
  const d = Math.hypot(dx, dy)
  if (d <= r) return 1
  if (cx !== x && cy !== y) return Math.max(0, 1 - (d - r))
  return 1
}

const c1 = [99, 102, 241] // #6366f1
const c2 = [139, 92, 246] // #8b5cf6
const c3 = [14, 165, 233] // #0ea5e9（对角光晕）

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const t = (x / SIZE + y / SIZE) / 2
    // 对角渐变
    let r = c1[0] + (c2[0] - c1[0]) * t
    let g = c1[1] + (c2[1] - c1[1]) * t
    let b = c1[2] + (c2[2] - c1[2]) * t
    // 顶部高光
    const hi = Math.max(0, 1 - y / (SIZE * 0.55))
    r += (255 - r) * hi * 0.08
    g += (255 - g) * hi * 0.08
    b += (255 - b) * hi * 0.08
    const alpha = Math.round(roundedRectAlpha(x, y, 56) * 255)
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = alpha
  }
}

// ── 星光 Logo（astroid 四角星 + 光晕）──
const cx = SIZE / 2
const cy = SIZE / 2
const R = 92

function starDist(x, y) {
  const dx = Math.abs(x - cx)
  const dy = Math.abs(y - cy)
  const s = Math.pow(Math.max(dx, 0.0001), 2 / 3) + Math.pow(Math.max(dy, 0.0001), 2 / 3)
  return Math.pow(s, 3 / 2) / Math.pow(R, 1)
}

function blend(i, r, g, b, a) {
  const oa = px[i + 3] / 255
  const na = a + oa * (1 - a)
  if (na <= 0) return
  px[i] = (r * a + px[i] * oa * (1 - a)) / na
  px[i + 1] = (g * a + px[i + 1] * oa * (1 - a)) / na
  px[i + 2] = (b * a + px[i + 2] * oa * (1 - a)) / na
  px[i + 3] = na * 255
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    if (px[i + 3] === 0) continue
    const d = starDist(x, y)
    // 外光晕
    if (d < R * 1.6) {
      const g = Math.max(0, 1 - (d - R) / (R * 0.6)) * 0.35
      blend(i, 255, 255, 255, g)
    }
    // 星形本体（白色，带柔和边缘）
    if (d < R) {
      const edge = Math.min(1, (R - d) / 2.5)
      blend(i, 255, 255, 255, Math.min(1, edge * 0.98))
    }
    // 星形中心轻微的渐变层次
    if (d < R * 0.75) {
      blend(i, 235, 240, 255, 0.25)
    }
  }
}

// ── 两颗小星 ──
function smallStar(sx, sy, sr, alpha) {
  for (let y = Math.floor(sy - sr); y <= sy + sr; y++) {
    for (let x = Math.floor(sx - sr); x <= sx + sr; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
      const i = (y * SIZE + x) * 4
      if (px[i + 3] === 0) continue
      const dx = Math.abs(x - sx)
      const dy = Math.abs(y - sy)
      const d = Math.hypot(dx, dy)
      if (d < sr) {
        const e = Math.min(1, (sr - d) / 1.5)
        blend(i, 255, 255, 255, e * alpha)
      }
    }
  }
}
smallStar(196, 72, 7, 0.9)
smallStar(66, 186, 5, 0.7)

// ── PNG 编码 ──
const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter none
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, j) => {
    raw[y * (SIZE * 4 + 1) + 1 + j] = v
  })
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(__dirname, '..', 'resources', 'icon.png')
fs.writeFileSync(out, png)
console.log('written:', out, png.length, 'bytes')
