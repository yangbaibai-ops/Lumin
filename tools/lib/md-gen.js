'use strict'
// ─── 生成式语料库（纯函数，零依赖，种子可复现）────────────────────────────────
//
// 为什么要有它：31 份黄金夹具能守住「已知的写法」，但守不住**组合**。历史上咬人的缺陷全部长在
// 组合缝里：`$a * b$` 被 `*` 切开（标记相邻）、`1./2./3.` + 空行 + `5./6.` 编号重排（列表相邻）、
// 围栏里放 ```（构造自嵌套）、代码块内容末尾空行（行终止符语义）。这类问题用穷举不了的夹具去碰，
// 只能靠**生成**。
//
// 设计要点（与 docs/wysiwyg-test-plan.md §5 对应）：
//   * **构造注册表**：每条构造是一个小函数，写出一段合法 Markdown，并声明
//     `tags`（失败报告里用它指认元凶）、`struct`（这段应该产生多少结构，供 I5 比对）、
//     `tokens`（写进可见文本的哨兵词，供 I7 查「有没有被吃掉/截断」）；
//   * **三层组合**：块序列（含三种接缝）+ 上下文包裹（引用/列表项/表格单元）+ 行内混入（含
//     刻意制造标记相邻）；
//   * **文档级变异**：行尾 CRLF/CR/LF、BOM、文末换行、前导/尾随空行；
//   * **种子驱动**：`generateCorpus({seed, count})` 同种子同输出，且第 i 篇只依赖 (seed, i) ——
//     加大 count 只会追加，不会让已有用例换样（失败复现稳定）。
//
// 哨兵词为什么必要：判级器（md-fidelity）比的是**文本**，而「渲染面有没有真的显示出来」要靠
// ProseMirror 的 textContent。与其去猜「哪些字符算可见文本」，不如让生成器自己埋一串
// 只可能来自正文的 ASCII 词（`ZQ12`），然后断言它们在两个面里**按同样顺序全部出现**。
//
// 用法：
//   const { generateCorpus } = require('./lib/md-gen')
//   for (const doc of generateCorpus({ seed: 20260916, count: 200 })) { ... doc.md, doc.tokens ... }

/** mulberry32：小、快、跨平台确定（不依赖 Math.random 的实现细节） */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 第 index 篇的随机源：只依赖 (seed, index) —— 见文件头「种子驱动」 */
function rngFor(seed, index) {
  return mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0)
}

const int = (rng, a, b) => a + Math.floor(rng() * (b - a + 1))
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const chance = (rng, p) => rng() < p

