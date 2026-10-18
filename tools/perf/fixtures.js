'use strict'
// ─── 性能基线夹具 ───────────────────────────────────────────────────────────────
//
// 两份夹具，全部落在 `%TEMP%\xw-perf-fixture\`（不提交、不碰用户目录）：
//   1. `real.md` ── 用户真实文档的**逐字节副本**（源在桌面，未在 LUMIN_TRUSTED_PATHS
//      白名单里；主进程会拒 `file:read`，所以复制到 %TEMP% 再打开，SHA256 写进结果）。
//   2. `big.md`  ── 把真实文档重复 8 遍 ≈ 2000 行，表格 / 行内+块级公式 / <img> /
//      mermaid / 代码块都在，用来量「大文档」下的跟手度。
//
// 用法：`node tools/perf/fixtures.js` 打印两份夹具的路径 / 行数 / 字节数 / SHA256。
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const REAL_DOC = 'C:\\Users\\yangbaibai\\Desktop\\Lumin相关\\数学公式示例.md'
const OUT_DIR = path.join(os.tmpdir(), 'xw-perf-fixture')
const COPIES = 8

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
const countLines = (text) => text.split(/\r\n|\r|\n/).length

function build() {
  if (!fs.existsSync(REAL_DOC)) {
    throw new Error(`真实文档不存在：${REAL_DOC}`)
  }
  const real = fs.readFileSync(REAL_DOC)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const realPath = path.join(OUT_DIR, 'real.md')
  fs.writeFileSync(realPath, real)

  const text = real.toString('utf8')
  // 每遍之间补一行分隔注释：既让 8 遍互不粘连，又便于确认夹具结构没漂。
  const parts = []
  for (let i = 0; i < COPIES; i += 1) {
    parts.push(`<!-- perf-copy ${i + 1}/${COPIES} -->\n\n${text}`)
  }
  const bigText = parts.join('\n\n')
  const bigPath = path.join(OUT_DIR, 'big.md')
  fs.writeFileSync(bigPath, bigText, 'utf8')

  const meta = {
    dir: OUT_DIR,
    real: {
      source: REAL_DOC,
      path: realPath,
      sha256: sha256(real),
      bytes: real.length,
      lines: countLines(text),
      note: '逐字节副本（源不在 LUMIN_TRUSTED_PATHS，直接打开会被主进程拒绝）'
    },
    big: {
      source: realPath,
      path: bigPath,
      sha256: sha256(Buffer.from(bigText, 'utf8')),
      bytes: Buffer.byteLength(bigText, 'utf8'),
      lines: countLines(bigText),
      copies: COPIES
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

module.exports = { build, OUT_DIR, REAL_DOC }

if (require.main === module) {
  const meta = build()
  console.log(JSON.stringify(meta, null, 2))
}
