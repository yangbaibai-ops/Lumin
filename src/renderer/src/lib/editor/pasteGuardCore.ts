// ─── 粘贴规模护栏（纯判据，可单测）──────────────────────────────────────────────
//
// 用户报障（原话）：「从思源笔记复制了一些不算多的内容到应用内，应用直接卡死了」。
//
// 实测真因（不是"文本多"，而是"结构重 + 内联 base64 大"）：
//   * 思源复制出来的 HTML 里，**图片是几十 KB ~ 几 MB 的 data URI**，一张截图就能让
//     HTML 到十几 MB；而我们的编辑器**原样把它当 `image` 节点的 src 收进文档**，
//     于是"2 KB 正文"变成 "20 MB 文档"；
//   * 文档一大，**每次落盘/同步都要把整篇序列化成 Markdown**（`getMarkdown`），
//     而 `prosemirror-markdown` 的 `atBlank()` 在每次 `write` 都把累积输出正则扫一遍
//     ⇒ 序列化是超线性的（实测 3.4MB=25ms、6.9MB=122ms、10.3MB=345ms、13.8MB=635ms、
//     17.2MB=1077ms、20.6MB=1589ms；profile 里 `atBlank` 占 70%+）；
//   * 粘贴本身还要把整段 HTML 解析 **两遍**（`MathPaste.rewriteMathHtml` 一遍、
//     `htmlSlice`/PM 一遍）—— 20 MB 时约 0.4~0.5 s 的主线程同步占用。
// 所以护栏必须做在**"HTML 进 schema 之前"**：超预算的 data URI 不内联（换成可见占位）、
// 结构过深/元素过多/体积过大时降级成纯文本，再不行就整次拒绝（文档一个字节都不动）。
//
// 本文件只做**纯判据**（不 import ProseMirror / tiptap），便于单测直接加载：
//   * `scanPastedHtml()` —— 一次线性扫描拿到体积 / 元素数 / 最大深度 / data URI 预算；
//   * `decidePaste()`    —— 判定 allow / degrade / fallback-text / reject；
//   * `shouldRollback()` —— 超时看门狗的纯判据（超时且文档变了才回滚）。
//
// 阈值的选择依据（都是"远大于真实粘贴、但远小于能卡死主线程"）：
//   * 单张 data URI 8 MB：普通截图 base64 一般 < 2 MB；8 MB 已是一张很大的图；
//   * 一次粘贴内联合计 12 MB：再多就必然会把文档推到序列化超线性的区间；
//   * 硬上限（单张 16 MB / 合计 32 MB / HTML 24 M 字符）⇒ 整次拒绝，文档保持不变；
//   * 元素 30000 / 深度 200 ⇒ 降级纯文本（再深的结构对用户也没有阅读价值，
//     而深层嵌套在解析器里是递归成本）。
export const PASTE_SOFT_SINGLE_IMAGE_BYTES = 8 * 1024 * 1024
export const PASTE_SOFT_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
export const PASTE_HARD_SINGLE_IMAGE_BYTES = 16 * 1024 * 1024
export const PASTE_HARD_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024
export const PASTE_HARD_HTML_CHARS = 24 * 1024 * 1024
export const PASTE_MAX_ELEMENTS = 30_000
export const PASTE_MAX_DEPTH = 200
/** 降级成纯文本时最多保留的字符数（超出截断，并在提示里说明） */
export const PASTE_FALLBACK_TEXT_CHARS = 512 * 1024
/** 超时看门狗：粘贴处理超过这个时长 ⇒ 回滚这次粘贴 */
export const PASTE_WATCHDOG_MS = 1500

/** 空元素（不参与深度累加） */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** 一个标签：`<` 或 `</` + 名字 + 属性（属性里允许出现 `>`？不允许 —— 那属于畸形 HTML） */
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g

/** 一张内联图片（`<img src="data:…">`）在 HTML 里的位置与字节数 */
export interface InlineImageRange {
  /** 整个 `<img …>` 标签在 html 里的起点（含） */
  from: number
  /** 终点（不含） */
  to: number
  /** data URI 的字符数（base64 文本长度） */
  bytes: number
}