// ─── 行内构造 ────────────────────────────────────────────────────────────────
// 每个函数返回一段可以嵌进段落文本的行内 Markdown；`tk()` 取一个全局唯一哨兵词。
const INLINE = [
  // 强调：词内下划线、嵌套、标记相邻都是历史上出过事的写法
  { id: 'em-star', tags: ['emphasis'], make: (rng, tk) => `*${tk()}斜*` },
  { id: 'em-underscore', tags: ['emphasis'], make: (rng, tk) => `_${tk()}斜_` },
  { id: 'strong-star', tags: ['emphasis'], make: (rng, tk) => `**${tk()}粗**` },
  { id: 'strong-underscore', tags: ['emphasis'], make: (rng, tk) => `__${tk()}粗__` },
  { id: 'bold-italic', tags: ['emphasis'], make: (rng, tk) => `***${tk()}粗斜***` },
  { id: 'strike', tags: ['strike'], make: (rng, tk) => `~~${tk()}删~~` },
  { id: 'snake-case', tags: ['emphasis', 'intraword'], make: (rng, tk) => `${tk()}_snake_case_名` },
  { id: 'marker-adjacent', tags: ['emphasis', 'adjacent'], make: (rng, tk) => `*a*${tk()}*b*` },
  // 行内代码：反引号数量、内容里带反引号
  { id: 'code-span', tags: ['code'], make: (rng, tk) => '`' + `${tk()}_code` + '`' },
  { id: 'code-span-backtick', tags: ['code'], make: (rng, tk) => '``' + `${tk()} a` + '`' + ' b``' },
  // 链接与图片
  {
    id: 'link-inline',
    tags: ['link'],
    struct: { links: 1 },
    // 注意：哨兵词**只能注册一次**，且必须原样出现在正文里（否则 I7 的空验就是假的）——
    // URL 里那份小写副本是同一个词的另一种写法，不额外注册
    make: (rng, tk) => {
      const t = tk()
      return `[${t}链接](https://example.com/${t.toLowerCase()})`
    }
  },
  {
    id: 'link-title',
    tags: ['link'],
    struct: { links: 1 },
    make: (rng, tk) => `[${tk()}带题](https://example.com/x "标题")`
  },
  { id: 'link-angle', tags: ['link'], struct: { links: 1 }, make: (rng, tk) => `[${tk()}尖](<a b>)` },
  { id: 'autolink', tags: ['link'], struct: { links: 1 }, make: (rng, tk) => `<https://example.com/${tk()}>` },
  { id: 'bare-url', tags: ['link'], struct: { links: 1 }, make: (rng, tk) => `https://example.com/${tk()}` },
  {
    id: 'image-inline',
    tags: ['image'],
    struct: { images: 1 },
    make: (rng, tk) => `![${tk()}图](img/a.png)`
  },
  {
    id: 'image-linked',
    tags: ['image', 'link'],
    struct: { images: 1, links: 1 },
    make: (rng, tk) => `[![${tk()}图](img/b.png)](https://example.com/i)`
  },
  // HTML
  { id: 'html-kbd', tags: ['html'], make: (rng, tk) => `<kbd>${tk()}</kbd>` },
  { id: 'html-br', tags: ['html'], make: (rng, tk) => `${tk()}<br>` },
  { id: 'html-span', tags: ['html'], make: (rng, tk) => `<span class="hl">${tk()}</span>` },
  // 公式：`$a * b$` 是「标记相邻」的经典反例
  { id: 'math-inline', tags: ['math'], make: (rng, tk) => `$${tk()}_x^2$` },
  { id: 'math-adjacent', tags: ['math', 'adjacent'], make: (rng) => '价格 $5 和 $6' },
  { id: 'math-star', tags: ['math', 'adjacent'], make: (rng, tk) => `$a * b ${tk()}$` },
  // 转义与实体
  { id: 'escape', tags: ['escape'], make: (rng, tk) => `\\*${tk()}\\* \\_x\\_` },
  { id: 'entity', tags: ['entity'], make: (rng, tk) => `&amp;${tk()}&#39;&copy;` },
  // Unicode 与空白
  { id: 'cjk-punct', tags: ['unicode'], make: (rng, tk) => `${tk()}中文，标点。「引号」` },
  { id: 'emoji', tags: ['unicode'], make: (rng, tk) => `${tk()}😀🎉` },
  { id: 'emoji-zwj', tags: ['unicode'], make: (rng, tk) => `${tk()}👨‍👩‍👧‍👦🏳️‍🌈` },
  { id: 'combining', tags: ['unicode'], make: (rng, tk) => `${tk()}e\u0301a\u0300` },
  { id: 'rtl', tags: ['unicode'], make: (rng, tk) => `${tk()}مرحبا שלום` },
  { id: 'bidi-mix', tags: ['unicode'], make: (rng, tk) => `${tk()}عربي English 中文` },
  { id: 'zero-width', tags: ['unicode'], make: (rng, tk) => `${tk()}\u200bzw\u200b` },
  { id: 'nbsp', tags: ['unicode'], make: (rng, tk) => `${tk()}\u00a0nb\u00a0sp` },
  { id: 'long-word', tags: ['stress'], make: (rng, tk) => `${tk()}${'x'.repeat(300)}` }
]

