// ─── 由 resources/icon.png 同步「应用内标识」的位图 ────────────────────────────
//
// 为什么要有这一步：应用内标识（启动骨架屏 / 关于页）与桌面图标必须是**同一张图**，
// 但它们的加载条件完全不同 —— 图标是磁盘上的文件（打包进 resources/），而启动骨架屏在
// 渲染进程刚起来时就要画出来，走文件路径会依赖「文件在不在、路径对不对」。所以应用内那份
// **内嵌成 data URI**：不引用任何外部文件，换设备/换目录/换平台都照常显示。
//
// 内嵌的是**下采样到 128×128 的版本**（原始 1024×1024 的 base64 是 978KB，塞进 JS 模块会
// 白白拖慢启动；128 档只有 ~22KB，视觉上没有区别）。下采样用 tools/pack-ico.js 里与 ICO
// 同一个框滤波函数，两处不会走样。
//
// 用法：
//   node tools/sync-app-icon.js           # 重新生成 src/renderer/src/assets/iconPng.ts
//   node tools/sync-app-icon.js --check   # 只校验现有内嵌图与 resources/icon.png 是否同步（CI 用）
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { decodePng, downscale } = require('./pack-ico.js')

const REPO = path.resolve(__dirname, '..')
const PNG_PATH = path.join(REPO, 'resources', 'icon.png')
const OUT_PATH = path.join(REPO, 'src', 'renderer', 'src', 'assets', 'iconPng.ts')
/** 应用内标识的像素尺寸：骨架屏 46px / 关于页 80px，128 档在 2x 屏上也够清晰 */
const SIZE = 128

// ─── 最小 PNG 编码（无滤波 + deflate；只为把像素包成一个可内嵌的 PNG）──────────
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // 每行滤波 = None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 生成内嵌图（同一个函数给生成与校验用，两边不会走样） */
function buildBase64() {
  const img = decodePng(fs.readFileSync(PNG_PATH))
  if (img.width !== img.height) throw new Error('resources/icon.png 必须是正方形')
  const px = img.width === SIZE ? img.rgba : downscale(img.rgba, img.width, img.height, SIZE, SIZE)
  return encodePng(px, SIZE).toString('base64')
}

const FILE_HEADER = `// ─── 应用内标识（内嵌 data URI，不引用任何外部文件）─────────────────────────────
// 内容由 \`node tools/sync-app-icon.js\` 从 \`resources/icon.png\` 生成（下采样到 ${SIZE}×${SIZE}），
// **不要手改**。它服务于启动骨架屏与「关于」页：这两处要在渲染进程刚起来时就画出标识，
// 走文件路径会依赖「文件在不在、路径对不对」，而 data URI 换设备 / 换目录 / 换平台都照常显示。
//
// 与桌面图标同源、同步关系由 \`node tools/sync-app-icon.js --check\` 与单测
// （tests/toolIcon.test.mjs）盯着：图标换了而这里没换会直接报红。
export const APP_ICON_PNG_BASE64 =
`

if (require.main === module) {
  const check = process.argv.includes('--check')
  const b64 = buildBase64()
  const src = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf-8') : ''
  const embedded = [...src.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]).join('')
  const same = embedded === b64
  console.log(
    'APP-ICON ' +
      JSON.stringify({
        source: 'resources/icon.png',
        size: SIZE,
        base64Chars: b64.length,
        synced: same,
        file: path.relative(REPO, OUT_PATH)
      })
  )
  if (check) {
    if (!same) {
      console.error('不同步：resources/icon.png 已变更，请跑 node tools/sync-app-icon.js')
      process.exit(1)
    }
    process.exit(0)
  }
  // 每行 96 字符，避免一个 2 万字符的长行把编辑器和 diff 卡住
  const lines = []
  for (let i = 0; i < b64.length; i += 96) lines.push(`  '${b64.slice(i, i + 96)}'`)
  fs.writeFileSync(OUT_PATH, `${FILE_HEADER}${lines.join(' +\n')}\n`, 'utf-8')
  console.log('WROTE ' + path.relative(REPO, OUT_PATH))
}
