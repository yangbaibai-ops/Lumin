// ─── 把 AI 回答（Markdown）插入文档：**一个事务** ───────────────────────────────
//
// 为什么不用 `chain().insertContent(markdown)` 或 `insertText(markdown)`：
//   * 本项目装了 tiptap-markdown，它**覆盖了 `insertContentAt`**（`insertContent` 内部
//     委托到它）—— 传进去的 HTML 会被当成 **Markdown 源码**再解析一遍，于是整段
//     `<h2>…</h2><p>…</p>` 变成 `HtmlBlock` 原子节点（WYSIWYG 里看到一坨标签）。
//     本轮验收实际踩到过。
//   * `tr.insertText(markdown)` 则会把 `##`/`-`/围栏当字面量塞进段落，不是"以 Markdown 插入"。
//
// 正解：复用 tiptap-markdown 的 parser 把 Markdown 转成 HTML，再走
// **`view.pasteHTML(html)`** —— 它直接用 schema 的 DOMParser 建 Slice 并
// `replaceSelection`，**一次事务**（Ctrl+Z 一步还原），也绕开了 Markdown 扩展的覆盖。
// parser 缺失/抛错时退回 `tr.insertText`（同样只 dispatch 一次）。
//
// 依赖注入到结构类型（而不是 import Editor 的运行时）：单测可以用一个假 editor
// 数插入次数，证明"只提交一次"。
import type { Editor } from '@tiptap/core'

interface MarkdownParserLike {
  parse(text: string): string
}

interface TransactionLike {
  insertText(text: string, from: number): unknown
}

export interface MarkdownInsertEditor {
  storage?: unknown
  state: {
    selection: { from: number }
    tr: TransactionLike
  }
  view: {
    pasteHTML(html: string): void
    dispatch(tr: unknown): void
  }
  commands: { focus(): unknown }
}

function parserOf(ed: MarkdownInsertEditor): MarkdownParserLike | null {
  try {
    const storage = ed.storage as { markdown?: { parser?: MarkdownParserLike } } | undefined
    return storage?.markdown?.parser ?? null
  } catch {
    return null
  }
}

/**
 * 在**当前光标处**插入一段 Markdown（单事务）。
 *
 * @returns 是否真的写入了文档（空文本时 false）
 */
export function insertMarkdownAtCursor(
  ed: Editor | MarkdownInsertEditor,
  markdown: string
): boolean {
  const text = String(markdown ?? '').trim()
  if (!text) return false
  const target = ed as MarkdownInsertEditor
  try {
    target.commands.focus()
  } catch {
    /* 焦点失败不影响插入；pasteHTML 用的是当前 selection */
  }
  const parser = parserOf(target)
  let html = ''
  if (parser) {
    try {
      html = parser.parse(text)
    } catch {
      html = ''
    }
  }
  if (html) {
    try {
      target.view.pasteHTML(html)
      return true
    } catch {
      /* 解析出的 HTML 被 schema 拒绝时走纯文本兜底 */
    }
  }
  const pos = target.state.selection.from
  target.view.dispatch(target.state.tr.insertText(text, pos))
  return true
}
