import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { Editor } from '@tiptap/core'

// ─── 编辑器实例桥接（解耦：工具栏 / 大纲 / 导出等通过此 store 与内核通信）──
// 持久化模型：编辑器在 EditorView 里常驻挂载（模式切换只改布局，不再 v-if
// 卸载重建）。因此 bind/unbind 跟随「文件」生命周期（:key=path 重建），而
// 「当前模式是否激活编辑器」（wysiwyg/split 激活、source 隐藏）由 setActive
// 驱动——源码模式下 instance 保持 null（与旧架构编辑器被卸载时的语义一致：
// 工具栏富文本命令失活、大纲清空），避免对用户不可见的隐藏编辑器发命令。
export interface OutlineItem {
  level: number
  text: string
  pos: number
}

export const useEditorStore = defineStore('editor', {
  state: () => ({
    /** 常驻编辑器实例（markRaw，不参与深度响应式）；文件切换时随组件重建 */
    editor: null as Editor | null,
    /** 对外暴露的「激活」实例：wysiwyg/split 时=editor，source 时=null */
    instance: null as Editor | null,
    /** 是否处于编辑器激活模式（非 source） */
    active: true,
    /** 编辑器文档是否含尚未序列化回 files 的用户输入（onUpdate 置位，flush 后清除） */
    dirty: false,
    /**
     * 编辑器文档内容最近一次与 files.content 对齐时的 md（编辑面 emit /
     * 显式 setContent / flushWysiwyg 后更新）。源码模式逐键编辑时编辑器是
     * 隐藏副本，此值保持旧内容 —— 切回编辑器视图时据此判断是否需要一次性同步。
     */
    syncedMd: '',
    tick: 0,
    outline: [] as OutlineItem[],
    activeHeading: -1
  }),
  actions: {
    bind(editor: Editor): void {
      // markRaw：编辑器实例不参与 Vue 深度响应式（性能与兼容性）
      this.editor = markRaw(editor)
      editor.on('transaction', () => {
        this.tick++
        // 每次事务都刷新大纲（保证跳转位置新鲜），内部做差异跳过，
        // 标题集合不变时只原位更新 pos，不重建数组、不触发列表重渲染
        this.refreshOutline()
      })
      editor.on('selectionUpdate', () => {
        this.tick++
      })
      this.applyActive()
    },
    unbind(): void {
      this.editor = null
      this.instance = null
      this.outline = []
      this.activeHeading = -1
    },
    /** 模式驱动：编辑器视图激活 ⇔ instance=editor；源码模式 ⇔ instance=null */
    setActive(active: boolean): void {
      this.active = active
      this.applyActive()
    },
    /** 编辑器文档有了新的用户输入（序列化管道待触发） */
    markDirty(): void {
      this.dirty = true
    },
    /** 记录编辑器文档 == 该 md（编辑面 emit / 显式同步 / flushWysiwyg 后调用） */
    markSynced(md: string): void {
      this.syncedMd = md
      this.dirty = false
    },
    applyActive(): void {
      if (this.active && this.editor) {
        this.instance = this.editor
        this.refreshOutline()
      } else {
        this.instance = null
        this.outline = []
        this.activeHeading = -1
      }
    },
    refreshOutline(): void {
      const editor = this.instance ?? this.editor
      if (!editor || !this.active) return
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
      const editor = this.instance ?? this.editor
      if (!editor || !this.active) return
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run()
    }
  }
})
