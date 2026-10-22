// ─── 软换行（CommonMark softbreak）往返：保住用户原文的行结构 ──────────────────
//
// 背景（审计 P2「5MB 保存把软换行合并」）：Markdown 里段内单个换行是**软换行**
// （CommonMark 语义 ≡ 一个空格），markdown-it 默认把它渲染成 `\n` 文本；经过
// HTML→ProseMirror 的空白折叠后，原文的换行信息就丢了，`getMarkdown()` / 保存
// 只能把整段重新折成一行。一份 20,000 行的文档因此会被合并成几千行 —— 用户什么
// 都没改，git diff 却是整篇。
//
// 做法：给 `hardBreak` 节点加一个 `soft` 属性，把 **softbreak 渲染成
// `<br data-lumin-softbreak="1">`**（而不是空白），解析回来就是 `soft=true` 的
// hardBreak；序列化时 soft 写 `\n`、真硬换行仍写 `\\\n`。于是：
//   * 行结构（行数）原样保住；
//   * 语义不变：软换行在 CommonMark 里仍是软换行（写回的是单个 `\n`，不是 `\`）；
//   * 编辑器里软换行显示为换行（与源码行一致），这是"保住版式"的可见代价。
//
// 为什么不直接开 markdown-it 的 `breaks: true`：那会把 softbreak 变成真 hardBreak，
// 序列化写回 `\`，每一行都被塞一个反斜杠（见 extensions.ts 里原来那段说明）。
import HardBreak from '@tiptap/extension-hard-break'
import { writeBreakNode } from './softBreakSerialize'
import type { BreakSerializerParent, BreakSerializerState } from './softBreakSerialize'

/** 解析/渲染软换行用的标记属性（只在编辑器 DOM 里出现，不落 Markdown） */
export const SOFT_BREAK_ATTR = 'data-lumin-softbreak'

/**
 * 带 `soft` 属性的 hardBreak。
 *
 * `addStorage().markdown.serialize` 覆盖 tiptap-markdown 内置实现（它只认 "\\\n"）：
 *   * 末尾连续的 hardBreak 不写（与上游一致，否则段落尾会多一个空行）；
 *   * 表格单元格里写 `<br>`（与 tableMarkdown.ts 的既有口径一致：单元格内的换行
 *     只能靠 HTML 表达）；
 *   * 其余情况：soft → `\n`，硬换行 → `\\\n`。
 */
export const SoftBreakHardBreak = HardBreak.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      soft: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute(SOFT_BREAK_ATTR),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.soft ? { [SOFT_BREAK_ATTR]: '1' } : {}
      }
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: BreakSerializerState,
          node: { attrs?: { soft?: boolean }; type: unknown },
          parent: BreakSerializerParent,
          index: number
        ) {
          writeBreakNode(state, node, parent, index)
        },
        parse: {
          // tiptap-markdown 每次 parse 前都会调用各扩展的 parse.setup（见其 MarkdownParser）
          setup(md: { renderer: { rules: Record<string, unknown> } }) {
            md.renderer.rules.softbreak = () => `<br ${SOFT_BREAK_ATTR}="1">`
          }
        }
      }
    }
  }
})
