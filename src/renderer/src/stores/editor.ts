import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Author } from '../lib/contentSync'
import { scrollContainerTo, smoothScrollToElement } from '../lib/editor/smoothScroll'

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
     * 下一次序列化回 files 时该记谁写的（手册 §4.59 的账本作者）。
     *
     * 为什么需要它：正文里嵌着**子编辑面**（代码块的 CodeMirror）。它的输入先写回
     * Tiptap 节点、再由 Tiptap 序列化成 md，于是「谁是作者」在序列化的那一刻已经看不出来了
     * （序列化是 250ms 防抖的，写回动作早就结束了）。所以子编辑面在写回节点时**挂个牌**，
     * `files.setContent(md, 取牌())` 时消费掉：作者是 codeblock ⇒ Tiptap 面板不会被回灌
     * （它的文档本来就是最新的，回灌会把光标从代码块里踢出去），源码 textarea 照常跟着更新。
     * 默认（没挂牌）= `wysiwyg`：正文输入都来自 Tiptap 自己。
     */
    writeIntent: null as Author | null,
    tick: 0,
    outline: [] as OutlineItem[],
    activeHeading: -1
  }),
  actions: {
    bind(editor: Editor): void {
      // markRaw：编辑器实例不参与 Vue 深度响应式（性能与兼容性）
      this.editor = markRaw(editor)
      editor.on('transaction', ({ transaction }) => {
        this.tick++
        // 大纲只在**文档真的变了**时重算（第二十五轮轻量化）：`refreshOutline` 要遍历整篇
        // 文本块，而事务里绝大多数是纯选区变化（每次点/移动光标都会来一发）。
        // 标题的 pos 在纯选区事务里不可能变，跳过是安全的。
        if (transaction.docChanged) this.refreshOutline()
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
    /** 子编辑面（代码块 CodeMirror / 源码 textarea）声明：接下来这次序列化是它写的 */
    noteWrite(surface: Author): void {
      this.writeIntent = surface
    },
    /** 序列化已落进 files store：清掉写者标记与脏标记（消费即失效，避免下次正文输入被误记） */
    markFlushed(): void {
      this.writeIntent = null
      this.dirty = false
    },
    /** 取走写者标记并收敛状态（默认 `wysiwyg`：正文输入都来自 Tiptap 自己） */
    consumeWriteIntent(): Author {
      const who = this.writeIntent ?? 'wysiwyg'
      this.markFlushed()
      return who
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
    /**
     * 点击目录/大纲条目 → 光标落到对应标题，并且**平滑滚过去**（不是瞬时跳转）。
     *
     * 为什么不能直接用 ProseMirror 的 `.scrollIntoView()`：它一步写死 `scrollTop`，
     * 视觉上就是「啪」地跳。这里改成：先只移动光标，然后把 focus 引起的瞬时滚动
     * 复位，最后对滚动容器做 smooth 滚动。系统开启「减少动态效果」时退化为瞬时。
     *
     * 坑（实测抓到过）：Tiptap 的 `focus()` 默认 `scrollIntoView: true`，它会在
     * **requestAnimationFrame 里**补一次 `scrollIntoView`（瞬时滚动）。如果我们的平滑
     * 动画同步启动，那一帧的瞬时滚动会把它打断，肉眼就是「跳过去」而不是滑过去。
     * 所以：(1) 关掉 focus 的 scrollIntoView；(2) 平滑滚动排到下一帧执行。
     */
    jumpToHeading(pos: number): void {
      const editor = this.instance ?? this.editor
      if (!editor || !this.active) return
      const view = editor.view
      const container = view.dom.closest('.editor-scroll') as HTMLElement | null
      const before = container?.scrollTop ?? 0
      editor.chain().focus(null, { scrollIntoView: false }).setTextSelection(pos).run()
      if (!container) return
      // focus + 选区变化可能让浏览器把光标瞬时滚进视口：原样复位后再平滑滚动
      scrollContainerTo(container, before, 'instant')
      const at = view.domAtPos(pos)
      const target =
        (at.node.nodeType === Node.TEXT_NODE ? at.node.parentElement : (at.node as HTMLElement)) ??
        null
      if (!target) return
      // 下一帧再滚：排在 Tiptap 排队的那次 focus 之后，避免动画被它打断
      // （页面不可见时 rAF 不会触发，此时直接瞬时定位，免得回前台才莫名滚动）
      if (document.hidden) smoothScrollToElement(container, target)
      else requestAnimationFrame(() => smoothScrollToElement(container, target))
    }
  }
})
