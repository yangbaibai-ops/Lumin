// ─── Typora 光标感知标记符（ProseMirror Decoration + DOM 管理）────────────────
// 依据开发文档「步骤 4」：光标进入节点时展开显示 Markdown 语法标记（# / > / ** / - ），
// 移出时隐藏、只保留渲染样式。标记符全部由 CSS ::before/::after 生成，不进入文档内容。
//
// 实现要点（本版 prosemirror-view 的实测行为）：
// - 块级标记（标题/引用/列表项）：Decoration.node 使用相对 doc.content 的 0 基坐标，
//   （DecorationSet.create/buildTree 以 content.findIndex 校验），增删均正常。
// - 行内标记（加粗/斜体/删除线/行内代码）：Decoration.inline 移除时本版 PM 会在
//   patchOuterDeco 中遗留孤儿 span（patchAttributes 对文本节点失效），导致标记符
//   无法隐藏；改用 props.update 直接在样式元素上增删类名，与 PM 渲染互不干扰。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const pluginKey = new PluginKey('typora-dynamic-syntax')

/** 支持标记符显隐的行内 Mark 元素（CSS 直接作用于这些元素） */
const INLINE_SELECTOR = 'strong, em, s, code'

function buildBlockDecorations(state: import('@tiptap/pm/state').EditorState): DecorationSet {
  const { selection, doc } = state
  const selFrom = selection.from
  const selTo = selection.to
  const decos: Decoration[] = []

  doc.descendants((node, pos, parent) => {
    switch (node.type.name) {
      case 'heading': {
        // 光标在标题内 → 显示 # 标记
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

/** 行内样式：选区与样式元素相交时直接增删 md-reveal-inline 类名 */
function syncInlineMarkers(view: import('@tiptap/pm/view').EditorView): void {
  const { selection } = view.state
  const selFrom = selection.from
  const selTo = selection.to
  for (const el of view.dom.querySelectorAll<HTMLElement>(INLINE_SELECTOR)) {
    // 行内代码块内的 code 元素属于代码块 NodeView，跳过
    if (el.closest('.code-block-wrapper')) continue
    let start = -1
    let end = -1
    try {
      start = view.posAtDOM(el, 0)
      end = start + (el.textContent?.length ?? 0)
    } catch {
      continue
    }
    // 覆盖判定：光标在文本内（不含右边界，与 Typora「刚离开即隐藏」一致）
    const covered = selFrom < end && selTo > start
    if (covered) {
      if (!el.classList.contains('md-reveal-inline')) el.classList.add('md-reveal-inline')
    } else {
      el.classList.remove('md-reveal-inline')
    }
  }
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
  view() {
    // 本版 PM 的 EditorProps 没有 update 钩子，用 PluginView.update 同步行内标记
    return {
      update(view, prevState) {
        if (
          !view.state.selection.eq(prevState.selection) ||
          !view.state.doc.eq(prevState.doc)
        ) {
          syncInlineMarkers(view)
        }
      }
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