/** 一次粘贴 HTML 的规模画像 */
export interface PasteScan {
  /** HTML 字符数 */
  chars: number
  /** 元素数（开始 + 结束标签都算，粗略但单调） */
  elements: number
  /** 最大嵌套深度 */
  maxDepth: number
  /** 内联图片总数 */
  images: InlineImageRange[]
  /** 内联图片 data URI 的合计字符数 */
  imageBytes: number
  /** 单张最大的 data URI 字符数 */
  maxImageBytes: number
}

/**
 * 解析 `src="data:…"` 的字节数（取标签属性里的 data URI 长度；没有则 0）。
 * 只做字符串查找，不做 base64 解码 —— 大字符串解码正是要避免的主线程成本。
 */
export function dataUriBytesOfTag(tag: string): number {
  const m = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
  if (!m) return 0
  const src = m[2] ?? m[3] ?? m[4] ?? ''
  return /^data:/i.test(src) ? src.length : 0
}

/**
 * 线性扫描粘贴 HTML：体积、元素数、最大深度、内联 data URI 预算。
 *
 * 为什么不用 `DOMParser`：**扫描本身必须是便宜的**。对 20 MB 的 HTML 建 DOM 要几百毫秒，
 * 那就等于在护栏里再造一次卡顿。字符串扫描在 20 MB 上是个位数毫秒。
 * 代价是"元素数/深度"是**按标签文本**统计的（注释/文本里的 `<` 可能多算）——
 * 这只会在极端结构上多触发一次降级，方向是安全的。
 */
export function scanPastedHtml(html: string): PasteScan {
  const chars = html.length
  let elements = 0
  let depth = 0
  let maxDepth = 0
  const images: InlineImageRange[] = []
  let imageBytes = 0
  let maxImageBytes = 0

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(html)) !== null) {
    elements += 1
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    if (closing) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (name === 'img') {
      const bytes = dataUriBytesOfTag(m[0])
      if (bytes > 0) {
        images.push({ from: m.index, to: TAG_RE.lastIndex, bytes })
        imageBytes += bytes
        if (bytes > maxImageBytes) maxImageBytes = bytes
      }
    }
    // 自闭合（`<img … />`）与空元素不增加深度
    if (VOID_TAGS.has(name)) continue
    if (/\/\s*>$/.test(m[0])) continue
    depth += 1
    if (depth > maxDepth) maxDepth = depth
  }
  return { chars, elements, maxDepth, images, imageBytes, maxImageBytes }
}

/** 降级时给用户看的占位文案（由调用方注入，内核不认识具体语言 —— 与其它模块同口径） */
export interface PasteGuardLabels {
  /** 被省略的一张图：参数是 MB 数（保留 1 位小数） */
  omittedImage: (mb: string) => string
}

/** 判定结果 */
export type PasteDecision =
  | { kind: 'allow'; scan: PasteScan }
  | {
      kind: 'degrade'
      scan: PasteScan
      /** 去掉超预算 data URI 之后的 HTML（被省略的图换成可见占位） */
      html: string
      omittedImages: number
      omittedBytes: number
    }
  | {
      kind: 'fallback-text'
      scan: PasteScan
      /** 降级成纯文本（可能截断） */
      text: string
      truncated: boolean
      reason: 'too-big' | 'too-deep' | 'too-many-elements'
    }
  | {
      kind: 'reject'
      scan: PasteScan
      reason: 'single-image' | 'total-images' | 'too-big'
    }

