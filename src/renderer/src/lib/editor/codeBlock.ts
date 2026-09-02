// ─── 代码块增强扩展：CodeMirror 6 NodeView（开发文档「步骤 3」）──────────────
// 在 ProseMirror AST 节点内无缝嵌入 CodeMirror：语法高亮、行号、历史记录、
// 语言下拉切换；language === 'mermaid' 时渲染为图表（点击可编辑源码）。
import CodeBlock from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockView from '../../components/editor/CodeBlockView.vue'

export const CodeBlockCM = CodeBlock.extend({
  name: 'codeBlock',

  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView)
  }
})
