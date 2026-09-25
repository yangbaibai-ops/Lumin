// ─── 数学公式（`$…$` 行内 / `$$…$$` 块级）──────────────────────────────────────
//
// 目标：**公式原文一个字符都不动，渲染成公式只是视图**。这与「标记文本即源码」模型一致
// （`**`/`` ` `` 也是这个套路）：文档里存的始终是 `$E = mc^2$`，KaTeX 只是把它画出来。
//
// 两条链路：
//   * **行内**：`parse.setup` 插一条 markdown-it 行内规则 → `<span data-md-math>` →
//     `MdMath` mark（open/close 空 + `escape:false`）→ 序列化**逐字写回**；渲染由
//     `mathPreview.ts` 的**替换装饰 + KaTeX 组件**负责（光标落进去就露出原文，与标记显隐同一套交互）。
//   * **块级**：block 规则认领 `$$…$$`（单行与多行都认）→ `MathBlock` 原子节点，
//     原文存在 `data-source`（PM 会正确转义），渲染时用 KaTeX 画成居中块。
//     块级之所以不共用行内那条路：块公式必须独占块，而「独占块的文本节点」在 PM 里不存在。
//
// 识别规则在 `lib/mathScan.ts`（纯函数，9 条单测）：不跨行、内容非空、闭合 `$` 后不能紧跟数字
// （否则「价格 $5 和 $6」会被吃成公式 —— 各家编辑器都踩过这个坑）。
import { Mark, Node } from '@tiptap/core'
import katex from 'katex'
// 显式 .ts：这两个模块要被 tests/mathMarkers.test.mjs 直接加载，而 Node 的 ESM 不做扩展名补全
// （与本仓库 other 处同一口径，见 shared/defaults.ts 的注释）
import { escapeHtml } from '../utils/html.ts'
import { matchBlockMath, matchInlineMath } from '../mathScan.ts'

/** KaTeX 渲染成 HTML 字符串。**失败不抛**：公式写错不该让整篇文档崩掉 */
export function renderMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: 'html'
    })
  } catch {
    return `<code class="md-math-error">${escapeHtml(source)}</code>`
  }
}

/** markdown-it 实例（只用到 inline/block 规则与 renderer.rules） */
interface MdMathInstance {
  __luminMathRules?: boolean
  inline?: {
    ruler: { before(name: string, rule: string, fn: (s: never, silent: boolean) => boolean): void }
  }
  block?: {
    ruler: {
      before(
        name: string,
        rule: string,
        fn: (s: never, startLine: number, endLine: number, silent: boolean) => boolean
      ): void
    }
  }
  renderer?: { rules: Record<string, unknown> }
}

/** 行内规则状态（只用到这几个成员） */
interface InlineState {
  src: string
  pos: number
  push(type: string, tag: string, nesting: number): { content: string }
}
/** 块级规则状态 */
interface BlockState {
  src: string
  line: number
  push(
    type: string,
    tag: string,
    nesting: number
  ): { content: string; block?: boolean; map?: number[] }
}

/** 行号表按 src 缓存：块规则逐行调用，每次 split 会变成 O(n²) */
let linesSrc = ''
let linesCache: string[] = []
function linesOf(src: string): string[] {
  if (src !== linesSrc) {
    linesSrc = src
    linesCache = src.split('\n')
  }
  return linesCache
}

function patchMathRules(md: unknown): void {
  const m = md as MdMathInstance
  if (!m?.inline?.ruler || m.__luminMathRules) return
  m.__luminMathRules = true

  if (m.renderer?.rules) {
    // 行内：把 `$…$`（含定界符）原样放进 span —— 文本进文档后由 MdMath mark 逐字写回
    m.renderer.rules.md_math_inline = (tokens: { content: string }[], idx: number): string =>
      `<span data-md-math>${escapeHtml('$' + tokens[idx].content + '$')}</span>`
    // 块级：原文放 data-source（PM 的 parseHTML 读它），KaTeX 渲染在节点 renderHTML 里
    m.renderer.rules.md_math_block = (tokens: { content: string }[], idx: number): string =>
      `<div data-md-math-block data-source="${escapeHtml(tokens[idx].content).replace(/"/g, '&quot;')}"></div>\n`
  }

  m.inline.ruler.before('emphasis', 'md_math_inline', (state: InlineState, silent: boolean) => {
    const hit = matchInlineMath(state.src, state.pos)
    if (!hit) return false
    if (!silent) state.push('md_math_inline', '', 0).content = hit.content
    state.pos = hit.end
    return true
  })

  m.block!.ruler.before(
    'fence',
    'md_math_block',
    (state: BlockState, startLine, _endLine, silent) => {
      const hit = matchBlockMath(linesOf(state.src), startLine)
      if (!hit) return false
      if (silent) return true
      const token = state.push('md_math_block', 'div', 0)
      token.content = hit.content
      token.block = true
      token.map = [startLine, hit.endLine + 1]
      state.line = hit.endLine + 1
      return true
    }
  )
}

/**
 * 行内公式的 mark：正文就是 `$…$` 原文（`escape:false` + 空包裹 → 序列化逐字写回）。
 * 注册在其它行内 mark 之后（`escape:false` 只对最内层 mark 生效）。
 */
export const MdMath = Mark.create({
  name: 'mdMath',
  renderHTML() {
    return ['span', { 'data-md-math': 'true', class: 'md-math' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-math]', priority: 60 }]
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: () => '', close: () => '', escape: false },
        parse: { setup: (md: unknown) => patchMathRules(md) }
      }
    }
  }
})

/** 块级公式：独占块的原子节点，原文在属性里，屏幕上用 KaTeX 画成居中块 */
export const MathBlock = Node.create({
  name: 'mathBlock',
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
        tag: 'div[data-md-math-block]',
        priority: 60,
        getAttrs: (el) => ({ source: (el as HTMLElement).getAttribute('data-source') ?? '' })
      }
    ]
  },
  /**
   * 屏幕上的呈现走 **NodeView**：PM 的 DOMOutputSpec 没法注入 HTML（这个版本的
   * `renderSpec` 不支持 `innerHTML`），而 KaTeX 的输出就是一段 HTML。
   * `renderHTML` 只在「复制为 HTML」等场景用到，那里给原文即可。
   */
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'md-math-block'
      dom.setAttribute('data-md-math-block', 'true')
      dom.setAttribute('data-source', String(node.attrs.source ?? ''))
      dom.innerHTML = renderMath(String(node.attrs.source ?? ''), true)
      return { dom }
    }
  },
  renderHTML({ node }) {
    return [
      'div',
      {
        'data-md-math-block': 'true',
        'data-source': String(node.attrs.source ?? ''),
        class: 'md-math-block'
      },
      String(node.attrs.source ?? '')
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(t: string): void; closeBlock(n: unknown): void },
          node: { attrs: { source: string } }
        ): void {
          // 统一写成多行形态（`$$` 独占一行）：单行写法 `$$ x $$` 归一为它（保义，见 EXPECT.json）
          state.write('$$\n' + node.attrs.source + '\n$$')
          state.closeBlock(node)
        }
      }
    }
  }
})

export { patchMathRules }
