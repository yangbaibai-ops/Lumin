'use strict'
// ─── 性能基线夹具 ───────────────────────────────────────────────────────────────
//
// 两份夹具，全部落在 `%TEMP%\xw-perf-fixture\`（不提交、不碰用户目录）：
//   1. `real.md` ── 用户真实文档的**逐字节副本**（源在桌面，未在 LUMIN_TRUSTED_PATHS
//      白名单里；主进程会拒 `file:read`，所以复制到 %TEMP% 再打开，SHA256 写进结果）。
//   2. `big.md`  ── 把真实文档重复 8 遍 ≈ 2000 行，表格 / 行内+块级公式 / <img> /
//      mermaid / 代码块都在，用来量「大文档」下的跟手度。
//
// 用法：`node tools/perf/fixtures.js [源文档]`；源文档也可以用环境变量 `XW_DOC` 指定。
//   省略时取仓库内的 `tools/fixtures/md/mixed-doc.md`（不依赖任何个人目录）。
//   源文档只被**读取**，副本落在 `%TEMP%\xw-perf-fixture\`，不会写回源文件。
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

/** CLI 参数（跳过 `--only=...` 这类选项）优先于环境变量，最后回落到仓库夹具 */
const CLI_DOC = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : ''
const REAL_DOC = path.resolve(
  process.env.XW_DOC || CLI_DOC || path.join(__dirname, '..', 'fixtures', 'md', 'mixed-doc.md')
)
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
