// ─── 由交付的 PNG 生成多尺寸 ICO（零新依赖：zlib + 手写 PNG 解码 / DIB 打包）────────
//
// 为什么需要它：用户交付的 `Lumin.ico` 只有**一个 256×256 的 PNG 压缩条目**，实测
// `System.Drawing.Icon.ToBitmap()`（GDI+，Windows 资源管理器取图标的同一条路）对它抛
// `Requested range extends past the end of the array`；而上一版图标是**每档 DIB 负载**，
// 读得好好的。也就是说 PNG-in-ICO 在部分 Windows 图标路径上会取不到图（缺省图标）。
// 同时单档 256 被本机缩到 16/24/32 时也糊。
//
// 做法：**不改画笔**——读 `resources/icon.png`（用户交付的 1024×1024 原图），按整数框
// 滤波（先 premultiply 再取均值，避免透明边缘发黑）缩到各档，打成 **32 位 BGRA DIB +
// AND 掩码** 的标准 ICO（8 档，含 16/24/32/48/64/128/256）。像素来自交付原图，只是换了
// 容器格式与尺寸档位。
//
// 用法：
//   node tools/pack-ico.js              # 从 resources/icon.png 生成 resources/icon.ico
//   node tools/pack-ico.js --check      # 只校验现有 icon.ico 是否已是多档 DIB（不写盘）
//
// ⚠️ 它只读 resources/icon.png。换图标 = 换 resources/icon.png 后再跑一次本脚本。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const REPO = path.resolve(__dirname, '..')
const RES = path.join(REPO, 'resources')
const PNG_PATH = path.join(RES, 'icon.png')
const ICO_PATH = path.join(RES, 'icon.ico')

/**
 * ICO 里的档位：Windows 会按场景（标题栏/任务栏/Alt+Tab/资源管理器/高 DPI）自己挑。
 *
 * 为什么是这几档（2026 再换图标时按交付目录的档位补全）：
 *   * 16/24/32/48/64/128/256 是 Windows 的经典集（沿用原值）；
 *   * **20 / 40** 对应 125%（16→20、32→40）与部分 150% 场景，**72 / 96** 对应 150% / 175%
 *     与任务栏大图标 —— 交付目录里本来就有这几档（说明设计在这些尺寸下是过审的），
 *     而缺了它们时 Windows 只能拿 32 或 128 去插值，任务栏与 Alt+Tab 会发糊。
 * 档位不要求整除母图：`downscale` 用的是按边界的框滤波，非整数倍率（1024/20、/72、/96）
 * 一样是「面积加权平均」，不会出现最近邻的锯齿。
 */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256]

