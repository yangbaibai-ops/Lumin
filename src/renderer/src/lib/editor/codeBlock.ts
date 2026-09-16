// ─── 代码块增强扩展：CodeMirror 6 NodeView（开发文档「步骤 3」）──────────────
// 在 ProseMirror AST 节点内无缝嵌入 CodeMirror：语法高亮、行号、历史记录、
// 语言下拉切换；language === 'mermaid' 时渲染为图表（点击可编辑源码）。
import CodeBlock from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockView from '../../components/editor/CodeBlockView.vue'
import { codeFenceFor } from '../../../../shared/documentText'

/** tiptap-markdown 序列化状态/节点的最小结构化声明（包未导出这些类型） */
interface CodeFenceStateLike {
  write(text: string): void
  text(text: string, escape: boolean): void
  ensureNewLine(): void
  closeBlock(node: unknown): void
}
interface CodeFenceNodeLike {
  attrs: Record<string, unknown>
  textContent: string
}

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

  /**
   * 围栏长度按内容自适应：内容里出现连续反引号（例如文档在教怎么写 Markdown）时，
   * 固定写三个反引号会让围栏被内容里的 ``` 提前闭合——**后面的正文会被解析成代码**，
   * 属于内容损坏。见 shared/documentText.ts 的 codeFenceFor。
   */
  addStorage() {
    return {
      markdown: {
        serialize(state: CodeFenceStateLike, node: CodeFenceNodeLike) {
          const content = node.textContent
          const fence = codeFenceFor(content)
          state.write(fence + String(node.attrs.language ?? '') + '\n')
          state.text(content, false)
          state.ensureNewLine()
          // 内容以换行结尾（用户在块尾敲过回车）时，收尾围栏前必须**多留一个空行**：
          // CommonMark 里围栏前那个换行是「最后一行的行终止符」，不算内容 ——
          // 直接写 `a\n` + 围栏，重新解析后内容变成 `a`，**块尾的空行被吃掉**
          // （表现：在代码块末尾按回车、保存、重开，少一行）。多写一个换行才等价。
          if (content.endsWith('\n')) state.write('\n')
          state.write(fence)
          state.closeBlock(node)
        }
      }
    }
  },

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
