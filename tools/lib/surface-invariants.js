'use strict'
// ─── 两面一致性的不变量（纯函数，零依赖）──────────────────────────────────────
//
// 对应 docs/wysiwyg-test-plan.md §4 的 I1–I12：这里放**判据**，CDP 套件只负责取数（把两个面的
// 文本/结构抓回来）然后调用这些函数。这样做的好处是：判据本身可以被单测覆盖
// （tests/surfaceInvariants.test.mjs），套件不会因为「判据写错」而红。
//
// 判级沿用 tools/lib/md-fidelity.js：只承认能在 CommonMark 语义上站住的保义改写。

const { classify, normalizeMarkdown } = require('./md-fidelity')

/** I1 内容守恒：不劣于 normalized（lossy = 回归） */
function contentPreserved(source, produced) {
  const r = classify(source, produced)
  return {
    ok: r.level !== 'lossy',
    level: r.level,
    detail: r.detail,
    diagnosis: r.level === 'lossy' ? diagnoseLoss(source, produced) : null
  }
}

/** I2 幂等：同一内容再走一遍必须逐字相同 */
function idempotent(first, second) {
  const ok = first === second
  return { ok, detail: ok ? '逐字一致' : classify(first, second).detail }
}

/** I3/I4 逐字不变（切面无副作用 / 源码面稳定） */
function unchanged(before, after) {
  const ok = before === after
  return {
    ok,
    detail: ok ? '逐字一致' : `长度 ${String(before).length}→${String(after).length}；${classify(before, after).detail}`
  }
}

/**
 * 「非标记、非空白」的字符序列。
 *
 * **只用于分诊，不参与判级**：它会把保义改写（`*a*` → `_a_`）也算成「标记变了」，但对
 * 「内容到底丢没丢」这个问题非常敏感 —— 判 lossy 时先看它，能立刻回答「是真丢内容，
 * 还是只是被重写了标记」。
 */
