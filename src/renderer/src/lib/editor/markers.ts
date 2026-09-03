// ─── Typora 光标感知块级标记符（ProseMirror Decoration）─────────────────────
// 块级标记（标题/引用/列表项）由 CSS ::before 生成，不进入文档内容；
// 行内标记（加粗/斜体等）已升级为真实文本模型（typoraInlineMarks.ts），
// 标记字符本身在文档中，可选中、可编辑，本文件不再管理行内元素。
//
// 实现要点（本版 prosemirror-view 的实测行为）：
// - Decoration.node 使用相对 doc.content 的 0 基坐标
//   （DecorationSet.create/buildTree 以 content.findIndex 校验），增删均正常。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const pluginKey = new PluginKey('typora-dynamic-syntax')

function buildBlockDecorations(state: import('@tiptap/pm/state').EditorState): DecorationSet {
  const { selection, doc } = state
  const selFrom = selection.from
  const selTo = selection.to
  const decos: Decoration[] = []

  doc.descendants((node, pos, parent) => {
    switch (node.type.name) {
      case 'heading': {
        // 光标在标题内 → 显示级别提示（H1~H6，见 style.css）
        if (selFrom >= pos && selTo <= pos + node.nodeSize) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-reveal' }))
        }
        return
      }
      case 'blockquote': {
        // 光标在引用内 → 显示 > 标记
        if (selFrom >= pos && selTo <= pos + node.nodeSize) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-reveal' }))
        }
        return
      }
      case 'listItem': {
        // 无序列表项：光标在项内 → 圆点换为 '- ' 标记（有序列表保留数字）
        if (parent?.type.name === 'bulletList' && selFrom >= pos && selTo <= pos + node.nodeSize) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-reveal' }))
        }
        return
      }
      default:
        return
    }
  })

  return DecorationSet.create(doc, decos)
}

export const typoraMarkersPlugin = new Plugin({
  key: pluginKey,
  state: {
    init: (_config, state) => buildBlockDecorations(state),
    apply: (tr, oldSet, _oldState, newState) => {
      if (tr.docChanged || tr.selectionSet) return buildBlockDecorations(newState)
      return oldSet
    }
  },
  props: {
    decorations(state) {
      return this.getState(state)
    }
  }
})

/** 包装为 Tiptap Extension（与扩展集统一注册） */
export const TyporaMarkers = Extension.create({
  name: 'typoraMarkers',
  addProseMirrorPlugins() {
    return [typoraMarkersPlugin]
  }
})