/** MB 文案：`2.4`（不本地化小数点，三种语言的数字写法一致） */
function mbText(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

/**
 * 把超预算的 `<img src="data:…">` 换成**可见占位**（普通行内文本），返回新 HTML。
 *
 * 取舍：占位而不是直接删掉 —— 用户必须**看得见**"这里少了一张图、大概多大"，
 * 否则就是静默丢内容（约束里明确不允许）。替换只动这些标签，其余字节原样保留。
 */
export function omitOversizedInlineImages(
  html: string,
  scan: PasteScan,
  labels: PasteGuardLabels,
  limits: { single?: number; total?: number } = {}
): { html: string; omitted: number; omittedBytes: number } {
  const softSingle = limits.single ?? PASTE_SOFT_SINGLE_IMAGE_BYTES
  const softTotal = limits.total ?? PASTE_SOFT_TOTAL_IMAGE_BYTES
  if (!scan.images.length) return { html, omitted: 0, omittedBytes: 0 }
  const drop = new Set<InlineImageRange>()
  let keptBytes = 0
  let omittedBytes = 0
  for (const img of scan.images) {
    const overSingle = img.bytes > softSingle
    const overTotal = keptBytes + img.bytes > softTotal
    if (overSingle || overTotal) {
      drop.add(img)
      omittedBytes += img.bytes
    } else {
      keptBytes += img.bytes
    }
  }
  if (!drop.size) return { html, omitted: 0, omittedBytes: 0 }
  let out = ''
  let cursor = 0
  for (const img of scan.images) {
    if (!drop.has(img)) continue
    out += html.slice(cursor, img.from)
    out += `<span data-lumin-paste-omitted="1">${labels.omittedImage(mbText(img.bytes))}</span>`
    cursor = img.to
  }
  out += html.slice(cursor)
  return { html: out, omitted: drop.size, omittedBytes }
}

/** 纯文本兜底：优先剪贴板里的 text/plain；没有就把 HTML 标签剥掉 */
export function plainTextFallback(
  html: string,
  text: string
): { text: string; truncated: boolean } {
  const raw = text && text.trim() ? text : html.replace(/<[^>]*>/g, ' ')
  const oneLine = raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (oneLine.length <= PASTE_FALLBACK_TEXT_CHARS) return { text: oneLine, truncated: false }
  return { text: oneLine.slice(0, PASTE_FALLBACK_TEXT_CHARS), truncated: true }
}

/**
 * 核心判定（纯函数）。
 *
 * 顺序刻意写死：**先救内容、再降级、最后才拒绝** ——
 *   1. 体积/结构越界 ⇒ 纯文本（内容还在，只是丢掉富文本结构）；
 *   2. 内联图片超预算 ⇒ 省略图片 + 可见占位（正文/表格/公式全都还在）；
 *   3. 超过硬上限 ⇒ 整次拒绝（文档保持原样），并明确告诉用户。
 */
export function decidePaste(
  input: { html: string; text: string },
  labels: PasteGuardLabels
): PasteDecision {
  const { html, text } = input
  if (!html) return { kind: 'allow', scan: scanPastedHtml('') }
  const scan = scanPastedHtml(html)

  /**
   * 顺序：**超大内联图先拒绝**（文档一个字节都不动，这正是"20MB base64 夹具"的验收口径），
   * 再谈结构与体积的降级。否则 36MB 的 HTML 会先撞"体积降级"而不是"拒绝"。
   */
  if (scan.maxImageBytes > PASTE_HARD_SINGLE_IMAGE_BYTES)
    return { kind: 'reject', scan, reason: 'single-image' }
  if (scan.imageBytes > PASTE_HARD_TOTAL_IMAGE_BYTES)
    return { kind: 'reject', scan, reason: 'total-images' }

  const tooBig = scan.chars > PASTE_HARD_HTML_CHARS
  const tooDeep = scan.maxDepth > PASTE_MAX_DEPTH
  const tooMany = scan.elements > PASTE_MAX_ELEMENTS
  if (tooBig || tooDeep || tooMany) {
    const fallback = plainTextFallback(html, text)
    return {
      kind: 'fallback-text',
      scan,
      text: fallback.text,
      truncated: fallback.truncated,
      reason: tooBig ? 'too-big' : tooDeep ? 'too-deep' : 'too-many-elements'
    }
  }

  if (
    scan.maxImageBytes > PASTE_SOFT_SINGLE_IMAGE_BYTES ||
    scan.imageBytes > PASTE_SOFT_TOTAL_IMAGE_BYTES
  ) {
    const stripped = omitOversizedInlineImages(html, scan, labels)
    if (stripped.omitted > 0) {
      return {
        kind: 'degrade',
        scan,
        html: stripped.html,
        omittedImages: stripped.omitted,
        omittedBytes: stripped.omittedBytes
      }
    }
  }
  return { kind: 'allow', scan }
}

/**
 * 超时看门狗判据：**耗时超过预算且文档确实变了**才回滚。
 * 纯函数，便于单测（`tests/pasteGuard.test.mjs`）。
 */
export function shouldRollback(
  elapsedMs: number,
  docChanged: boolean,
  budgetMs: number = PASTE_WATCHDOG_MS
): boolean {
  return docChanged && Number.isFinite(elapsedMs) && elapsedMs > budgetMs
}
