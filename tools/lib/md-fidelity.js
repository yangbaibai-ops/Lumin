'use strict'
// ─── Markdown 往返保真的「判级器」（纯函数，零依赖）────────────────────────────
//
// 用途：回答一个写作工具最要命的问题 —— **用户打开一份 .md，什么都不改就保存，
// 文件会不会变？**（更糟的情况：内容被吃掉。）
//
// 判三级（等级数字越大越糟，actual > expected 就是回归）：
//   exact      磁盘字节完全没变（含行尾、BOM —— 那由套件的字节级用例单独覆盖）
//   normalized 经过**下面这套明文规则**规范化后完全一致：文件会被重写，但语义没丢
//   lossy      规范化后仍不一致 → 内容/结构真的变了，必须当成缺陷处理
//
// 规范化的原则：**只做「保义改写」**，每一条都要能在 CommonMark 语义上站得住脚。
// 一旦某条规则需要「猜」，就不该写进这里 —— 宁可判 lossy 让人去看，也不要拿规则
// 把真问题糊过去（这是评审报告点名要立的规矩）。
//
// 规则清单（`RULES` 也导出，方便文档/报告直接引用）：
//   1. 行尾统一为 LF（CRLF/CR → LF）
//   2. 行尾硬换行（`\` 或两个以上空格）统一标记，两种写法视为同一种硬换行
//   3. 行尾空白（不含硬换行）去掉
//   4. ATX 标题：`## 标题 ##` → `## 标题`；`#标题`（无空格，本是段落）原样
//   5. Setext 标题（`===`/`---` 下划线）→ `#` / `##` 形式
//   6. 无序列表标记 `*`/`+`/`-` → `-`
//   7. 有序列表标记 `1)` → `1.`（起始数字保留，它是有语义的）
//   8. 引用块 `>`/`> ` → `> `
//   9. 分割线 `***`/`___`/`- - -` → `---`
//  10. 表格：单元格两侧空白归一为 `| a | b |`，分隔行只保留对齐冒号
//  11. 围栏代码块：`~~~` → ``` ```（内容里已有三个反引号时保持 `~~~`），info 串去空白
//  12. 缩进代码块（4 空格）与无 info 的围栏代码块视为同一种东西
//  13. 行内代码之外的强调标记：`__x__` → `**x**`，`_x_` → `*x*`（词内下划线不动）
//  14. 链接目标的尖括号包装去掉：`[a](<u>)` → `[a](u)`
//  15. HTML 实体还原为字符（`&amp; &lt; &gt; &quot; &#39;`）
//  16. 引用式链接按定义展开为行内链接（`[a][r]` → `[a](url)`）—— 保义但会重写
//  17. 段落内软换行合并（CommonMark 里段内软换行 ≡ 一个空格），
//      但标题/围栏/表格/分割线/引用定义等「单行块」不吸收下一行
//  18. 连续空行压成一个；文末统一单个换行
//  19. 有序列表编号按位置重算（从**首项**编号起）—— 编号在 CommonMark 里只是「起始值」装饰，
//      同一个列表里 `1./2./3.` + 空行 + `5./6.` 与 `1..5` 渲染完全一致；首项编号是
//      `<ol start="N">`，有语义，必须保留（所以不是一律从 1 开始）
//
// **13–19 之外的一切差异都算 lossy。** 围栏代码块内、行内代码内的内容一律原样比对
// （那里每个空格都是语义）—— 实现上给围栏内的行打私有区哨兵，后面的空行压缩与
// 软换行合并都会跳过它们。

const LEVEL = { exact: 0, normalized: 1, lossy: 2 }
const LEVEL_NAME = ['exact', 'normalized', 'lossy']

