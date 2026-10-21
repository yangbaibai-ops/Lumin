// ─── 从 Tiptap / ProseMirror 取「选区 Markdown」────────────────────────────────
//
// 为什么不是 `doc.textBetween()`：那会丢掉 `**`/`#`/列表标记等 Markdown 结构，
// 而「润色，保持 Markdown 结构」这条默认指令要求模型看到的是**源码形态**。
// 这里把 `state.doc.cut(from, to)` 包成一个临时 doc 交给同一个 MarkdownSerializer
// （与 `getMarkdown(ed)` 用的序列化器是同一个实例），拿到的就是选区对应的 Markdown。
//
// 边界：选区正好切在列表项/表格中间时，序列化器输出的是"这一段"的 Markdown；
// 序列化失败（极端脏数据）时退回 textBetween，保证功能不因此不可用。
import type { Editor } from '@tiptap/core'

export interface AiSelection {
  from: number
  to: number
  /** 选区对应的 Markdown（已去尾部空白） */
  text: string
}

interface MarkdownSerializerLike {
  serialize(node: unknown): string
}

export function readSelectionMarkdown(ed: Editor): AiSelection | null {
  const { from, to, empty } = ed.state.selection
  if (empty || to <= from) return null
  let text = ''
  try {
    const storage = ed.storage as unknown as {
      markdown?: { serializer?: MarkdownSerializerLike }
    }
    const serializer = storage.markdown?.serializer
    if (serializer) {
      const slice = ed.state.doc.cut(from, to)
      const topNodeType = ed.schema.topNodeType
      const doc = topNodeType.create(null, slice.content)
      text = serializer.serialize(doc)
    }
  } catch {
    text = ''
  }
  if (!text.trim()) {
    try {
      text = ed.state.doc.textBetween(from, to, '\n', '\n')
    } catch {
      text = ''
    }
  }
  return { from, to, text: text.replace(/\s+$/, '') }
}
