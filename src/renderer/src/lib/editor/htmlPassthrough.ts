// ─── 行内 / 块级 HTML 原样保留（Wave 1 缺口：html-inline.md）─────────────────
//
// 问题：Markdown 允许直接嵌 HTML（`<kbd>Ctrl</kbd>`、`<br>`、`<!-- 注释 -->`、
// `<details>`…），而 ProseMirror 的 DOMParser **只认识 schema 里有的节点** ——
// 未知标签一律被剥掉，只剩文字。于是 `<kbd>Ctrl</kbd>` 往返后变成 `Ctrl`，
// 注释整条消失，`<br>` 还被写成 `\`（语义从「HTML 换行」变成「Markdown 硬换行」）。
//
// 解法与反斜杠转义（MdEscape）、front matter 同一套：**在 markdown-it 那一层就认领，
// 让原文以「原样输出」的形态进文档**。
//   1. `parse.setup` 里覆盖 markdown-it 的 `html_inline` / `html_block` 渲染规则：
//      行内的包成 `<span data-md-html>原文</span>`，块级的包成 `<pre data-md-htmlblock>原文</pre>`；
//   2. 行内 → `MdHtml` mark（open/close 为空 + escape:false）→ 序列化**逐字写回**；
//      块级 → `HtmlBlock` 原子节点（原文放在节点属性/文本里）→ 序列化原样写回；
//   3. 两者都不参与行内标记派生（在 toAtoms 里当不透明内容看待），所以 `*`/`_` 这类
//      字符不会被当成 Markdown 语法再解释一遍。
//
// 取舍（写在这里免得以后当成 bug）：
//   * WYSIWYG 里**按源码显示**（`<kbd>Ctrl</kbd>` 就是这几个字符，等宽字体 + 淡色）。
//     把任意 HTML 真渲染出来是另一个功能（要沙箱、要样式隔离），不是保真缺口；
//     而「把标签吃掉」是**静默丢内容**，两害相权取保真。
//   * 块级 HTML 是原子节点：不能在 WYSIWYG 里就地编辑（改它走源码模式），
//     与 front matter 节点同一套语义。
import { Mark, Node } from '@tiptap/core'
// 显式 .ts：本模块要被 tests/markdownRulePatches.test.mjs 直接加载（Node 的 ESM 不做扩展名补全）
import { escapeHtml } from '../utils/html.ts'

/** markdown-it 实例（只用到 renderer.rules） */
interface MdHtmlInstance {
  __luminHtmlRules?: boolean
  renderer?: { rules: Record<string, unknown> }
}

/**
 * 任务列表的复选框是 `markdown-it-task-lists` 插件**生成**的 `html_inline` token
 * （`<input class="task-list-item-checkbox" …>`），不是用户源码里写的 HTML ——
 * 它由 tiptap-markdown 的 TaskItem `updateDOM` 钩子认领后删掉、换成节点的 `checked` 属性。
 * 若把它也当「用户写的行内 HTML」原样保留，任务列表就会变成一堆标签文本（实测踩到：
 * `task-lists.md` 从 exact 掉到 lossy）。所以这类 token 放它原样通过。
 * 判据用插件生成时写死的 class 名，用户手写的 `<input>` 不会被误伤。
 */
const TASK_CHECKBOX_RE = /^<input\b[^>]*class="task-list-item-checkbox"/

/** 覆盖 html_inline / html_block 的渲染规则（幂等：每次 parse 前都会拿到同一个实例） */
function patchHtmlRules(md: unknown): void {
  const m = md as MdHtmlInstance
  if (!m?.renderer?.rules || m.__luminHtmlRules) return
  m.__luminHtmlRules = true
  // 行内 HTML：进文档后是一段带 MdHtml mark 的文本，序列化逐字写回
  m.renderer.rules.html_inline = (tokens: { content: string }[], idx: number): string => {
    const raw = tokens[idx].content
    if (TASK_CHECKBOX_RE.test(raw)) return raw
    return `<span data-md-html>${escapeHtml(raw)}</span>`
  }
  // 块级 HTML：整段原文交给 HtmlBlock 节点（含缩进与换行，逐字保留）
  m.renderer.rules.html_block = (tokens: { content: string }[], idx: number): string =>
    `<pre data-md-htmlblock>${escapeHtml(tokens[idx].content)}</pre>\n`
}

/** 行内 HTML 原文的 mark：内容就是 `<kbd>` 这样的原文，序列化原样输出 */
export const MdHtml = Mark.create({
  name: 'mdHtml',
  renderHTML() {
    return ['span', { 'data-md-html': 'true', class: 'md-html' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-html]', priority: 60 }]
  },
  addStorage() {
    return {
      markdown: { serialize: { open: () => '', close: () => '', escape: false } }
    }
  }
})

/** 块级 HTML：整段原文（可能多行）放节点里，序列化原样写回 */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      /** 原始 HTML 片段（含缩进与换行） */
      source: { default: '' }
    }
  },
  parseHTML() {
    return [
      {
        tag: 'pre[data-md-htmlblock]',
        priority: 60,
        getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },
  renderHTML({ node }) {
    return ['pre', { 'data-md-htmlblock': 'true', class: 'md-htmlblock' }, node.attrs.source]
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(t: string): void; closeBlock(n: unknown): void },
          node: { attrs: { source: string } }
        ): void {
          // 原文里可能没有收尾换行：markdown-it 的 html_block 内容一般带，逐字写回即可
          state.write(node.attrs.source.replace(/\n$/, ''))
          state.closeBlock(node)
        },
        // 解析钩子挂在节点上（tiptap-markdown 只会遍历节点/mark 的 markdown storage）
        parse: { setup: (md: unknown) => patchHtmlRules(md) }
      }
    }
  }
})

export { patchHtmlRules }
