// ─── YAML front matter 识别（纯函数，可单测）────────────────────────────────
//
// 为什么要有它：front matter 在真实写作里非常常见（Obsidian / Hugo / Jekyll / VitePress
// 都靠它写 title、tags、date）。而 CommonMark 里它**没有语法地位** —— 一段
//
//   ---
//   title: 我的文章
//   ---
//
// 会被解析成「主题分割线 + 段落 + 主题分割线」。于是编辑器一打开就把它拆了：
// YAML 变成一行正文、还多出一堆 `---`，等于**静默破坏文件的元数据**（Wave 1 的 lossy 缺口）。
//
// 判定规则（保守优先，宁可不认也不误吃）：
//   1. 必须从**文档第一个字符**开始（`---` 前面不能有任何内容）；
//   2. 收尾分隔符必须是独立的 `---` 或 `...` 行；
//   3. 块内至少有一行顶层 `key:` —— 这一条是拿来做**排除**的：CommonMark 里
//      `---\ntext\n---`（分割线夹一段文字）是合法且常见的写法，没有键值就不能当 YAML 吃掉。
//
// 返回的 `raw` **包含**两个分隔符行、不含收尾换行 —— 原样写回是这条链路的全部意义。

/** 一段被识别出来的 front matter */
export interface FrontmatterBlock {
  /** 原文（含首尾 `---` 行，不含收尾换行；块内的 CRLF 原样保留） */
  raw: string
  /** 块之后第一行的 0 基行号（markdown-it 的 block 规则靠它推进 `state.line`） */
  nextLine: number
}

/** 首行分隔符：`---` 后只允许空白（容忍 CRLF 文档行尾残留的 \r） */
const OPEN_RE = /^---[ \t]*\r?$/
/** 收尾分隔符：`---` 或 `...` */
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*\r?$/
/** 顶层键：`key:`（YAML 的顶层键允许字母数字与 _ - .） */
const KEY_RE = /^[A-Za-z0-9_.-]+[ \t]*:/

/**
 * 从文档文本里识别开头的 front matter 块。
 * 不是 front matter（或不符合上面的保守规则）时返回 `null`。
 */
export function extractFrontmatter(text: string): FrontmatterBlock | null {
  if (!text.startsWith('---')) return null
  // 逐行扫描：只在行边界上判定，避免正则回溯吃掉正文里的 `---`
  const lines = text.split('\n')
  if (!OPEN_RE.test(lines[0] ?? '')) return null
  let close = -1
  let hasKey = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (CLOSE_RE.test(line)) {
      close = i
      break
    }
    if (KEY_RE.test(line)) hasKey = true
  }
  if (close < 0 || !hasKey) return null
  const nextLine = close + 1
  // 收尾行末尾的 `\r` 属于「行尾」而不是内容：raw 不含块后的换行，所以也要去掉它
  const raw = lines.slice(0, nextLine).join('\n').replace(/\r$/, '')
  return { raw, nextLine }
}

/** 文本是否以 front matter 开头（判定同上，供「这里能不能插入」之类的地方用） */
export function hasFrontmatter(text: string): boolean {
  return extractFrontmatter(text) !== null
}
