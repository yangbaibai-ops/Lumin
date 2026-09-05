// ─── Typora 式键盘语义 ───────────────────────────────────────────────────────
// 1) 分割线：'---' / '***' 独立成行后按 Enter 才转换（Typora 同款）。
//    即时转换（输入规则）被禁用，因此 "---你好" 这类文本可以正常输入；
// 2) 标题降级：光标位于标题第一个字前按 Backspace → 取消标题格式
//    （整行降级为段落，内容保留），而不是并入上一行 / 影响上一行层级。
// 3) 行内语法标记内回车：光标落在 `**`/`*` 等标记字符中间（如 `**s*|*`）
//    时，先把光标移到整个样式构造之后再切段——避免把标记文本切成两半
//    （派生归一化会把截断误判为「删星改样式」，甚至抛出异常）。
//
// 优先级说明：本扩展 priority 200，高于 Tiptap core keymap（默认 100），
// 保证 Enter/Backspace 的拦截先于 splitBlock / joinBackward 执行；
// 条件不匹配时 handler 返回 false，交还后续 keymap 处理。
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'

/** 段间 join（Backspace/Delete 用）：把光标前后的两个同型段落合并。
    dir 'backward'：光标在段首/段间边界 → 并入上一段；
    dir 'forward' ：光标在段尾/段间边界 → 并入下一段。
    覆盖两类光标位置：① 落在文本块内部首/尾字符处；② 落在块间边界
    （depth 0，Enter 与归一化常把光标留在此）。成功后事务的选区映射会把
    光标停在拼接处。 */
function joinTextblockAtBoundary(editor: Editor, dir: 'backward' | 'forward'): boolean {
  const { state } = editor
  const doc = state.doc
  const sel = state.selection
  if (!sel.empty) return false
  const $from = sel.$from
  const caretPos = sel.from

  // 确定“边界位置”：backward 取当前/下一块起点；forward 取当前块终点
  let boundary = -1
  if ($from.parent.type.name === 'paragraph') {
    if (dir === 'backward' && $from.parentOffset === 0) boundary = $from.before()
    if (dir === 'forward' && $from.parentOffset === $from.parent.content.size) boundary = $from.after()
  }
  if (boundary < 0 && $from.depth === 0 && caretPos > 0 && caretPos < doc.content.size) {
    // 块间边界光标：可能正好在某块起点或终点
    boundary = caretPos
  }
  if (boundary <= 0 || boundary >= doc.content.size) return false

  const before = doc.childBefore(boundary).node
  const after = doc.childAfter(boundary).node
  if (!before || !after) return false
  if (before.type.name !== 'paragraph' || after.type.name !== 'paragraph') return false
  if (!canJoin(doc, boundary)) return false
  const tr = state.tr
  tr.join(boundary)
  // 光标停在两段拼接缝：合并后文本块从 (boundary - before.nodeSize) 开始，
  // 其内容 = before.content + after.content，缝 = 起点 + 1 + before.content.size
  const mergedStart = boundary - before.nodeSize
  const seam = mergedStart + 1 + before.content.size
  const merged = tr.doc.nodeAt(mergedStart)
  const max = mergedStart + 1 + (merged ? merged.content.size : 0)
  try {
    tr.setSelection(TextSelection.create(tr.doc, Math.min(Math.max(seam, mergedStart + 1), max)))
  } catch {
    /* 保持事务映射结果 */
  }
  editor.view.dispatch(tr)
  return true
}

export const TyporaKeymap = Extension.create({
  name: 'typoraKeymap',
  priority: 200,

  addKeyboardShortcuts() {
    const schema = this.editor.schema
    const hrType = schema.nodes.horizontalRule
    const pType = schema.nodes.paragraph

    return {
      Enter: ({ editor }) => {
        // 注意：光标落在语法标记字符内部（如 '**5*|*'）时按回车 = 普通
        // 文本切段（`**5*` / `*`）。派生归一化对不成对构造按字面量处理，
        // 不再自动改写样式，也不会崩溃（详见 typoraInlineMarks.ts）。
        if (!hrType || !pType) return false
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty) return false
        const parent = $from.parent
        // 只处理纯文本段落：整段内容为 ---/***（可带尾随空格）且光标在段尾
        if (parent.type !== pType) return false
        const text = parent.textContent
        if ($from.parentOffset !== text.length) return false
        if (!/^(-{3,}|\*{3,})\s*$/.test(text)) return false

        // 显式事务：整段替换为 [分割线, 新空段落]，光标落新段落。
        // 替换目标是同层合法结构（叶子 + 空段落），replaceWith 走
        // ReplaceStep 的常规路径（与列表类型互转的深度不匹配场景不同）。
        const { tr } = state
        const pos = $from.before()
        const hr = hrType.create()
        const p = pType.create()
        tr.replaceWith(pos, pos + parent.nodeSize, Fragment.fromArray([hr, p]))
        tr.setSelection(TextSelection.create(tr.doc, pos + hr.nodeSize + 1))
        editor.view.dispatch(tr)
        return true
      },

      Backspace: ({ editor }) => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty) return false

        // 标题行首退格 → 降级为段落（既有语义，不并入上一行）
        if ($from.parent.type.name === 'heading') {
          if ($from.parentOffset !== 0) return false
          return editor.chain().focus().setParagraph().run()
        }

        // 段落行首 / 段间边界退格 = 与上一段合并（Typora 行为）。
        // 本版 prosemirror-commands 的 joinBackward 要求光标真正落在文本块
        // 内部（$cursor 非空）；而本编辑器的 Enter/归一化常把光标留在「块
        // 边界」位置（depth 0，解析不进任何段落），joinBackward 直接失效并
        // 落到 selectNodeBackward → 上一段变成 NodeSelection（紫色框整选）。
        // 这里显式 join 相邻同型文本块，光标经事务映射停在拼接处，再由派生
        // 归一化（字面量配对重提升）即时还原成样式，且永不出现段级整选。
        if (joinTextblockAtBoundary(editor, 'backward')) return true
        return false
      },
      Delete: ({ editor }) => {
        // 对称：段落行尾 / 段间边界前删 = 与下一段合并（同样绕过 PM 的
        // selectNodeForward 段级整选路径）
        if (!editor.state.selection.empty) return false
        return joinTextblockAtBoundary(editor, 'forward')
      }
    }
  }
})
