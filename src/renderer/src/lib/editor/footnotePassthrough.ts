// ─── 脚注（`[^1]` 引用 + `[^1]: 定义`）的**原样透传**（审计 §3「Markdown 往返保真风险清单」）──
//
// 审计的现场：脚注「**完全没处理**」，风险标注"高：按普通文本渲染，往返后可能变成普通段落"。
// 实测比它写的更糟（`_verify-md-fidelity.js` 加夹具后当场量到）：
// markdown-it 把 `[^1]: 第一条脚注的正文。` 当**链接引用定义**解析，于是
//   * 脚注定义整行消失（正文被搬进了链接目标）；
//   * 正文里的 `[^1]` 变成了**链接**：`脚注引用[^1](第一条脚注的正文。)`；
//   * 没有配对的 `[^2]` 被写出器转义成 `\[^2\]`。
// 这三条都是"内容被改写"，属于本仓库最不能接受的一类（产品承诺源文件不被破坏）。
//
// 做法与行内 HTML / frontmatter / 公式同一条路子：**不解释它，原样透传**
//   * 行内 `[^label]` → `<span data-md-footnote>` → `MdFootnote` mark（`escape:false`，逐字写回）；
//   * 块级 `[^label]: …`（含缩进续行）→ `<pre data-md-footnote-def>` → `FootnoteDef` 原子节点，
//     `source` 存原文、序列化逐字写回。
// 注册顺序很关键：两条规则都要排在 markdown-it 的 `reference`（链接引用定义/引用式链接）**之前**，
// 否则它先把定义吃掉 —— 这正是当前 lossy 的根因。
import { Mark, Node } from '@tiptap/core'
import { escapeHtml } from '../utils/html.ts'

/** 行内引用 `[^label]`（label 里不允许 `]` 与换行） */
const REF_AT = /^\[\^([^\]\n]+)\]/
/** 块级定义行首 `[^label]:`（前导缩进已由 markdown-it 的 tShift 处理） */
const DEF_AT = /^\[\^[^\]\n]+\]:/

interface MdFootnoteInstance {
  __luminFootnoteRules?: boolean
  inline?: { ruler: { before(name: string, rule: string, fn: unknown): void } }
  block?: { ruler: { before(name: string, rule: string, fn: unknown): void } }
  renderer?: { rules: Record<string, unknown> }
}

/** 覆盖两条规则（幂等：每次 parse 前都会拿到同一个实例） */
export function patchFootnoteRules(md: unknown): void {
  const m = md as MdFootnoteInstance
  if (!m?.inline?.ruler || !m.block?.ruler || !m.renderer?.rules || m.__luminFootnoteRules) return
  m.__luminFootnoteRules = true

  // 行内：`[^label]` 原样进文档（渲染成一个带 data 属性的 span，序列化逐字写回）。
  // ⚠️ 锚点必须是 `link`：markdown-it 的**行内** ruler 里没有 `reference` 这条规则
  //（引用式链接是 `link` 规则内部处理的）—— 写 `reference` 会当场抛
  // "Cannot find rule"，整个编辑器起不来（实测：套件报"编辑器未就绪"）。
  m.inline.ruler.before('link', 'lumin_footnote_ref', (state: never, silent: boolean) => {
    const s = state as unknown as {
      src: string
      pos: number
      push(type: string, tag: string, n: number): { content: string }
    }
    const hit = REF_AT.exec(s.src.slice(s.pos))
    if (!hit) return false
    if (!silent) {
      const token = s.push('lumin_footnote_ref', '', 0)
      token.content = hit[0]
      s.pos += hit[0].length
    }
    return true
  })
  m.renderer.rules.lumin_footnote_ref = (tokens: { content: string }[], idx: number): string =>
    `<span data-md-footnote>${escapeHtml(tokens[idx].content)}</span>`

  // 块级：`[^label]: …` 连同缩进续行整段原样收下
  m.block.ruler.before(
    'reference',
    'lumin_footnote_def',
    (state: never, startLine: number, endLine: number, silent: boolean) => {
      const s = state as unknown as {
        bMarks: number[]
        eMarks: number[]
        tShift: number[]
        src: string
        line: number
        push(type: string, tag: string, n: number): { content: string; map: number[] }
      }
      const start = s.bMarks[startLine] + s.tShift[startLine]
      const first = s.src.slice(start, s.eMarks[startLine])
      if (!DEF_AT.test(first)) return false
      if (silent) return true
      let lastLine = startLine
      let next = startLine + 1
      while (next < endLine) {
        const raw = s.src.slice(s.bMarks[next], s.eMarks[next])
        if (/^\s*$/.test(raw)) {
          next += 1
          continue
        }
        // 续行必须缩进（≥2 空格）：否则这个定义到此为止
        if (/^ {2,}/.test(raw)) {
          lastLine = next
          next += 1
          continue
        }
        break
      }
      const token = s.push('lumin_footnote_def', '', 0)
      token.content = s.src.slice(start, s.eMarks[lastLine])
      token.map = [startLine, lastLine + 1]
      s.line = lastLine + 1
      return true
    }
  )
  m.renderer.rules.lumin_footnote_def = (tokens: { content: string }[], idx: number): string =>
    `<pre data-md-footnote-def>${escapeHtml(tokens[idx].content)}</pre>\n`
}

/** 行内脚注引用：内容就是 `[^1]` 这样的原文，序列化原样输出 */
export const MdFootnote = Mark.create({
  name: 'mdFootnote',
  renderHTML() {
    return ['span', { 'data-md-footnote': 'true', class: 'md-footnote' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-footnote]', priority: 61 }]
  },
  addStorage() {
    return {
      markdown: { serialize: { open: () => '', close: () => '', escape: false } }
    }
  }
})

/** 脚注定义块：原文（可能多行）存 `source`，序列化逐字写回 */
export const FootnoteDef = Node.create({
  name: 'footnoteDef',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { source: { default: '' } }
  },
  parseHTML() {
    return [
      {
        tag: 'pre[data-md-footnote-def]',
        priority: 61,
        getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },
  renderHTML({ node }) {
    return ['pre', { 'data-md-footnote-def': 'true', class: 'md-footnote-def' }, node.attrs.source]
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(t: string): void; closeBlock(n: unknown): void },
          node: { attrs: { source: string } }
        ): void {
          state.write(node.attrs.source.replace(/\n$/, ''))
          state.closeBlock(node)
        },
        /**
         * 解析钩子挂在**节点**上（与 `HtmlBlock` 同一条已验证的路子）：
         * 实测挂在 mark 的 storage 上**不会**被 tiptap-markdown 调用 —— 那一次跑出来的结果
         * 与没打补丁时逐字节相同（规则根本没注册），换成节点后立刻生效。
         */
        parse: { setup: (md: unknown) => patchFootnoteRules(md) }
      }
    }
  }
})
