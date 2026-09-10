import type { Editor } from '@tiptap/core'
import type { EditorMenuContext, TableInfo } from './types'

/**
 * ─── 上下文识别 ──────────────────────────────────────────────────────────────
 * 只读地扫描当前选区的祖先链，得出「用户在什么场景下右键」。
 * 新增识别场景（数学块、脚注、批注、引用块嵌套…）时，在这里加字段并在
 * providers 里加一个 when/build 即可，菜单本体无需改动。
 */

/** 读取光标所在表格的规格与位置（不在表格内返回 null） */
function readTableInfo(editor: Editor): TableInfo | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name !== 'table') continue
    const rowIndex = $from.index(depth)
    const row = node.child(rowIndex)
    return {
      rows: node.childCount,
      cols: row.childCount,
      rowIndex,
      colIndex: $from.index(depth + 1)
    }
  }
  return null
}

/** 从选区起点向上找最近的标题级别 */
function readHeadingLevel(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'heading') return Number(node.attrs.level) || 1
  }
  return null
}

export function readEditorMenuContext(editor: Editor): EditorMenuContext {
  const { selection } = editor.state
  return {
    editor,
    hasSelection: !selection.empty,
    inTable: editor.isActive('table'),
    inList: editor.isActive('listItem'),
    inTaskList: editor.isActive('taskList'),
    inBlockquote: editor.isActive('blockquote'),
    inCodeBlock: editor.isActive('codeBlock'),
    headingLevel: readHeadingLevel(editor),
    table: readTableInfo(editor)
  }
}
