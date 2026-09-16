/**
 * ─── 搜索片段的「命中分段」──────────────────────────────────────────────────
 * 主进程用 SQLite FTS5 的 `snippet()` 取片段，命中词用 **U+0001 / U+0002** 两个控制字符包起来
 * （见 main/services/database.ts 的 search：`snippet(..., char(1), char(2), …)`）。
 *
 * 为什么不是让它返回 `<em>` 再 `v-html`：片段是**数据**，不该夹着 HTML 穿过 IPC —— 那样渲染层
 * 必须「先转义再放行自己写的标签」，一旦少转义一处就是 XSS（文档正文是用户可控内容）。
 * 现在数据里只有两个不可能出现在正文里的控制字符，渲染层把它切成「命中 / 非命中」两种文本段，
 * 由 Vue 自己渲染 `<em class="gs-hl">` —— **全程没有 v-html，也就没有转义遗漏的机会**。
 *
 * 纯函数、有单测：`tests/highlight.test.mjs`。
 */
export interface SnippetSegment {
  /** 该段的纯文本（渲染时由 Vue 转义） */
  text: string
  /** 是否命中高亮 */
  hit: boolean
}

/** FTS5 snippet 的命中标记（必须与 main/services/database.ts 的 char(1)/char(2) 一致） */
const HIT_START = '\u0001'
const HIT_END = '\u0002'

export function highlightSegments(raw: string): SnippetSegment[] {
  const segments: SnippetSegment[] = []
  let hit = false
  let buf = ''
  for (const ch of raw) {
    if (ch === HIT_START) {
      if (buf) segments.push({ text: buf, hit })
      buf = ''
      hit = true
    } else if (ch === HIT_END) {
      if (buf) segments.push({ text: buf, hit })
      buf = ''
      hit = false
    } else {
      buf += ch
    }
  }
  if (buf) segments.push({ text: buf, hit })
  return segments
}
