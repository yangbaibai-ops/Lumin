import type { Editor } from '@tiptap/core'
import { withFinalNewline } from '../../../../shared/documentText'

/**
 * 取编辑器内容的 Markdown 表示。
 *
 * **这是「编辑器内容 → 文档文本」的唯一出口**：TyporaEditor 的落盘（flushSync）、
 * 外部同步比较、源码模式切换都从这里取，所以文档级的收尾规则也放这里 ——
 * 否则「谁先谁后」不一致会直接变成 setContent 回滚（光标重置、快速输入丢字，见 §4.11）。
 *
 * 规则见 shared/documentText.ts（非空文档以且仅以一个换行结尾）。
 */
export function getMarkdown(ed: Editor): string {
  try {
    const storage = ed.storage as unknown as { markdown?: { getMarkdown(): string } }
    return withFinalNewline(storage.markdown?.getMarkdown() ?? '')
  } catch {
    return ''
  }
}
