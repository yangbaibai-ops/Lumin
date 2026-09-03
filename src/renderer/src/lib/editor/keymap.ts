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
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

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
        if ($from.parent.type.name !== 'heading') return false
        // 光标在标题第一个字前（含空标题）→ 降级为段落，不并入上一行
        if ($from.parentOffset !== 0) return false
        return editor.chain().focus().setParagraph().run()
      }
    }
  }
})
