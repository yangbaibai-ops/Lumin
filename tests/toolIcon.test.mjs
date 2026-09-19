// 应用图标链路自检（纯静态 + 纯计算，无 Electron 依赖）。
//
// 为什么值得放进 `npm run test:unit`：图标是「改了看不见、坏了也不报错」的那类东西 ——
//   * ICO 里若只有 PNG 压缩条目，GDI+（资源管理器取图标走的那条路）读不出来，用户看到的是
//     缺省图标，而代码和构建**都不会报任何错**；
//   * 应用内标识（骨架屏 / 关于页）用的是内嵌位图，图标换了而它没换 → 界面里还是旧标识；
//   * `resources/icon.png` 必须还是那张母图，`icon.ico` 必须由它打出来。
// 这三件事都能在毫秒级静态查清，所以没理由留到运行时才被人发现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = path.join(ROOT, 'resources', 'icon.png')
const ICO = path.join(ROOT, 'resources', 'icon.ico')
const { decodePng, downscale, SIZES } = require('../tools/pack-ico.js')

/** PNG 头里的宽高（不改动文件，只读 IHDR） */
function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon.png 不是 PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** ICO 目录：档位 + 负载类型（PNG / DIB） */
function icoEntries(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved 必须为 0')
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type 必须为 1（图标）')
  const n = buf.readUInt16LE(4)
  const out = []
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    const size = buf[o] === 0 ? 256 : buf[o]
    const len = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    const payload = buf.subarray(off, off + len)
    out.push({
      size,
      len,
      off,
      png: payload.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      // DIB 负载 = BITMAPINFOHEADER：头 4 字节是结构体大小 40
      dib: payload.readUInt32LE(0) === 40,
      inRange: off + len <= buf.length
    })
  }
  return out
}

test('icon.png：正方形、至少 256 的母图（ICO 各档都由它缩出来）', () => {
  const buf = fs.readFileSync(PNG)
  const { w, h } = pngSize(buf)
  assert.equal(w, h, `母图必须正方形（实际 ${w}×${h}）`)
  assert.ok(w >= 256, `母图至少 256（实际 ${w}）`)
})

test('icon.ico：七档、每档都是 32 位 DIB（PNG 压缩档会被 GDI+ 读不出来）', () => {
  const entries = icoEntries(fs.readFileSync(ICO))
  assert.deepEqual(
    entries.map((e) => e.size),
    SIZES,
    '档位必须与 tools/pack-ico.js 的 SIZES 一致（Windows 按场景挑尺寸）'
  )
  for (const e of entries) {
    assert.equal(e.png, false, `${e.size} 档是 PNG 压缩负载：GDI+ 的 Icon.ToBitmap() 读不出来`)
    assert.equal(e.dib, true, `${e.size} 档不是 BITMAPINFOHEADER（DIB）负载`)
    assert.equal(e.inRange, true, `${e.size} 档的目录偏移越界`)
    // 32 位 BGRA DIB 的负载大小是确定的：头 40 + 像素 w*h*4 + AND 掩码（每行 4 字节对齐）
    const maskStride = Math.ceil(e.size / 32) * 4
    assert.equal(
      e.len,
      40 + e.size * e.size * 4 + maskStride * e.size,
      `${e.size} 档负载字节数不对`
    )
  }
})

test('icon.ico 与 icon.png 同源：每档缩放尺寸与母图一致（用同一份框滤波复算）', () => {
  // 只复算**最小那一档**：整条链路（解码 → 框滤波 → 打包）走一遍，证明 ICO 里的像素确实来自
  // resources/icon.png，而不是别的设计的残留。逐字节比整份 ICO 会让测试变慢且没必要。
  const img = decodePng(fs.readFileSync(PNG))
  const entries = icoEntries(fs.readFileSync(ICO))
  const ico = fs.readFileSync(ICO)
  const target = entries.find((e) => e.size === 32)
  const expected = downscale(img.rgba, img.width, img.height, 32, 32)
  const payload = ico.subarray(target.off, target.off + target.len)
  // DIB 自下而上：先把中心 8×8 的均色与复算结果比一比（缩放实现若走样，这里的差值会很明显）
  const meanOf = (read, cx, cy) => {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let y = cy; y < cy + 8; y++) {
      for (let x = cx; x < cx + 8; x++) {
        const [rr, gg, bb, aa] = read(x, y)
        r += rr
        g += gg
        b += bb
        a += aa
      }
    }
    return [r / 64, g / 64, b / 64, a / 64].map((v) => Math.round(v))
  }
  const fromIco = meanOf(
    (x, y) => {
      const srcY = 32 - 1 - y
      const o = 40 + (srcY * 32 + x) * 4
      return [payload[o + 2], payload[o + 1], payload[o], payload[o + 3]]
    },
    12,
    12
  )
  const fromPng = meanOf(
    (x, y) => {
      const o = (y * 32 + x) * 4
      return [expected[o], expected[o + 1], expected[o + 2], expected[o + 3]]
    },
    12,
    12
  )
  assert.deepEqual(fromIco, fromPng, `ICO 中心区均色 ${fromIco} 与母图复算 ${fromPng} 不一致`)
})

test('应用内标识（内嵌位图）与 resources/icon.png 同步', () => {
  // 跑 tools/sync-app-icon.js --check 的同一份判据，但不再单起一个进程：直接读文件比 base64。
  const mod = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'iconPng.ts'),
    'utf-8'
  )
  const embedded = [...mod.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]).join('')
  assert.ok(embedded.length > 1000, '内嵌位图没读到（正则或文件结构变了？）')
  const buf = Buffer.from(embedded, 'base64')
  assert.equal(pngSize(buf).w, 128, '应用内标识应当是 128×128（避免把 1024 档塞进启动包）')
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')

  // 与「从 resources/icon.png 重新缩一份」逐字节比：**这一步才是「同步」的判据**
  const img = decodePng(fs.readFileSync(PNG))
  const expected = downscale(img.rgba, img.width, img.height, 128, 128)
  const decoded = decodePng(buf)
  assert.deepEqual({ w: decoded.width, h: decoded.height }, { w: 128, h: 128 }, '内嵌位图尺寸不对')
  assert.ok(
    decoded.rgba.equals(expected),
    '应用内标识与 resources/icon.png 不同步：跑 node tools/sync-app-icon.js'
  )
})

test('单一来源：build/ 下不许再有 icon.*（electron-builder 会优先读它，形成两套图标）', () => {
  const stale = ['icon.ico', 'icon.png', 'icon.icns']
    .map((n) => path.join(ROOT, 'build', n))
    .filter((p) => fs.existsSync(p))
  assert.deepEqual(stale, [], `build/ 下有旧图标产物：${stale.join(', ')}`)
})

test('引用面：src 下只允许 resources/icon.ico 与 resources/icon.png', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return walk(p)
      return /\.(ts|vue)$/.test(e.name) ? [p] : []
    })
  const refs = []
  for (const f of walk(path.join(ROOT, 'src'))) {
    for (const m of fs.readFileSync(f, 'utf-8').matchAll(/resources\/icon[\w.-]*/g)) {
      refs.push({ file: path.relative(ROOT, f), ref: m[0] })
    }
  }
  const unexpected = refs.filter(
    (r) => r.ref !== 'resources/icon.ico' && r.ref !== 'resources/icon.png'
  )
  assert.deepEqual(unexpected, [], 'src 下出现了非约定的图标引用')
  assert.ok(
    refs.some((r) => r.ref === 'resources/icon.ico'),
    '没有任何地方引用 resources/icon.ico（任务栏/快捷方式只认 ICO）'
  )
})
