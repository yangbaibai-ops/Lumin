// ─── 标题的「纯文本标签」（大纲 / 目录用）────────────────────────────────────
//
// 本编辑器的行内标记是**真实文本**：`**加粗**` 的四个星号就在文档里（带 `mdMarker` mark，
// 见 lib/editor/typoraInlineMarks.ts）。所以 `node.textContent` 拿到的是
// `林一鸣（**男主，21岁**）` —— 直接拿去做大纲/目录的行文字，用户就会看到一串 `**`
//（用户报障：`### 林一鸣（**男主，21岁，大四或刚毕业待业**）` 在目录里带着 `**`）。
//
// 这里用 **mark 名**过滤，而不是用正则剥字符：
//   * 正则剥 `*` 会把正文里本来就该显示的字面星号（转义过的 `\*`）一起吃掉；
//   * 标记文本是带 `mdMarker` mark 的节点，语义精确 —— 只有它才是「语法字符」。
//
// 硬换行（`<br>`）折算成一个空格：它是「两行标题」的视觉换行，在大纲里连成一行更好读。
import type { Node as PMNode } from '@tiptap/pm/model'

/** 标记文本的 mark 名（与 typoraInlineMarks.ts 里的 `name: 'mdMarker'` 保持一致） */
const MARKER_MARK = 'mdMarker'

/** 取标题节点的纯文本（跳过所有 `mdMarker` 文本）；全空时回落到 fallback */
export function headingPlainText(node: PMNode, fallback = '（无标题）'): string {
  let text = ''
  node.descendants((child) => {
    if (child.isText) {
      if (!child.marks.some((m) => m.type.name === MARKER_MARK)) text += child.text ?? ''
    } else if (child.type.name === 'hardBreak') {
      text += ' '
    }
    return true
  })
  const trimmed = text.trim()
  return trimmed || fallback
}
