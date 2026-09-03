// ─── 代码块增强扩展：CodeMirror 6 NodeView（开发文档「步骤 3」）──────────────
// 在 ProseMirror AST 节点内无缝嵌入 CodeMirror：语法高亮、行号、历史记录、
// 语言下拉切换；language === 'mermaid' 时渲染为图表（点击可编辑源码）。
import CodeBlock from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockView from '../../components/editor/CodeBlockView.vue'

// CM 编辑器区域内的事件全部由 CM 自理：PM 的 eventBelongsToView 检查到
// stopEvent 为真时直接忽略（尤其是 click 处理器——它无条件 view.focus()
// 并把 DOM 选区重置到 PM 状态选区，是把光标从代码块抢回标题位置的元凶）。
// 仅拦截 .cm-editor 内部目标：代码块头部（语言下拉）的点击仍归 PM，
// 保持「点击代码块选中节点」的原生行为。
const CM_EVENTS = new Set([
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'keypress',
  'input',
  'beforeinput',
  'cut',
  'copy',
  'paste',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'touchstart',
  'touchmove',
  'touchend'
])

export const CodeBlockCM = CodeBlock.extend({
  name: 'codeBlock',

  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView, {
      // CodeMirror 内容区由 CM 自行维护，PM 的 DOMObserver 不应介入
      // 内部 DOM 变更（避免把 CM 内的选区变化误读为 PM 选区）
      ignoreMutation: () => true,
      stopEvent: ({ event }) => {
        const target = event.target as HTMLElement | null
        return !!target && !!target.closest('.cm-editor') && CM_EVENTS.has(event.type)
      }
    })
  }
})