const RULES = [
  '行尾统一 LF',
  '硬换行（行尾 \\ 或两空格）统一标记',
  '去掉行尾空白',
  'ATX 标题收尾 # 与 # 后空格归一',
  'Setext 标题转 ATX',
  '无序列表标记归一为 -',
  '有序列表标记 ) 归一为 .',
  '引用块前缀归一为 "> "',
  '分割线归一为 ---',
  '表格单元格空白与分隔行归一',
  '围栏标记 ~~~ 归一为 ``` 并去 info 空白',
  '缩进代码块与无 info 围栏等价',
  '强调标记 __/_ 归一为 **/*',
  '链接目标去尖括号',
  'HTML 实体还原为字符',
  '引用式链接展开为行内链接',
  '段落内软换行合并（软换行 ≡ 空格）',
  '连续空行压缩、文末补单个换行',
  '有序列表编号按位置重算（编号只是起始值装饰；首项编号保留）'
]

// 私有区哨兵：用 String.fromCharCode 生成，**不要在源码里写字面量控制字符**
// （那会让 git 把文件当二进制、让编辑工具拒绝打开）
const SENTINEL = String.fromCharCode(0xe000)
const HARD_BREAK = SENTINEL + 'BR'
const CODE_MASK = SENTINEL + 'C'
const FENCE_BODY = SENTINEL + 'F'

const isProtected = (l) => typeof l === 'string' && l.startsWith(FENCE_BODY)
const unprotect = (l) => (isProtected(l) ? l.slice(FENCE_BODY.length) : l)

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const ATX_RE = /^( {0,3})(#{1,6})\s+(.*?)\s*$/
const BULLET_RE = /^(\s*)([*+-])(\s+)(.*)$/
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/
const QUOTE_RE = /^( {0,3})>\s?(.*)$/
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/
const INDENTED_RE = /^(?: {4}|\t)(.*)$/
const TABLE_ROW_RE = /^ {0,3}\|.*\| *$/
const TABLE_DELIM_RE = /^ {0,3}\|[ :|-]*-[ :|-]*\| *$/
const REF_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+["'(](.*)["')])?\s*$/
const REF_LINK_RE = /\[([^\]]*)\]\[([^\]]*)\]/g

/** 行尾硬换行统一成标记，便于「反斜杠」与「两空格」两种写法判等 */
function stripHardBreaks(line) {
  if (/\\$/.test(line)) return { line: line.slice(0, -1), br: true }
  if (/[ \t]{2,}$/.test(line)) return { line: line.replace(/[ \t]+$/, ''), br: true }
  return { line: line.replace(/[ \t]+$/, ''), br: false }
}

/** 行内代码用占位符遮住：里面的 _ * [ ] 等都不是标记 */
function maskInlineCode(line, store) {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => {
    store.push(m)
    return CODE_MASK + (store.length - 1) + SENTINEL
  })
}
function unmaskInlineCode(line, store) {
  return line.replace(new RegExp(CODE_MASK + '(\\d+)' + SENTINEL, 'g'), (_, i) => store[Number(i)])
}

/** 常见命名实体（够覆盖真实文档；未收录的保持原样，不会被误判成「保义改写」） */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  larr: '←',
  rarr: '→',
  harr: '↔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  int: '∫'
}

/** 实体还原为字符（命名 + 十进制 + 十六进制）：两边都还原，`&lt;` 与 `<` 才能判等 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 链接目标的百分号编码还原：`%E4%B8%AD` ≡ `中`（同一份 URL 的两种写法） */
function decodeUrlTargets(text) {
  return text.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, url, title) => {
    let decoded = url
    try {
      decoded = decodeURI(url)
    } catch {
      /* 非法转义序列 → 原样 */
    }
    return '](' + decoded + (title ?? '') + ')'
  })
}

