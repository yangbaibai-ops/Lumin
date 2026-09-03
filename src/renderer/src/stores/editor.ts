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
        // 每次事务都刷新大纲（保证跳转位置新鲜），内部做差异跳过，
        // 标题集合不变时只原位更新 pos，不重建数组、不触发列表重渲染
        this.refreshOutline()
      })
      editor.on('selectionUpdate', () => {
        this.tick++
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
      // 标题集合（层级+文本序列）未变化：只原位更新 pos，保持数组引用与
      // Vue :key 稳定——避免代码块等上方内容编辑时大纲整列进出动画（闪烁）
      const same =
        this.outline.length === items.length &&
        this.outline.every((o, i) => o.level === items[i].level && o.text === items[i].text)
      if (same) {
        for (let i = 0; i < items.length; i++) {
          if (this.outline[i].pos !== items[i].pos) this.outline[i].pos = items[i].pos
        }
        return
      }
      this.outline = items
    },
    jumpToHeading(pos: number): void {
      const editor = this.instance
      if (!editor) return
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run()
    }
  }
})
