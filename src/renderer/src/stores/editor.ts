import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { Editor } from '@tiptap/core'

// ─── 编辑器实例桥接（解耦：工具栏 / 大纲 / 导出等通过此 store 与内核通信）──
export interface OutlineItem {
  level: number
  text: string
  pos: number
}

export const useEditorStore = defineStore('editor', {
  state: () => ({
    instance: null as Editor | null,
    tick: 0,
    outline: [] as OutlineItem[],
    activeHeading: -1
  }),
  actions: {
    bind(editor: Editor): void {
      // markRaw：编辑器实例不参与 Vue 深度响应式（性能与兼容性）
      this.instance = markRaw(editor)
      this.refreshOutline()
      editor.on('transaction', () => {
        this.tick++
      })
      editor.on('selectionUpdate', () => {
        this.tick++
        this.refreshOutline()
      })
    },
    unbind(): void {
      this.instance = null
      this.outline = []
    },
    refreshOutline(): void {
      const editor = this.instance
      if (!editor) return
      const items: OutlineItem[] = []
      // descendants 的 pos 是 0 基内容坐标，+1 转绝对位置（跳转/滚动定位用）
      editor.state.doc.descendants((node, contentPos) => {
        if (node.type.name === 'heading') {
          items.push({
            level: node.attrs.level as number,
            text: node.textContent || '（无标题）',
            pos: contentPos + 1
          })
        }
        return true
      })
      this.outline = items
    },
    jumpToHeading(pos: number): void {
      const editor = this.instance
      if (!editor) return
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run()
    }
  }
})