/** 行内（非代码）改写 */
function normalizeInline(line) {
  const store = []
  let s = maskInlineCode(line, store)
  s = decodeEntities(s)
  // 非必要转义：`\\` 与 `\` 在 CommonMark 里都表示一个字面反斜杠
  // （序列化器为了保险会把所有反斜杠写成 `\\`，那是保义改写，不是内容变化）
  s = s.replace(/\\\\/g, '\\')
  // 强调：__x__ → **x**；_x_ → *x*（两侧不能是词字符，避免 snake_case 被改）
  s = s.replace(/(^|[^\w\\])__([^_\n]+?)__(?!\w)/g, (_, p, body) => p + '**' + body + '**')
  s = s.replace(/(^|[^\w\\])_([^_\n]+?)_(?!\w)/g, (_, p, body) => p + '*' + body + '*')
  // 链接目标尖括号
  s = s.replace(/\]\(<([^>\s]+)>\)/g, ']($1)')
  // 裸 URL 的自动链接：`<https://x>` 与 `https://x` 在 linkify 语义下等价
  s = s.replace(/<((?:https?|mailto|ftp):[^>\s]+)>/g, '$1')
  s = decodeUrlTargets(s)
  return unmaskInlineCode(s, store)
}

/** 表格行：按未转义的 | 切分，单元格去空白后重新拼 */
function canonicalTableRow(line) {
  const cells = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1]
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  // 首尾空单元（表格行两端的 |）不算单元格
  if (cells.length && cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  const out = cells.map((c) => {
    const t = c.trim()
    if (/^:?-+:?$/.test(t)) {
      const left = t.startsWith(':')
      const right = t.endsWith(':')
      return (left ? ':' : '') + '---' + (right ? ':' : '')
    }
    return t
  })
  return '| ' + out.join(' | ') + ' |'
}