const INLINE_IDS = INLINE.map((c) => c.id)

// ─── 块级构造 ────────────────────────────────────────────────────────────────
// 返回一段块级 Markdown（不含首尾空行）。`struct` 是这段**应该**产生的结构计数，
// 由生成器汇总成「预期结构」，套件再拿 ProseMirror 文档的真实结构去比（I5）。
const BLOCKS = [
  {
    id: 'paragraph',
    tags: ['paragraph'],
    make: (rng, tk, inline) => `${tk()}${inline(rng, int(rng, 0, 3))}段落。`
  },
  {
    id: 'paragraph-soft-break',
    tags: ['paragraph', 'soft-break'],
    make: (rng, tk, inline) => `${tk()}软换行第一行\n第二行${inline(rng, 1)}`
  },
  {
    id: 'paragraph-hard-break-backslash',
    tags: ['paragraph', 'hard-break'],
    make: (rng, tk) => `${tk()}硬换行一\\\n硬换行二`
  },
  {
    id: 'paragraph-hard-break-spaces',
    tags: ['paragraph', 'hard-break'],
    make: (rng, tk) => `${tk()}硬换行三  \n硬换行四`
  },
  {
    id: 'heading-atx',
    tags: ['heading'],
    struct: { headings: 1 },
    make: (rng, tk) => `${'#'.repeat(int(rng, 1, 6))} ${tk()}标题`
  },
  {
    id: 'heading-atx-closed',
    tags: ['heading'],
    struct: { headings: 1 },
    make: (rng, tk) => `## ${tk()}闭合标题 ##`
  },
  {
    id: 'heading-atx-empty',
    tags: ['heading'],
    struct: { headings: 1 },
    make: (rng) => '#'
  },
  {
    id: 'heading-setext',
    tags: ['heading', 'setext'],
    struct: { headings: 1 },
    make: (rng, tk) => `${tk()}Setext\n${pick(rng, ['===', '---'])}`
  },
  { id: 'hr-dash', tags: ['hr'], struct: { hr: 1 }, make: () => '---' },
  { id: 'hr-star', tags: ['hr'], struct: { hr: 1 }, make: () => '***' },
  { id: 'hr-underscore', tags: ['hr'], struct: { hr: 1 }, make: () => '___' },
  { id: 'hr-spaced', tags: ['hr'], struct: { hr: 1 }, make: () => '- - -' },
  {
    id: 'quote-simple',
    tags: ['quote'],
    struct: { quotes: 1 },
    make: (rng, tk, inline) => `> ${tk()}引用${inline(rng, 1)}`
  },
  {
    id: 'quote-nested',
    tags: ['quote'],
    struct: { quotes: 2 },
    make: (rng, tk) => `> ${tk()}外层\n>\n> > 内层引用`
  },
  {
    id: 'quote-lazy',
    tags: ['quote', 'lazy'],
    struct: { quotes: 1 },
    make: (rng, tk) => `> ${tk()}引用第一行\n懒续行（没有 >）`
  },
  {
    id: 'quote-with-blocks',
    tags: ['quote', 'heading', 'code'],
    struct: { quotes: 1, headings: 1, codeBlocks: 1 },
    make: (rng, tk) => `> ## ${tk()}引用里的标题\n>\n> \`\`\`js\n> const a = 1\n> \`\`\``
  },
  {
    id: 'fence-backtick',
    tags: ['code'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '```js\nconst ' + tk() + ' = 1\n```'
  },
  { id: 'fence-no-info', tags: ['code'], struct: { codeBlocks: 1 }, make: (rng, tk) => '```\n' + tk() + '\n```' },
  {
    id: 'fence-tilde',
    tags: ['code'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '~~~python\n' + `# ${tk()}` + '\n~~~'
  },
  {
    id: 'fence-contains-backticks',
    tags: ['code', 'nested'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '````\n' + tk() + '\n```\ninner\n```\n````'
  },
  { id: 'fence-empty', tags: ['code'], struct: { codeBlocks: 1 }, make: () => '```\n```' },
  {
    id: 'fence-trailing-blank',
    tags: ['code', 'boundary'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '```\n' + tk() + '\n\n```'
  },
  {
    id: 'fence-unclosed',
    tags: ['code', 'malformed'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '```\n' + tk() + ' 未闭合围栏'
  },
  {
    id: 'indented-code',
    tags: ['code'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => `    ${tk()}缩进代码\n    second`
  },
  { id: 'list-ul-dash', tags: ['list'], struct: { listItems: 2 }, make: (rng, tk) => `- ${tk()}甲\n- 乙` },
  { id: 'list-ul-star', tags: ['list'], struct: { listItems: 2 }, make: (rng, tk) => `* ${tk()}甲\n* 乙` },
  { id: 'list-ul-plus', tags: ['list'], struct: { listItems: 2 }, make: (rng, tk) => `+ ${tk()}甲\n+ 乙` },
  {
    id: 'list-ul-loose',
    tags: ['list', 'loose'],
    struct: { listItems: 2 },
    make: (rng, tk) => `- ${tk()}甲\n\n- 乙`
  },
  {
    id: 'list-ul-nested',
    tags: ['list', 'nested'],
    struct: { listItems: 3 },
    make: (rng, tk) => `- ${tk()}一级\n  - 二级\n    - 三级`
  },
  {
    id: 'list-ol-dot',
    tags: ['list', 'ordered'],
    struct: { listItems: 3 },
    make: (rng, tk) => `1. ${tk()}一\n2. 二\n3. 三`
  },
  {
    id: 'list-ol-paren',
    tags: ['list', 'ordered'],
    struct: { listItems: 2 },
    make: (rng, tk) => `1) ${tk()}一\n2) 二`
  },
  {
    id: 'list-ol-start',
    tags: ['list', 'ordered', 'boundary'],
    struct: { listItems: 2 },
    make: (rng, tk) => `5. ${tk()}从五开始\n6. 六`
  },
  {
    id: 'list-ol-out-of-order',
    tags: ['list', 'ordered', 'boundary'],
    struct: { listItems: 2 },
    make: (rng, tk) => `1. ${tk()}一\n\n5. 五`
  },
  {
    id: 'list-adjacent-same-marker',
    tags: ['list', 'adjacent'],
    struct: { listItems: 2 },
    make: (rng, tk) => `- ${tk()}上\n\n- 下`
  },
  {
    id: 'list-adjacent-diff-marker',
    tags: ['list', 'adjacent'],
    struct: { listItems: 2 },
    make: (rng, tk) => `- ${tk()}上\n\n* 下`
  },
  {
    id: 'task-list',
    tags: ['task-list'],
    struct: { listItems: 2, taskItems: 2 },
    make: (rng, tk) => `- [ ] ${tk()}待办\n- [x] 已完成`
  },
  {
    id: 'task-list-ordered',
    tags: ['task-list', 'ordered'],
    struct: { listItems: 2, taskItems: 2 },
    make: (rng, tk) => `1. [ ] ${tk()}待办\n2. [x] 已完成`
  },
  {
    id: 'table-align',
    tags: ['table'],
    struct: { tables: 1 },
    make: (rng, tk) => `| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| ${tk()}a | b | c |`
  },
  {
    id: 'table-escaped-pipe',
    tags: ['table', 'escape'],
    struct: { tables: 1 },
    make: (rng, tk) => `| 甲 | 乙 |\n| --- | --- |\n| 转义 \\| 竖线 | ${tk()} |`
  },
  {
    id: 'table-inline-code',
    tags: ['table', 'code'],
    struct: { tables: 1, inlineCode: 1 },
    make: (rng, tk) => `| 头 |\n| --- |\n| \`${tk()}\` |`
  },
  {
    id: 'table-empty-cells',
    tags: ['table', 'boundary'],
    struct: { tables: 1 },
    make: (rng, tk) => `| a |  | c |\n| --- | --- | --- |\n|  | ${tk()} |  |`
  },
  {
    id: 'html-block-div',
    tags: ['html'],
    struct: { htmlBlocks: 1 },
    make: (rng, tk) => `<div class="block">\n${tk()} 块级 HTML\n</div>`
  },
  { id: 'html-block-comment', tags: ['html'], struct: { htmlBlocks: 1 }, make: (rng, tk) => `<!-- ${tk()} 注释 -->` },
  {
    id: 'html-block-raw',
    tags: ['html'],
    struct: { htmlBlocks: 1 },
    make: (rng, tk) => `<pre>\n  ${tk()} 原样\n</pre>`
  },
  {
    id: 'frontmatter',
    tags: ['frontmatter'],
    struct: { frontmatter: 1 },
    make: (rng, tk) => `---\ntitle: ${tk()}\ntags: [a, b]\n---`
  },
  {
    id: 'frontmatter-fake',
    tags: ['frontmatter', 'boundary'],
    struct: { hr: 1 },
    make: (rng, tk) => `---\n${tk()} 不是 YAML，只是分割线夹文字\n---`
  },
  {
    id: 'math-block-single',
    tags: ['math'],
    struct: { mathBlocks: 1 },
    make: (rng, tk) => `$$${tk()}_x = 1$$`
  },
  {
    id: 'math-block-multi',
    tags: ['math'],
    struct: { mathBlocks: 1 },
    make: (rng, tk) => `$$\n${tk()}_y = 2\n\\int_0^1 x\\,dx\n$$`
  },
  {
    id: 'ref-link',
    tags: ['link', 'reference'],
    struct: { links: 1 },
    make: (rng, tk) => {
      const t = tk()
      return `${t}见 [引用][${t.toLowerCase()}]\n\n[${t.toLowerCase()}]: https://example.com/ref`
    }
  },
  {
    id: 'mermaid',
    tags: ['code', 'mermaid'],
    struct: { codeBlocks: 1 },
    make: (rng, tk) => '```mermaid\ngraph TD\n  A-->B\n```'
  },
  {
    id: 'combined-nested',
    tags: ['list', 'quote', 'code', 'table'],
    struct: { listItems: 1, quotes: 1, codeBlocks: 1 },
    make: (rng, tk) => `- ${tk()}项里放引用\n\n  > 引用里放代码\n  >\n  > \`\`\`\n  > ${tk()}x\n  > \`\`\``
  }
]

const BLOCK_IDS = BLOCKS.map((c) => c.id)

// ─── 文档级变异（保义：行尾 / BOM / 首尾空行）────────────────────────────────
const MUTATIONS = [
  { id: 'eol-lf', tags: ['eol'], apply: (md) => md },
  { id: 'eol-crlf', tags: ['eol'], apply: (md) => md.replace(/\n/g, '\r\n') },
  { id: 'eol-cr', tags: ['eol'], apply: (md) => md.replace(/\n/g, '\r') },
  { id: 'bom', tags: ['bom'], apply: (md) => '\ufeff' + md },
  { id: 'no-final-newline', tags: ['final-newline'], apply: (md) => md.replace(/\n+$/, '') },
  { id: 'extra-final-newline', tags: ['final-newline'], apply: (md) => md + '\n\n\n' },
  { id: 'leading-blank', tags: ['blank'], apply: (md) => '\n' + md },
  { id: 'trailing-blank', tags: ['blank'], apply: (md) => md + '\n' }
]

const MUTATION_IDS = MUTATIONS.map((m) => m.id)

/** 汇总结构计数（构造声明的 delta 之和） */
function emptyStruct() {
  return {
    headings: 0,
    codeBlocks: 0,
    tables: 0,
    mathBlocks: 0,
    htmlBlocks: 0,
    images: 0,
    links: 0,
    hr: 0,
    quotes: 0,
    listItems: 0,
    taskItems: 0,
    inlineCode: 0,
    frontmatter: 0
  }
}

function addStruct(target, delta) {
  if (!delta) return
  for (const k of Object.keys(delta)) target[k] = (target[k] ?? 0) + delta[k]
}

/**
 * 生成一篇文档。
 * @param {number} seed 语料种子
 * @param {number} index 文档序号（只依赖 seed+index，见文件头）
 * @param {{maxBlocks?: number, maxInline?: number, allowMutations?: boolean}} [opts]
 * @returns {{id:string, seed:number, md:string, tags:string[], tokens:string[], struct:object, mutations:string[]}}
 */
function generateDoc(seed, index, opts = {}) {
  const maxBlocks = opts.maxBlocks ?? 6
  const maxInline = opts.maxInline ?? 3
  const rng = rngFor(seed, index)
  let tokenSeq = 0
  const tokens = []
  const tk = () => {
    tokenSeq += 1
    const t = `ZQ${index}X${tokenSeq}`
    tokens.push(t)
    return t
  }
  /** 随机行内片段串（每条自带哨兵词），刻意允许「相邻无空格」——标记相邻正是缺陷高发区 */
  const inline = (r, n) => {
    let out = ''
    for (let i = 0; i < n; i++) {
      const c = pick(r, INLINE)
      out += chance(r, 0.4) ? c.make(r, tk) : ' ' + c.make(r, tk)
    }
    return out
  }

  const tags = []
  const struct = emptyStruct()
  const parts = []
  const n = int(rng, 1, maxBlocks)
  for (let i = 0; i < n; i++) {
    const c = pick(rng, BLOCKS)
    parts.push(c.make(rng, tk, inline))
    tags.push(c.id, ...(c.tags ?? []))
    addStruct(struct, c.struct)
  }

  // 上下文包裹：整篇塞进引用里（真实文档里很常见，且会连带改变所有标记的缩进语义）
  let body = parts.join(pick(rng, ['\n\n', '\n\n', '\n\n', '\n', '\n\n\n']))
  // 兜底：整篇都是「没有可见文本」的构造（空标题、空围栏、分割线…）时补一段带哨兵词的正文，
  // 否则 I7（渲染面完整性）对这篇是空验
  if (tokens.length === 0) {
    body = `${tk()}兜底正文\n\n${body}`
    tags.push('fallback-paragraph')
  }
  if (chance(rng, 0.15)) {
    body = body
      .split('\n')
      .map((l) => (l === '' ? '>' : '> ' + l))
      .join('\n')
    struct.quotes += 1
    tags.push('wrapped-in-quote')
  }

  const mutations = []
  if (opts.allowMutations !== false) {
    for (const m of MUTATIONS) {
      if (chance(rng, m.id.startsWith('eol') ? 0.34 : 0.08)) {
        body = m.apply(body)
        mutations.push(m.id)
        tags.push(...m.tags)
      }
    }
  }
  if (!body.endsWith('\n')) body += '\n'

  return {
    id: `doc-${index}`,
    seed,
    md: body,
    tags: [...new Set(tags)],
    tokens,
    struct,
    mutations
  }
}

/**
 * 生成一份语料。
 * @param {{seed?:number, count?:number, maxBlocks?:number, maxInline?:number, allowMutations?:boolean}} [opts]
 */
function generateCorpus(opts = {}) {
  const seed = opts.seed ?? 20260916
  const count = opts.count ?? 200
  const out = []
  for (let i = 0; i < count; i++) out.push(generateDoc(seed, i, opts))
  return out
}

module.exports = {
  mulberry32,
  rngFor,
  generateDoc,
  generateCorpus,
  BLOCKS,
  INLINE,
  MUTATIONS,
  BLOCK_IDS,
  INLINE_IDS,
  MUTATION_IDS,
  emptyStruct,
  addStruct
}
