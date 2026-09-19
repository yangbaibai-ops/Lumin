// ─── 在当前文档里找匹配（返回 ProseMirror 文档位置）───────────────────────────
//
// 与源码面不同，WYSIWYG 面要搜的是**文档**：一段文字可能被拆成多个文本节点
// （不同 mark、行内 HTML 原件），所以块内先把文本片段拼起来、再做匹配，
// 位置再映射回文档坐标（见 lib/findReplace.ts 的 runsToText / findInRuns）。
//
// 只做「块内」匹配：跨段落/标题/列表项的匹配语义（段落之间的换行算不算一个字符、
// 要不要跨过空行）在各渲染器下不一致 —— 与其猜，不如不跨。
import type { Node as PMNode } from '@tiptap/pm/model'
import { findInRuns, type FindOptions, type Match, type TextRun } from '../findReplace'

/** 文档里全部匹配（文档坐标，按出现顺序） */
export function findInDoc(doc: PMNode, query: string, opts: FindOptions = {}): Match[] {
  if (!query) return []
  const out: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const runs: TextRun[] = []
    node.forEach((child, offset) => {
      // 非文本行内节点（图片、行内 HTML 原件）不参与文本匹配；
      // 它的长度由 offset 自然跳过，不会让后续位置算偏
      if (child.isText && child.text) runs.push({ from: pos + 1 + offset, text: child.text })
    })
    out.push(...findInRuns(runs, query, opts))
    return false // 块内已处理，不再往下走
  })
  return out
}
