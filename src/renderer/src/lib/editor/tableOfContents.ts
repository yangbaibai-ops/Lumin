// ─── 目录（Table of Contents）节点 ──────────────────────────────────────────
// 工具栏「目录」在当前光标处插入一个目录块：实时列出文档各级标题，
// 点击条目跳转到对应标题（与大纲侧边栏共用 outline/jumpToHeading）。
// Markdown 往返：序列化为独立的 `[TOC]` 行；加载时把独立 `[TOC]` 段
// 经 markdown 解析器的 updateDOM 钩子转成 <div data-toc> 再解析回本节点。
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import TocNodeView from '../../components/editor/TocNodeView.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableOfContents: {
      /** 在光标处插入目录 */
      insertTableOfContents: () => ReturnType
    }
  }
}

export const TableOfContents = Node.create({
  name: 'tableOfContents',

  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-toc]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toc': 'true' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(TocNodeView)
  },

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name })
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write('[TOC]')
          state.closeBlock(node)
        },
        parse: {
          // markdown-it 把 `[TOC]` 渲染成 <p>[TOC]</p>，这里在解析前转成
          // <div data-toc>，使 parseHTML 能命中本节点
          updateDOM(element) {
            element.querySelectorAll('p').forEach((p) => {
              if (p.textContent?.trim() === '[TOC]') {
                const div = element.ownerDocument.createElement('div')
                div.setAttribute('data-toc', 'true')
                p.replaceWith(div)
              }
            })
          }
        }
      }
    }
  }
})