/** 这段行里最长的反引号连续串（决定围栏要用几个反引号） */
function longestBacktickRun(lines) {
  let best = 0
  for (const l of lines) {
    const m = l.match(/`+/g)
    if (m) for (const run of m) best = Math.max(best, run.length)
  }
  return best
}

/** 单行块（不吸收下一行做软换行合并的那些行） */
function isSingleLineBlock(line) {
  if (line === undefined) return true
  if (isProtected(line)) return true
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true
  if (/^ {0,3}\$\$/.test(line)) return true
  if (HR_RE.test(line)) return true
  if (line.includes('|') && (TABLE_ROW_RE.test(line) || TABLE_DELIM_RE.test(line))) return true
  if (REF_DEF_RE.test(line)) return true
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true
  return false
}

/** 这一行是不是「块的起点」（软换行合并时必须断开） */
function isBlockStart(line) {
  if (line === undefined) return true
  if (isProtected(line)) return true
  if (line.trim() === '') return true
  if (line.endsWith(HARD_BREAK)) return true
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true
  if (QUOTE_RE.test(line)) return true
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])\s/.test(line)) return true
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true
  if (/^ {0,3}\$\$/.test(line)) return true
  if (HR_RE.test(line)) return true
  if (line.includes('|') && (TABLE_ROW_RE.test(line) || TABLE_DELIM_RE.test(line))) return true
  if (REF_DEF_RE.test(line)) return true
  if (/^ {0,3}</.test(line)) return true
  if (INDENTED_RE.test(line)) return true
  return false
}

/**
 * 找出「两个不同标记的列表之间」那些没有语义的空行（行号集合）。
 *
 * 必须在**行级归一化之前**判定：规则 6 会把 `*`/`+` 也写成 `-`，判完就再也分不出
 * 两个列表的标记了。所以这里先扫一遍原始行。
 */
function findInertListBlanks(lines) {
  const drop = new Set()
  let fence = null
  let lastNonEmpty = -1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const fm = FENCE_RE.exec(raw)
    if (fm) {
      fence = fence ? null : { ch: fm[2][0], len: fm[2].length }
      lastNonEmpty = i
      continue
    }
    if (fence) {
      const close = new RegExp('^ {0,3}' + (fence.ch === '`' ? '`' : '~') + '{' + fence.len + ',}\\s*$')
      if (close.test(raw)) fence = null
      lastNonEmpty = i
      continue
    }
    if (raw.trim() !== '') {
      lastNonEmpty = i
      continue
    }
    // 一段空行：看它前面和后面的非空行是不是「不同标记的列表项」
    let next = i
    while (next < lines.length && lines[next].trim() === '') next += 1
    if (lastNonEmpty < 0 || next >= lines.length) continue
    if (blankIsInertBetweenLists(lines[lastNonEmpty], lines[next])) {
      for (let k = i; k < next; k++) drop.add(k)
    }
  }
  return drop
}

/** 列表项标记（无序返回 - * +，有序返回 `1.` 等） */
const LIST_ITEM_RE = /^ {0,3}([*+-]|\d{1,9}[.)])\s/
function listMarkerOf(line) {
  const m = LIST_ITEM_RE.exec(line)
  return m ? m[1] : null
}

/**
 * 两个相邻列表之间的空行有没有语义？
 *   * 无序标记**不同**（`-` 与 `*`/`+`）：CommonMark 靠标记区分列表，空行纯属排版 → 无义；
 *   * 无序标记相同：空行会把两段并成同一个**松散列表**（项间多出段落间距）→ 有意义，不能抹；
 *   * 有序列表：编号在 CommonMark 里只是「起始值」装饰（`1.` 后面跟 `5.` 仍是**同一个**列表，
 *     渲染序号由位置决定）—— 空行只把整表变松散，而「松散」是**整表**属性（有没有空行决定，
 *     位置不决定），保存前后渲染一致 → 无义。分隔符 `)` 与 `.` 这里也不区分，理由见函数末尾。
 */
function blankIsInertBetweenLists(prev, next) {
  const a = listMarkerOf(prev)
  const b = listMarkerOf(next)
  if (!a || !b) return false
  const unordered = (m) => m === '-' || m === '*' || m === '+'
  if (unordered(a) || unordered(b)) return unordered(a) && unordered(b) && a !== b
  const ordered = (m) => /^\d{1,9}[.)]$/.test(m)
  // 有序：分隔符 `)` 与 `.` 不再区分（规则 7 会把 `)` 归一为 `.`，若这里区分，
  // 规范化就会**不幂等**：第一遍 `1)…` 与 `2.…` 是两个列表（空行有意义），
  // 第二遍两边都成了 `.`（空行变无义）—— 判级结果随遍数漂移，套件就飘了。
  return ordered(a) && ordered(b)
}

/** 有序列表项：缩进 + 编号 + 分隔符 + 空白 */
const ORDERED_ITEM_RE = /^(\s*)(\d{1,9})([.)])\s/

/**
 * 有序列表的编号按位置重算（从该列表**首项**的编号开始）。
 *
 * 为什么只从首项开始、而不是一律从 1 开始：首项的编号是 `<ol start="N">`，**有语义**
 * （从 5 开始的列表渲染出来就是 5、6…），必须保留；而后续项的编号在 CommonMark 里
 * 只是装饰（渲染序号由位置决定），同一个列表里写 `1. 2. 3.` 还是 `1. 5. 9.` 渲染完全一样。
 * 不重算的话，「`1./2./3.` + 空行 + `5./6.`」这类（同一个列表）在保存后编号连续成 1..5
 * 就会被判成内容损坏 —— 其实一个字节的语义都没变。
 */
function renumberOrderedListLines(lines) {
  let i = 0
  while (i < lines.length) {
    const m = ORDERED_ITEM_RE.exec(lines[i])
    if (!m || isProtected(lines[i])) {
      i += 1
      continue
    }
    const re = new RegExp(`^${m[1]}\\d{1,9}\\${m[3]}\\s`)
    let n = Number(m[2])
    let j = i + 1
    for (; j < lines.length; j += 1) {
      if (isProtected(lines[j]) || !re.test(lines[j])) break
      n += 1
      lines[j] = lines[j].replace(/^(\s*)\d{1,9}([.)])/, `$1${n}$2`)
    }
    i = j
  }
}

/**
 * 规范化一份 Markdown 文本。
 * @param {string} md
 * @returns {string}
 */
function normalizeMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const inertBlanks = findInertListBlanks(lines)

  // 先收集引用式链接定义（它们可以从文档任何位置定义）
  const defs = new Map()
  for (const line of lines) {
    const m = REF_DEF_RE.exec(line)
    if (m) defs.set(m[1].trim().toLowerCase(), m[2])
  }

  const out = []
  let fence = null

  for (let i = 0; i < lines.length; i++) {
    if (inertBlanks.has(i)) continue
    const raw = lines[i]

    // ── 围栏代码块：内容原样（只归一围栏本身），围栏内的行打哨兵 ──
    if (fence) {
      // CommonMark：闭合围栏必须**不短于**开启围栏（` ```` ` 围栏里的 ``` 不闭合它）
      const close = new RegExp(
        '^ {0,3}' + (fence.ch === '`' ? '`' : '~') + '{' + fence.len + ',}\\s*$'
      )
      if (close.test(raw)) {
        const body = out.splice(fence.at, out.length - fence.at)
        // `~~~` 只有在内容里没有 ``` 时才能归一为 ```；反引号围栏则取「比内容里最长串更长」
        const run = longestBacktickRun(body)
        const marker = fence.ch === '~' && run >= 3 ? '~~~' : '`'.repeat(Math.max(3, run + 1))
        out.push(marker + fence.info, ...body, marker)
        fence = null
      } else {
        out.push(FENCE_BODY + raw)
      }
      continue
    }
    const fm = FENCE_RE.exec(raw)
    if (fm) {
      fence = { ch: fm[2][0], len: fm[2].length, info: fm[3].trim(), at: out.length }
      continue
    }

    // ── `$$` 块级公式：单行写法与多行写法归一到多行 ──
    if (/^ {0,3}\$\$/.test(raw)) {
      const inline = /^ {0,3}\$\$\s*([\s\S]*?)\s*\$\$\s*$/.exec(raw)
      const inner = inline ? inline[1] : null
      if (inline && inner) {
        out.push('$$', ...inner.split('\n').map((l) => FENCE_BODY + l.trim()), '$$')
      } else {
        const body = []
        let j = i + 1
        for (; j < lines.length; j++) {
          if (/^ {0,3}\$\$\s*$/.test(lines[j])) break
          body.push(lines[j])
        }
        out.push('$$', ...body.map((l) => FENCE_BODY + l.trim()), '$$')
        i = j
      }
      continue
    }

    // ── 缩进代码块 → 无 info 的围栏（保义）──
    const ind = INDENTED_RE.exec(raw)
    if (ind && (out.length === 0 || out[out.length - 1].trim() === '')) {
      const body = []
      let j = i
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '') {
          body.push('')
          continue
        }
        const m = INDENTED_RE.exec(l)
        if (!m) break
        body.push(m[1])
      }
      // 尾随空行不属于缩进代码块（CommonMark）：弹掉后要在围栏之后补回一个空行，
      // 否则「代码块 → 正文」之间会少一个分段空行，与序列化器的输出对不上
      let trailing = 0
      while (body.length && body[body.length - 1] === '') {
        body.pop()
        trailing += 1
      }
      out.push('```', ...body.map((l) => FENCE_BODY + l), '```')
      if (trailing > 0) out.push('')
      i = j - 1
      continue
    }

    const { line: body, br } = stripHardBreaks(raw)
    const suffix = br ? HARD_BREAK : ''

    // ── 引用式链接定义行：展开后就不再有意义（序列化器也不会写回它们）──
    if (defs.size && REF_DEF_RE.test(body)) continue

    // ── Setext 标题：把它前面那行改成 ATX ──
    // 注意顺序：`---` 既是 Setext 下划线也是分割线，CommonMark 的判定是
    // 「前面那行是段落文本 → Setext 标题；否则 → 分割线」，所以必须先试 Setext。
    const sx = SETEXT_RE.exec(body)
    if (sx && out.length) {
      const prev = out[out.length - 1]
      if (prev && prev.trim() !== '' && !isSingleLineBlock(prev) && !isBlockStart(prev)) {
        out[out.length - 1] = (sx[1][0] === '=' ? '# ' : '## ') + prev.trim()
        continue
      }
    }

    let line = body

    // ── 表格（必须有竖线，否则 `---` 会被误当分隔行）──
    if (body.includes('|') && (TABLE_ROW_RE.test(body) || TABLE_DELIM_RE.test(body))) {
      line = canonicalTableRow(body)
    } else {
      // ── 引用块：先把 > 前缀摘出来，内部再按普通行处理 ──
      const q = QUOTE_RE.exec(body)
      if (q) {
        line = '> ' + normalizeInline(q[2])
      } else if (HR_RE.test(body)) {
        line = '---'
      } else {
        const atx = ATX_RE.exec(body)
        if (atx) {
          const text = atx[3].replace(/\s*#+\s*$/, '').trim()
          line = atx[2] + (text ? ' ' + normalizeInline(text) : '')
        } else {
          const b = BULLET_RE.exec(body)
          const o = ORDERED_RE.exec(body)
          if (b) {
            line = b[1] + '- ' + normalizeInline(b[4])
          } else if (o) {
            line = o[1] + o[2] + '. ' + normalizeInline(o[5])
          } else {
            line = normalizeInline(body)
          }
        }
      }
    }

    // ── 引用式链接展开（保义但会重写文件）──
    if (defs.size) {
      line = line.replace(REF_LINK_RE, (m, text, ref) => {
        const key = (ref || text).trim().toLowerCase()
        const url = defs.get(key)
        return url ? `[${text}](${url})` : m
      })
      // 简写引用形式：[label]（后面不跟 ( 或 [ 才是引用，图片的 ![alt] 也被 ( 挡住）
      line = line.replace(/\[([^\]]+)\](?!\(|\[)/g, (m, label) => {
        const url = defs.get(label.trim().toLowerCase())
        return url ? `[${label}](${url})` : m
      })
    }

    out.push(line + suffix)
  }
  if (fence) {
    const body = out.splice(fence.at, out.length - fence.at)
    out.push('```' + fence.info, ...body, '```')
  }

  // ── 空行压缩 / 首尾裁剪（围栏内的空行是语义，跳过）──
  const collapsed = []
  let blanks = 0
  for (const l of out) {
    if (isProtected(l)) {
      blanks = 0
      collapsed.push(l)
      continue
    }
    if (l.trim() === '') {
      blanks += 1
      if (blanks > 1) continue
    } else {
      blanks = 0
    }
    collapsed.push(l)
  }
  while (collapsed.length && !isProtected(collapsed[0]) && collapsed[0].trim() === '') collapsed.shift()
  while (
    collapsed.length &&
    !isProtected(collapsed[collapsed.length - 1]) &&
    collapsed[collapsed.length - 1].trim() === ''
  )
    collapsed.pop()

  // ── 段落内软换行合并（围栏内不动）──
  const joined = []
  for (const l of collapsed) {
    const prev = joined[joined.length - 1]
    const joinable =
      !isProtected(l) &&
      joined.length > 0 &&
      !isProtected(prev) &&
      prev.trim() !== '' &&
      !prev.endsWith(HARD_BREAK) &&
      !isSingleLineBlock(prev) &&
      !isBlockStart(l)
    if (joinable) {
      joined[joined.length - 1] = prev + ' ' + l.trim()
    } else {
      joined.push(l)
    }
  }

  // ── 有序列表编号按位置重算（CommonMark 里编号只是起始值装饰，见函数说明）──
  renumberOrderedListLines(joined)

  return joined.map(unprotect).join('\n') + '\n'
}

