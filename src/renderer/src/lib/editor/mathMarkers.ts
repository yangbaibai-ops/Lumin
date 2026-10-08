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
  return mathRenderInfo(source, display).html
}

/**
 * 空公式的占位元素（`< Empty Math Block >`，Typora 那种"框架还在"的观感）。
 *
 * ⚠️ **铁律：它只是视图**。文本一个字都不进文档 —— 块级空公式在模型里仍然是
 * `mathBlock { source: '' }`，序列化照旧是 `$$\n\n$$`。所以这个元素：
 *   * 带 `data-md-math-empty`（套件按它断言，且不靠中文/英文文案）；
 *   * `user-select: none` + `contenteditable=false`（选不中、也复制不进文档）；
 *   * 文案由调用方注入（`MathLabels.empty` / `MathBlock` 的 `emptyLabel` 选项，来自语言包）。
 */
export function emptyMathDom(label: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-math-empty'
  span.setAttribute('data-md-math-empty', '')
  span.setAttribute('contenteditable', 'false')
  span.textContent = label
  return span
}

/**
 * 与 `renderMath` 同一份渲染，额外**如实回报"这段公式画出来了没有"**，失败时给出**为什么**。
 *
 * 为什么不能让 KaTeX 自己兜底（`throwOnError: false`）——第二十九轮实测的坑：
 * 那个选项下**未知宏不报错**，KaTeX 会把它当**普通文字**画出来（`\ce{H2O}` 会显示成
 * "\ceH2O"、"`\notarealmacro`"原样显示），产物里既没有 `katex-error` 也没有任何异常。
 * 于是"错误态"根本无从判断，用户看到的是**一段看着像公式、其实是错的**东西。
 *
 * 所以这里改用 `throwOnError: true` + 自己接住：它才是**完备**的判据 ——
 *   * 语法不闭合（`\frac{1}{`）→ 抛；
 *   * 未定义的宏（`\ce`、`\today`、打错的 `\badcommnad`）→ 抛；
 *   * 正常公式 / `align` / `pmatrix` / `\text{中文}` → 正常画出来（实测都 OK）。
 * 接住之后渲染成**一句人话**（KaTeX 的错误信息本身就说明了哪个宏、在哪个位置），
 * 这比"把原文原样画一遍"有用得多；`title` 里带上完整信息，鼠标悬停能看全。
 *
 * 三件事实分开回报（`error` 的含义只有一种：**没画出公式**）：
 *   * 正常 → `error: false`；
 *   * 抛了（语法错 / 未知宏 / 非字符串输入）→ 转义的 `<code class="md-math-error">`，
 *     `error: true`，且**不让未转义 HTML 进 DOM**（与 renderMath 的既有口径一致）。
 */
export function mathRenderInfo(
  source: unknown,
  display: boolean
): { html: string; error: boolean } {
  try {
    const html = katex.renderToString(source as string, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      output: 'html'
    })
    return { html, error: false }
  } catch (e) {
    const raw = String((e as { message?: string } | undefined)?.message ?? e ?? '')
    const message = raw.replace(/^KaTeX parse error:\s*/, '').slice(0, 300)
    return {
      html:
        `<code class="md-math-error" title="${escapeHtml(message)}">` +
        `${escapeHtml(message || String(source ?? ''))}</code>`,
      error: true
    }
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
export const MathBlock = Node.create<{ emptyLabel: string }>({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  /**
   * 空公式占位文案（`< Empty Math Block >`）。**由 `buildEditorExtensions` 从语言包注入**
   * （内核不认识 i18n，与 `MathPreview` 的 `labels` 同一口径）；默认空串只是兜底，
   * 界面上永远走注入值。
   */
  addOptions() {
    return { emptyLabel: '' }
  },
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
   *
   * ⚠️ `update` 是**必须**的（第二十九轮补）：源码框逐键写回时改的是 `source` 属性，
   * 而 NodeView 默认在属性变化时不重建 —— 少了这个回调，敲进框里的字符会**只进模型、
   * 不进画面**（实测：公式停在旧内容，而文档里已经是新内容）。`update` 返回 `false`
   * 表示"这个新节点我处理不了"，交回给 PM 重建。
   *
   * 编辑态**不在这里**（第三十轮）：编辑容器是**随正文流的块级 widget 装饰**
   * （见 mathPreview.ts），编辑时这个 NodeView 被 CSS `.md-math-editing` 收起、
   * 由那个容器取代。为什么不把编辑容器塞进这个 NodeView：会话是**只改视图**的事务
   * （没有任何文档变化），而 ProseMirror 在"文档没变"时**不会调用 `view.update()`**，
   * NodeView 因此拿不到通知、挂不上编辑器（实测过：点击后会话开了但界面上什么都没有）。
   * 走装饰就绕开了这个限制 —— 装饰由 `props.decorations` 重算，PM 一定接得住。
   */
  addNodeView() {
    const emptyLabel = this.options.emptyLabel
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'md-math-block'
      dom.setAttribute('data-md-math-block', 'true')
      const paint = (source: string): void => {
        dom.setAttribute('data-source', source)
        // 空公式：**框架保留**，画 `< Empty Math Block >`（只是视图；`source` 仍然是空的，
        // 序列化照旧 `$$\n\n$$` —— 见 emptyMathDom 的铁律说明）
        if (!source.trim()) {
          dom.replaceChildren(emptyMathDom(emptyLabel))
          return
        }
        dom.innerHTML = renderMath(source, true)
      }
      paint(String(node.attrs.source ?? ''))
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'mathBlock') return false
          paint(String(updated.attrs.source ?? ''))
          return true
        }
      }
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