function contentKey(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\\`*_~#>|[\]()!$]/g, '')
    .replace(/\s+/g, '')
}

/** 分诊：真正多出来/少掉的字符（按多重集差，给出前 20 个） */
function diagnoseLoss(source, produced) {
  const count = (s) => {
    const m = new Map()
    for (const ch of contentKey(s)) m.set(ch, (m.get(ch) ?? 0) + 1)
    return m
  }
  const a = count(source)
  const b = count(produced)
  const lost = []
  const added = []
  for (const [ch, n] of a) {
    const d = n - (b.get(ch) ?? 0)
    for (let i = 0; i < d && lost.length < 20; i++) lost.push(ch)
  }
  for (const [ch, n] of b) {
    const d = n - (a.get(ch) ?? 0)
    for (let i = 0; i < d && added.length < 20; i++) added.push(ch)
  }
  return {
    markerOnly: lost.length === 0 && added.length === 0,
    lost: lost.join(''),
    added: added.join('')
  }
}

/**
 * I7 渲染面完整性（哨兵词版）：生成器在可见文本里埋了唯一哨兵词，两个面都必须
 * **按同样顺序全部出现**。比「猜哪些字符算可见文本」稳得多，也能抓到截断与重复。
 */
function traceTokens(text, tokens) {
  const s = String(text)
  const missing = []
  const positions = []
  for (const t of tokens) {
    const at = s.indexOf(t)
    if (at < 0) missing.push(t)
    else positions.push(at)
  }
  let outOfOrder = false
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1]) outOfOrder = true
  }
  return {
    ok: missing.length === 0 && !outOfOrder,
    missing,
    outOfOrder,
    found: positions.length,
    total: tokens.length
  }
}

// ─── 结构（I5）：从 Markdown 数「应该有多少结构」 ────────────────────────────
// 诊断级实现：只覆盖不容易误判的几类，且**跳过围栏代码块内部**（那里的一切都不是结构）。
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_RE = /^ {0,3}(#{1,6})(?:\s|$)/
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const QUOTE_RE = /^ {0,3}>/
const TASK_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s/
const ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/
const TABLE_DELIM_RE = /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/**
 * @param {string} md
 * @returns {{headings:number[], codeBlocks:number, codeInfos:string[], mathBlocks:number,
 *            hr:number, quotes:number, listItems:number, taskItems:number, tables:number, images:number}}
 */
function structureFromMarkdown(md) {
  const out = {
    headings: [],
    codeBlocks: 0,
    codeInfos: [],
    mathBlocks: 0,
    hr: 0,
    quotes: 0,
    listItems: 0,
    taskItems: 0,
    tables: 0,
    images: 0,
    frontmatter: 0,
    htmlBlocks: 0
  }
  const lines = String(md)
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let fence = null
  let inMath = false
  let prevWasDelim = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {      const close = new RegExp('^ {0,3}' + fence.ch + '{' + fence.len + ',}\\s*$')
      if (close.test(line)) fence = null
      continue
    }
    const fm = FENCE_RE.exec(line)
    if (fm) {
      fence = { ch: fm[1][0] === '`' ? '`' : '~', len: fm[1].length }
      out.codeBlocks += 1
      out.codeInfos.push(fm[2].trim())
      continue
    }
    if (inMath) {
      if (/^ {0,3}\$\$\s*$/.test(line)) inMath = false
      continue
    }
    if (/^ {0,3}\$\$/.test(line)) {
      out.mathBlocks += 1
      if (!/^ {0,3}\$\$.+\$\$\s*$/.test(line)) inMath = true
      continue
    }
    // YAML front matter：只在文档第 0 行成立（找不到收尾 `---` 就不算，按普通内容继续扫）
    if (i === 0 && /^ {0,3}---\s*$/.test(line)) {
      let close = -1
      for (let j = 1; j < lines.length; j++) {
        if (/^ {0,3}---\s*$/.test(lines[j])) {
          close = j
          break
        }
      }
      if (close > 0) {
        out.frontmatter += 1
        i = close
        continue
      }
    }
    const atx = ATX_RE.exec(line)
    if (atx) out.headings.push(atx[1].length)
    if (HR_RE.test(line)) out.hr += 1
    // 连续引用行算一个引用块（与 ProseMirror 的 blockquote 节点数对齐）
    const quoted = QUOTE_RE.test(line)
    const prevQuoted = i > 0 && QUOTE_RE.test(lines[i - 1])
    if (quoted && !prevQuoted) out.quotes += 1
    if (TASK_RE.test(line)) out.taskItems += 1
    else if (ITEM_RE.test(line)) out.listItems += 1
    if (TABLE_DELIM_RE.test(line) && line.includes('-') && line.includes('|')) {
      if (!prevWasDelim) out.tables += 1
      prevWasDelim = true
    } else {
      prevWasDelim = false
    }
    out.images += (line.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length
  }
  return out
}

/** 结构比对：只比「稳」的几项，返回差异清单（空数组 = 一致） */
function structureDiff(expected, actual) {
  const diffs = []
  for (const key of [
    'codeBlocks',
    'mathBlocks',
    'hr',
    'tables',
    'taskItems',
    'listItems',
    'quotes',
    'images',
    'frontmatter',
    'htmlBlocks'
  ]) {
    if (expected[key] === undefined) continue
    if ((expected[key] ?? 0) !== (actual[key] ?? 0)) {
      diffs.push(`${key}: 期望 ${expected[key]} 实际 ${actual[key] ?? 0}`)
    }
  }
  if (Array.isArray(expected.headings) && Array.isArray(actual.headings)) {
    const a = expected.headings.join(',')
    const b = actual.headings.join(',')
    if (a !== b) diffs.push(`标题层级序列: 期望 [${a}] 实际 [${b}]`)
  }
  return diffs
}

/** 三档计数（报告用） */
function tally(levels) {
  const t = { exact: 0, normalized: 0, lossy: 0 }
  for (const l of levels) t[l] = (t[l] ?? 0) + 1
  return t
}

module.exports = {
  contentPreserved,
  idempotent,
  unchanged,
  contentKey,
  diagnoseLoss,
  traceTokens,
  structureFromMarkdown,
  structureDiff,
  tally,
  normalizeMarkdown
}
