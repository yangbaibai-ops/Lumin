import type { Editor } from '@tiptap/core'

/** tiptap-markdown 的存储类型（包未做全局类型增强，这里做类型桥接） */
export function getMarkdown(ed: Editor): string {
  try {
    const storage = ed.storage as unknown as { markdown?: { getMarkdown(): string } }
    return storage.markdown?.getMarkdown() ?? ''
  } catch {
    return ''
  }
}