// ─── PNG 解码（只支持交付图这一种形态：8 位、非隔行、colorType 2/6）────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let p = 8
  let W = 0
  let H = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  let palette = null
  let trns = null
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      W = data.readUInt32BE(0)
      H = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位深（实际 ${bitDepth}）`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`不支持的 colorType ${colorType}`)

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = W * channels
  const out = Buffer.alloc(H * stride)
  const paeth = (a, b, c) => {
    const pp = a + b - c
    const pa = Math.abs(pp - a)
    const pb = Math.abs(pp - b)
    const pc = Math.abs(pp - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let pos = 0
  for (let y = 0; y < H; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      cur[x] = v & 255
    }
  }

  // 统一成 RGBA
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0, n = W * H; i < n; i++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 255
    const o = i * channels
    if (colorType === 6) {
      r = out[o]
      g = out[o + 1]
      b = out[o + 2]
      a = out[o + 3]
    } else if (colorType === 2) {
      r = out[o]
      g = out[o + 1]
      b = out[o + 2]
    } else if (colorType === 0) {
      r = g = b = out[o]
    } else if (colorType === 4) {
      r = g = b = out[o]
      a = out[o + 1]
    } else if (colorType === 3) {
      const idx = out[o]
      r = palette[idx * 3]
      g = palette[idx * 3 + 1]
      b = palette[idx * 3 + 2]
      a = trns && idx < trns.length ? trns[idx] : 255
    }
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = a
  }
  return { width: W, height: H, rgba }
}

/**
 * 整数框滤波缩放（仅用于**缩小**，档位都整除原图尺寸）。
 * 先乘 alpha 再平均、最后除回去（premultiplied 平均）：否则透明区（原图是 0,0,0,0）
 * 会把边缘的 RGB 拉黑，出现一圈脏边。
 */
function downscale(src, sw, sh, dw, dh) {
  const fx = sw / dw
  const fy = sh / dh
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * sw + xx) * 4
          const al = src[o + 3] / 255
          r += src[o] * al
          g += src[o + 1] * al
          b += src[o + 2] * al
          a += src[o + 3]
          n++
        }
      }
      const alpha = a / n
      const o = (y * dw + x) * 4
      out[o] = alpha > 0 ? Math.round(r / (a / 255)) : 0
      out[o + 1] = alpha > 0 ? Math.round(g / (a / 255)) : 0
      out[o + 2] = alpha > 0 ? Math.round(b / (a / 255)) : 0
      out[o + 3] = Math.round(alpha)
    }
  }
  return out
}

/**
 * 一档 = BITMAPINFOHEADER(40B) + 自下而上的 BGRA 像素 + AND 掩码（每行 4 字节对齐）。
 * 掩码位 1 = 透明：32 位档里 alpha 才是权威，但掩码仍要写对 —— 有些老组件只看掩码。
 */
function dibEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND 两张位图的高度
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bpp
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // 像素字节数（不含掩码）

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y // DIB 自下而上
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4
      const d = (y * size + x) * 4
      pixels[d] = rgba[s + 2] // B
      pixels[d + 1] = rgba[s + 1] // G
      pixels[d + 2] = rgba[s] // R
      pixels[d + 3] = rgba[s + 3] // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4 // 每行按 4 字节对齐
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y
    for (let x = 0; x < size; x++) {
      const alpha = rgba[(srcY * size + x) * 4 + 3]
      if (alpha === 0) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, pixels, mask])
}

function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let off = 6 + 16 * entries.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size === 256 ? 0 : e.size
    dir[o + 1] = e.size === 256 ? 0 : e.size
    dir[o + 2] = 0 // 调色板色数（真彩为 0）
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(off, o + 12)
    off += e.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

/** 读 ICO 目录（自检与验收脚本都用同一份口径：档位 + 负载类型） */
function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null
  const n = buf.readUInt16LE(4)
  const out = []
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    const size = buf[o] === 0 ? 256 : buf[o]
    const len = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    const declaredBpp = buf.readUInt16LE(o + 6)
    const payload = buf.subarray(off, off + len)
    const isPng = payload.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    out.push({ size, len, off, bpp: declaredBpp, png: isPng, dib: !isPng && len >= 40 })
  }
  return out
}

module.exports = { decodePng, downscale, dibEntry, packIco, readIco, SIZES }

if (require.main === module) {
  const check = process.argv.includes('--check')
  const buf = fs.readFileSync(PNG_PATH)
  const img = decodePng(buf)
  console.log(
    'SRC ' +
      JSON.stringify({
        file: path.basename(PNG_PATH),
        w: img.width,
        h: img.height,
        bytes: buf.length
      })
  )
  if (img.width !== img.height) throw new Error('母图必须是正方形')

  const entries = SIZES.map((size) => ({
    size,
    data: dibEntry(
      size === img.width ? img.rgba : downscale(img.rgba, img.width, img.height, size, size),
      size
    )
  }))
  const ico = packIco(entries)
  const dir = readIco(ico)
  console.log(
    'ICO ' +
      JSON.stringify({
        bytes: ico.length,
        entries: dir.map((d) => ({ size: d.size, dib: d.dib, bytes: d.len }))
      })
  )
  if (dir.length !== SIZES.length || dir.some((d) => !d.dib)) throw new Error('打包结果自检失败')
  if (check) {
    const cur = fs.existsSync(ICO_PATH) ? readIco(fs.readFileSync(ICO_PATH)) : null
    const ok = !!cur && cur.length === SIZES.length && cur.every((d) => d.dib)
    console.log(
      'CHECK ' +
        JSON.stringify({ file: path.basename(ICO_PATH), entries: cur?.map((d) => d.size), ok })
    )
    process.exit(ok ? 0 : 1)
  }
  fs.writeFileSync(ICO_PATH, ico)
  console.log('WROTE ' + ICO_PATH)
}
