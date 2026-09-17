'use strict'
// 原型验证：把 markdown-it 的强调定界符判定（flanking）改成「CJK / 全角标点不算标点」，
// 在**不碰任何应用代码**的前提下先量出：
//   ① 用户夹具是否变成 7 个 strong（每个 `**…**` 都成对）；
//   ② 对既有 30 个 md 夹具的渲染有多少影响（逐个 diff HTML）—— 这就是改动半径。
const fs = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')

// ─── 与将写进源码的实现**同一份逻辑**（copy of upstream scanDelims，只改 punct 判定）──
function isCjkPunct(cp) {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 符号与标点：、。〈〉《》「」『』【】〔〕
    (cp >= 0xff01 && cp <= 0xff5e) || // 全角 ASCII 变体：！？，．：；（）［］
    cp === 0x2018 ||
    cp === 0x2019 ||
    cp === 0x201c ||
    cp === 0x201d || // ‘ ’ “ ”
    cp === 0x2014 ||
    cp === 0x2015 ||
    cp === 0x2026 || // —— 与 …
    (cp >= 0xfe30 && cp <= 0xfe4f) // CJK 兼容形式（﹑ ﹒ ︰ …）
  )
}

function scanDelimsCjk(state, start, canSplitWord) {
  const max = state.posMax
  const marker = state.src.charCodeAt(start)
  let lastChar
  if (start === 0) lastChar = 0x20
  else if (start === 1) {
    lastChar = state.src.charCodeAt(0)
    if ((lastChar & 0xf800) === 0xd800) lastChar = 0xfffd
  } else {
    lastChar = state.src.charCodeAt(start - 1)
    if ((lastChar & 0xfc00) === 0xdc00) {
      const highSurr = state.src.charCodeAt(start - 2)
      lastChar =
        (highSurr & 0xfc00) === 0xd800
          ? 0x10000 + ((highSurr - 0xd800) << 10) + (lastChar - 0xdc00)
          : 0xfffd
    } else if ((lastChar & 0xfc00) === 0xd800) lastChar = 0xfffd
  }
  let pos = start
  while (pos < max && state.src.charCodeAt(pos) === marker) pos++
  const count = pos - start
  let nextChar = pos < max ? state.src.charCodeAt(pos) : 0x20
  if ((nextChar & 0xfc00) === 0xd800) {
    const lowSurr = state.src.charCodeAt(pos + 1)
    nextChar =
      (lowSurr & 0xfc00) === 0xdc00
        ? 0x10000 + ((nextChar - 0xd800) << 10) + (lowSurr - 0xdc00)
        : 0xfffd
  } else if ((nextChar & 0xfc00) === 0xdc00) nextChar = 0xfffd

  const u = state.md.utils
  // 只对 `*`（canSplitWord = true）放宽：`_` 的 can_open 里 isLastPunctChar 是**正向
  // 使能**项（intraword 限制），放宽反而会把 `：__加粗__` 关掉（实测 emphasis.md 变红）。
  // 对 `*` 而言 punct 只起**阻挡**作用，放宽是单调的（只会多配、不会少配）。
  const isPunct = (cp) =>
    canSplitWord
      ? !isCjkPunct(cp) && (u.isMdAsciiPunct(cp) || u.isPunctCharCode(cp))
      : u.isMdAsciiPunct(cp) || u.isPunctCharCode(cp)
  const isLastPunctChar = isPunct(lastChar)
  const isNextPunctChar = isPunct(nextChar)
  const isLastWhiteSpace = u.isWhiteSpace(lastChar)
  const isNextWhiteSpace = u.isWhiteSpace(nextChar)

  const left_flanking =
    !isNextWhiteSpace && (!isNextPunctChar || isLastWhiteSpace || isLastPunctChar)
  const right_flanking =
    !isLastWhiteSpace && (!isLastPunctChar || isNextWhiteSpace || isNextPunctChar)
  const can_open = left_flanking && (canSplitWord || !right_flanking || isLastPunctChar)
  const can_close = right_flanking && (canSplitWord || !left_flanking || isNextPunctChar)
  return { can_open, can_close, length: count }
}

/** 与上游 emphasis_tokenize 同构，只把 state.scanDelims 换成 CJK 版 */
function emphasisTokenizeCjk(state, silent) {
  const start = state.pos
  const marker = state.src.charCodeAt(start)
  if (silent) return false
  if (marker !== 0x5f && marker !== 0x2a) return false
  const scanned = scanDelimsCjk(state, state.pos, marker === 0x2a)
  for (let i = 0; i < scanned.length; i++) {
    const token = state.push('text', '', 0)
    token.content = String.fromCharCode(marker)
    state.delimiters.push({
      marker,
      length: scanned.length,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close
    })
  }
  state.pos += scanned.length
  return true
}

function makeMd(patched) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false })
  if (patched) md.inline.ruler.at('emphasis', emphasisTokenizeCjk)
  return md
}

const FIXTURE =
  '**一句话**：这是一个**工程素养明显高于平均水平**的桌面应用 —— 安全基线正确、踩坑记录齐全、验收文化扎实、冷启动实测不到 1 秒；但它把最重的风险押在了**「保存路径」与「Markdown 保真」**这两件写作工具的信：**写盘不是原子操作、没有本地历史、没有任何往返保真验收**。工程侧最拖后腿的是 **`npm run lint` 目前是坏的（912 errors）**、**没有 CI / 没有单元测试**、以及**验收脚本没有统一入口**。'

function strongsOf(html) {
  let n = 0
  for (const m of html.matchAll(/<strong>/g)) n++
  return n
}

const stock = makeMd(false)
const patched = makeMd(true)

console.log('=== ① 用户夹具 ===')
for (const [name, md] of [
  ['stock', stock],
  ['cjk-patched', patched]
]) {
  const html = md.render(FIXTURE)
  console.log(`\n[${name}] <strong> 个数 = ${strongsOf(html)}`)
  console.log(html.replace(/\n/g, '\\n'))
}

console.log('\n=== ② 既有 md 夹具 diff（改动半径）===')
const dir = path.join(__dirname, 'fixtures', 'md')
let same = 0
const diffs = []
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith('.md')) continue
  const src = fs.readFileSync(path.join(dir, f), 'utf-8')
  const a = stock.render(src)
  const b = patched.render(src)
  if (a === b) same++
  else diffs.push({ f, a, b })
}
console.log(`相同 ${same} 个，不同 ${diffs.length} 个`)
for (const d of diffs.slice(0, 12)) {
  console.log(`\n--- ${d.f}`)
  console.log(`  stock  : ${d.a.replace(/\n/g, '\\n').slice(0, 600)}`)
  console.log(`  patched: ${d.b.replace(/\n/g, '\\n').slice(0, 600)}`)
}
