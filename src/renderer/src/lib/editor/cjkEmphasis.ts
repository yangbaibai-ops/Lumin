// ─── CJK 强调定界符（flanking）口径的 markdown-it 接线 ─────────────────────────
//
// 纯判定逻辑（`isCjkPunctCode` / `scanDelimsCjk`）在 inlineMarkerCore.ts（有单测钉死），
// 本文件只做两件事：
//   1. 把 markdown-it 的 **emphasis 分词规则**换成「用我们的 scanDelims」；
//   2. 通过 `parse.setup` 钩子注册（与 MdEscape 的 escape 规则、MdMarker 的冗余嵌套
//      渲染规则同一套机制）——**加载/刷新**（setContent → parser.parse）与**实时编辑**
//      （「源码权威重推」→ storage.markdown.parser.parse）因此共用同一条规则。
//
// 为什么必须改 markdown-it 这一层（详见 inlineMarkerCore.ts 的 CJK 口径注释）：
//   `押在了**「保存路径」与「Markdown 保真」**这两件` 这类中文写法，在标准 CommonMark
//   flanking 判定下开/闭定界符都不成立（`「`/`」` 算标点），整段渲染成字面星号；
//   而本编辑器内部的「手打标记识别」又把它当合法配对 ⇒ **同一段文字在不同上下文里
//   渲染不一致**（单独一行是加粗、放进长段落变字面星号）。修在 markdown-it 上，
//   两边就只剩一条规则。
//
// 上游对应实现：`markdown-it/lib/rules_inline/emphasis.mjs`（tokenize）+
// `state_inline.mjs`（scanDelims）。这里只换 scanDelims，**postProcess / balance_pairs
// 仍然用上游的**（`ruler2` 里的 emphasis 规则照旧跑），所以「`**2****2**` 是一个 strong」
// 那类 CommonMark 规则（rule of 3）一个都没动。
import { Extension } from '@tiptap/core'
import type { MarkdownItLike } from './markdownTypes'
import { scanDelimsCjk } from './inlineMarkerCore'
import type { DelimUtils } from './inlineMarkerCore'

/** markdown-it 行内状态（只用到这几个成员） */
interface MdInlineState {
  src: string
  pos: number
  posMax: number
  tokens: unknown[]
  delimiters: {
    marker: number
    length: number
    token: number
    end: number
    open: boolean
    close: boolean
  }[]
  md: { utils: DelimUtils }
  push(type: string, tag: string, nesting: number): { content: string }
}

interface MdWithInline extends MarkdownItLike {
  __luminCjkEmphasis?: boolean
  utils?: DelimUtils
  inline?: { ruler: { at(name: string, fn: unknown): void } }
}

/**
 * 上游 `emphasis_tokenize` 的同构实现（只把 `state.scanDelims` 换成 `scanDelimsCjk`）。
 *
 * `silent` 时 return false 与上游一致：验证模式（`skipToken`）不消费强调字符。
 * 注意 `canSplitWord = marker === 0x2A`（`*` 可以出现在词中，`_` 不行）——CJK 口径
 * 只对 `*` 生效，就是靠这个参数传给 scanDelimsCjk。
 */
function emphasisTokenizeCjk(state: MdInlineState, silent: boolean): boolean {
  const start = state.pos
  const marker = state.src.charCodeAt(start)
  if (silent) return false
  if (marker !== 0x5f /* _ */ && marker !== 0x2a /* * */) return false

  const scanned = scanDelimsCjk(state.src, state.pos, state.posMax, marker === 0x2a, state.md.utils)

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

/**
 * 把 CJK 口径接到 markdown-it 上（幂等：`parse.setup` 每次解析前都会被调用）。
 * 解析器实例缺失/结构不符时静默跳过（解析器不可用是既有兜底路径）。
 */
export function patchCjkEmphasis(md: unknown): void {
  const m = md as MdWithInline
  if (!m?.inline?.ruler || !m.utils) return
  if (m.__luminCjkEmphasis) return
  m.__luminCjkEmphasis = true
  m.inline.ruler.at('emphasis', emphasisTokenizeCjk)
}

/** 注册钩子（`parse.setup` 是 tiptap-markdown 给各扩展改 markdown-it 的官方入口） */
export const CjkEmphasis = Extension.create({
  name: 'cjkEmphasis',
  addStorage() {
    return { markdown: { parse: { setup: (md: unknown) => patchCjkEmphasis(md) } } }
  }
})