/** 找出规范化后第一处与最后一处不同的行号（0 基），以及两侧内容 */
function locateDiff(nBefore, nAfter) {
  const a = nBefore.split('\n')
  const b = nAfter.split('\n')
  let first = -1
  let last = -1
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if ((a[i] ?? ' <EOF>') !== (b[i] ?? ' <EOF>')) {
      if (first < 0) first = i
      last = i
    }
  }
  return { first, last, before: a, after: b }
}

/** 一处差异的可读说明（给控制台/报告用，别太长） */
function describeDiff(before, after) {
  const n1 = normalizeMarkdown(before)
  const n2 = normalizeMarkdown(after)
  const { first, last, before: a, after: b } = locateDiff(n1, n2)
  if (first < 0) return '规范化后一致'
  const ctx = (arr, i) =>
    arr
      .slice(Math.max(0, i - 1), Math.min(arr.length, i + 3))
      .map((l) => JSON.stringify(l).slice(0, 110))
      .join(' / ')
  return [
    `规范化后第 ${first + 1}${last === first ? '' : '~' + (last + 1)} 行起不一致`,
    `原文 ${ctx(a, first)}`,
    `返回 ${ctx(b, first)}`
  ].join(' | ')
}

/** 规范化到底改了什么（NORMALIZED 时给一行理由，便于人工复核这条规则是否合理） */
function describeNormalization(before, after) {
  const changed = []
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')
  if (/\r/.test(before) && !/\r/.test(after)) changed.push('行尾 CRLF→LF')
  if (a.length !== b.length) changed.push(`行数 ${a.length}→${b.length}`)
  if (/^\s*[*+] /m.test(before) && /^\s*- /m.test(after)) changed.push('列表标记归一')
  if (/^ {0,3}~~~/m.test(before) && /^ {0,3}```/m.test(after)) changed.push('围栏归一')
  if (/^ {4}\S/m.test(before) && /^ {0,3}```/m.test(after)) changed.push('缩进代码转围栏')
  if (!/%[0-9A-F]{2}/.test(after) && /%[0-9A-F]{2}/.test(before)) changed.push('URL 解码')
  if (/&(amp|lt|gt|quot|#39);/.test(before) && !/&(amp|lt|gt|quot|#39);/.test(after))
    changed.push('实体还原')
  if (/\n{3,}/.test(before) && !/\n{3,}/.test(after)) changed.push('空行压缩')
  if (/^\s*\[[^\]]+\]:/m.test(before)) changed.push('引用式链接展开')
  if (/^[^#\n].*\n\s*(?:=+|-+)\s*$/m.test(before) && /^#{1,2} /m.test(after))
    changed.push('Setext 转 ATX')
  if (!before.endsWith('\n') && after.endsWith('\n')) changed.push('文末补换行')
  if (!changed.length) changed.push('规范化规则命中（多为软换行合并）')
  return changed.join('、')
}

/**
 * 判级。
 * @param {string} before 原始 Markdown（磁盘上的字节解出来的文本）
 * @param {string} after  往返后（序列化器/保存）产出的 Markdown
 * @returns {{level:'exact'|'normalized'|'lossy', detail:string}}
 */
function classify(before, after) {
  const s1 = String(before)
  const s2 = String(after)
  if (s1 === s2) return { level: 'exact', detail: '字节一致' }
  if (normalizeMarkdown(s1) === normalizeMarkdown(s2)) {
    return { level: 'normalized', detail: describeNormalization(s1, s2) }
  }
  return { level: 'lossy', detail: describeDiff(s1, s2) }
}

/** 实际比预期差就是回归（数字越大越糟） */
function worseThan(actual, expected) {
  return LEVEL[actual] > LEVEL[expected]
}

/**
 * 逐行 unified 风格差异（诊断用；只用于终端打印，不参与判级）。
 * @param {string} before
 * @param {string} after
 * @param {number} limit 最多打印多少行差异
 */
function unifiedDiff(before, after, limit = 24) {
  const a = normalizeMarkdown(before).split('\n')
  const b = normalizeMarkdown(after).split('\n')
  const lines = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max && lines.length < limit; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    lines.push(`  ${i + 1}- ${JSON.stringify(x ?? '')}`)
    lines.push(`  ${i + 1}+ ${JSON.stringify(y ?? '')}`)
  }
  if (lines.length >= limit) lines.push('  …（差异更多，已截断）')
  return lines.join('\n')
}

module.exports = {
  LEVEL,
  LEVEL_NAME,
  RULES,
  normalizeMarkdown,
  classify,
  describeDiff,
  describeNormalization,
  unifiedDiff,
  worseThan
}
