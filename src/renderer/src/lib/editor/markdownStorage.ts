import type { Editor } from '@tiptap/core'
import { escapeMarkerOnlyLines, withFinalNewline } from '../../../../shared/documentText'

/**
 * **原样写回的节点**（HTML 块 / 公式块 / front matter，都是 `attrs.source`）里的每一行：
 * 它们是用户的原文，整行转义规则必须绕开（否则 `****` 这样的一行会被加上反斜杠，
 * 把用户写的内容改掉）。代码块不用管 —— 它的内容在反引号围栏里，转义规则自己会跳过。
 */
function verbatimSourceLines(ed: Editor): string[] {
  const lines: string[] = []
  try {
    ed.state.doc.descendants((n) => {
      const src = n.attrs && typeof n.attrs.source === 'string' ? n.attrs.source : null
      if (src) lines.push(...src.split('\n'))
      return true
    })
  } catch {
    /* 取不到就不保护（上层还有 try/catch 兜底） */
  }
  return lines
}

/**
 * 取编辑器内容的 Markdown 表示。
 *
 * **这是「编辑器内容 → 文档文本」的唯一出口**：TyporaEditor 的落盘（flushSync）、
 * 外部同步比较、源码模式切换都从这里取，所以文档级的收尾规则也放这里 ——
 * 否则「谁先谁后」不一致会直接变成 setContent 回滚（光标重置、快速输入丢字，见 §4.11）。
 *
 * 规则见 shared/documentText.ts（整行标记字符逐字符转义 + 非空文档以且仅以一个换行结尾）。
 */
export function getMarkdown(ed: Editor): string {
  try {
    const storage = ed.storage as unknown as { markdown?: { getMarkdown(): string } }
    const raw = storage.markdown?.getMarkdown() ?? ''
    return withFinalNewline(escapeMarkerOnlyLines(raw, verbatimSourceLines(ed)))
  } catch {
    return ''
  }
}
