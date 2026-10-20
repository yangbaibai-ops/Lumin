// ─── 插入块级结构（公式 / Mermaid）───────────────────────────────────────────
//
// 为什么单独成模块：右键菜单、应用菜单、快捷键三条入口都要走**同一份**插入逻辑。
// 直接把 ProseMirror 事务写在 actions.ts 里，会让"菜单能插、快捷键插得不一样"这种
// 漂移无从对照；纯函数式（只依赖 Editor）也便于在别处复用。
//
// 两个动作都只产出一个事务 ⇒ Ctrl+Z 一次撤销。

import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { topLevelBlockAt } from './paragraphAround'
import { openMathEditor } from './mathPreview'

/**
 * 在当前**顶层块**上方插入一个空公式块并打开编辑态。
 *
 * 为什么插在顶层块之前（而不是任意选区处）：公式块是原子块级节点，塞进表格单元格 /
 * 列表项里在 Markdown 上没有对应写法；`paragraphAround.ts` 的顶层兄弟口径已经在
 * 「插入段落」上验证过，这里沿用同一套。
 */
export function insertBlockMath(editor: Editor): boolean {
  const { state } = editor
  const nodeType = state.schema.nodes.mathBlock
  if (!nodeType) return false
  const block = topLevelBlockAt(state.doc, state.selection.from)
  if (!block) return false
  const node = nodeType.create({ source: '' })
  const pos = block.pos
  const tr = state.tr.insert(pos, node)
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)))
  } catch {
    /* 选区映射失败不影响插入 */
  }
  editor.view.dispatch(tr)
  // 插入已完成，这一步只改视图（打开源码框），不产生第二个文档事务
  openMathEditor(editor.view, {
    kind: 'block',
    from: pos,
    to: pos + node.nodeSize,
    innerFrom: pos,
    innerTo: pos + node.nodeSize,
    tex: ''
  })
  return true
}

/**
 * 在当前选区插入一个 `language=mermaid` 的代码块（带一句可运行的骨架）。
 *
 * 走 Tiptap 的 `insertContent`：在段落中间插入时由它自己切段，在空段落里则原地替换，
 * 与粘贴/输入规则的落点一致。骨架用 ASCII（`graph TD`），不引入需要翻译的界面文案。
 */
export function insertMermaidBlock(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .insertContent({
      type: 'codeBlock',
      attrs: { language: 'mermaid' },
      content: [{ type: 'text', text: 'graph TD\n  A --> B' }]
    })
    .run()
}
