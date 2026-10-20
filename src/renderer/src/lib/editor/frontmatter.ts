// ─── YAML front matter 块节点（Wave 1 剩余保真缺口：frontmatter.md）────────────
//
// 目标：文档开头的 front matter **字节级原样往返**，且在 WYSIWYG 里看得见。
//
// 为什么做成一个真实节点（而不是「编辑器外部的一小段字符串」）：
// Wave 3.2 刚把「正文只有一个真源」这件事收敛干净（手册 §4.59）。如果 front matter 存在
// 编辑器之外（组件 ref / store 单独字段），就又出现两处表示，而且源码模式 textarea 里
// 它明明在正文里 —— 迟早对不上。做成节点后：**文档文本 = 节点序列化结果**，
// 一行都不多不少，编辑器里也能直接看到这段 YAML。
//
// 往返三段（与 MdEscape 同一套机制，见 inlineMarks.ts 顶部说明）：
//   1. `parse.setup(md)` 里插一条 markdown-it **block 规则**，只在文档最开头认领
//      `---…---`（判定见 shared/frontmatter.ts，纯函数有单测），推一个自定义 token，
//      内容就是原文；
//   2. 自定义 token 自带渲染规则 → `<pre data-md-frontmatter>原文</pre>`；
//   3. 本节点的 `parseHTML` 认领它，`storage.markdown.serialize` 把原文原样写回。
//
// 取舍（都写在这里，免得以后当成 bug）：
//   * 它是 `atom`：在 WYSIWYG 里**不能直接编辑**，改 YAML 走源码模式（Ctrl+/ 切过去）。
//     做成可编辑需要一套 YAML 编辑器，那是另一个功能，不是保真缺口。
//   * 只能待在文档最开头：用户把它拖到中间后再序列化就不是 front matter 了
//     （解析规则同样只认开头，语义一致 —— 不会出现「看着还在、保存后跑进正文」的错位）。
import { Node } from '@tiptap/core'
import { extractFrontmatter } from '../../../../shared/frontmatter.ts'
import { escapeHtml } from '../utils/html'

/** markdown-it block 状态（只用到这几个成员） */
interface MdBlockState {
  src: string
  line: number
  push(
    type: string,
    tag: string,
    nesting: number
  ): { content: string; map: [number, number] | null }
}

/** markdown-it 实例（只用到 block.ruler 与 renderer.rules） */
interface MdFrontmatterInstance {
  __luminFrontmatterRule?: boolean
  block?: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        fn: (state: MdBlockState, startLine: number, endLine: number, silent: boolean) => boolean
      ): void
    }
  }
  renderer?: { rules: Record<string, unknown> }
}

/**
 * 插一条「文档开头的 front matter」块规则。
 * 放在 `table` 之前 = 整条 block 规则链的最前面（只有它可能移动 state.line 到文档中部，
 * 其余规则都从当前行往下看，顺序上与它们无冲突）。
 */
function patchFrontmatterRule(md: unknown): void {
  const m = md as MdFrontmatterInstance
  if (!m?.block?.ruler || m.__luminFrontmatterRule) return
  m.__luminFrontmatterRule = true

  if (m.renderer?.rules) {
    m.renderer.rules.md_frontmatter = (tokens: { content: string }[], idx: number): string =>
      `<pre data-md-frontmatter>${escapeHtml(tokens[idx].content)}</pre>\n`
  }

  m.block.ruler.before('table', 'md_frontmatter', (state, startLine, _endLine, silent) => {
    // 只认文档第一行：正文中间出现的 `---` 依旧是主题分割线
    if (startLine !== 0) return false
    const fm = extractFrontmatter(state.src)
    if (!fm) return false
    if (silent) return true
    const token = state.push('md_frontmatter', '', 0)
    token.content = fm.raw
    token.map = [0, fm.nextLine]
    state.line = fm.nextLine
    return true
  })
}

export const Frontmatter = Node.create({
  name: 'frontmatter',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      /** front matter 原文（含首尾 `---` 行）—— 原样写回的唯一依据 */
      source: { default: '' }
    }
  },

  parseHTML() {
    // priority 高于代码块的 `pre` 规则：带 data 属性的才算 front matter
    return [
      {
        tag: 'pre[data-md-frontmatter]',
        priority: 60,
        getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    // 作为 DOM 输出时把原文放回可见文本里（粘贴/复制为 HTML 时也不丢内容）
    return ['pre', { 'data-md-frontmatter': 'true', class: 'md-frontmatter' }, node.attrs.source]
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(t: string): void; closeBlock(n: unknown): void },
          node: { attrs: { source: string } }
        ): void {
          // 原样写出（不 esc：YAML 里的 `*`/`_`/`[` 是内容不是 Markdown 标记）
          state.write(node.attrs.source)
          state.closeBlock(node)
        },
        parse: { setup: (md: unknown) => patchFrontmatterRule(md) }
      }
    }
  }
})

export { patchFrontmatterRule }
