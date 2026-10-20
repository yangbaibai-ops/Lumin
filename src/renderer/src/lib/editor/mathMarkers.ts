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
import { InputRule, Mark, Node } from '@tiptap/core'
import { TextSelection, Plugin } from '@tiptap/pm/state'
import katex from 'katex'
// 显式 .ts：这两个模块要被 tests/mathMarkers.test.mjs 直接加载，而 Node 的 ESM 不做扩展名补全
// （与本仓库 other 处同一口径，见 shared/defaults.ts 的注释）
import { escapeHtml } from '../utils/html.ts'
import {
  matchBlockMath,
  matchInlineMath,
  matchInlineMathAtCaret,
  scanInlineMathSpans
} from '../mathScan.ts'

/** KaTeX 渲染成 HTML 字符串。**失败不抛**：公式写错不该让整篇文档崩掉 */
export function renderMath(source: string, display: boolean): string {
  return mathRenderInfo(source, display).html
}

/**
 * 空公式的占位元素（`< Empty Math Block >`，主流编辑器那种"框架还在"的观感）。
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
  /**
   * `inclusive: false`（第十一轮用户口径：「写完行内公式后无法在公式后再写入文字，
   * 写入的文字会加到公式中，甚至无法点击」）。
   *
   * 默认 `inclusive: true` 的语义是"光标停在 mark 的**右边界**时这个 mark 仍然生效" ——
   * 于是光标落在 `$…$` 之后（点公式右侧 / 按 → 到边界 / 段落以公式结尾时点到行尾）再打字，
   * 新字符会带着 `mdMath` 落进公式里（实测：`$E=mc^2$` → `$E=mc^2$q`，序列化也跟着变）。
   * 公式原文属于**不透明内容**，右边界之外就是普通正文，所以这里关掉它：
   * 边界处打字落到正文、也不会从边界继承 `mdMath`（公式的 mark 范围一个字符都不动）。
   *
   * ⚠️ 这不影响"收尾 `$` 一落即渲染"：输入规则自己 `replaceWith` 出带 mark 的文本，
   * 与 `inclusive` 无关（见下面的 `addInputRules`）；也不影响在公式**内部**打字
   *（那仍然落在 mark 里）。
   */
  inclusive: false,
  renderHTML() {
    return ['span', { 'data-md-math': 'true', class: 'md-math' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-math]', priority: 60 }]
  },
  /**
   * 「敲下收尾 `$`」的那一刻就把 `$…$` 收成行内公式（第十轮用户口径：
   * 「依次输入 `$E=mc^2$`，没有行内公式出现」）。
   *
   * 为什么非要有这条：`MdMath` 这个 mark **只由 markdown 解析产生**
   * （`parseHTML` ← `<span data-md-math>` ← `patchMathRules` 插的 markdown-it 规则），
   * 而 markdown-it 只会在「把一段 markdown 文本读进编辑器」时跑（打开文件 / 粘贴 /
   * 切面 / 导出回流）——**逐键打字根本不经过它**。对照：`**粗体**` 有
   * `inlineMarks` 的派生归一化（`appendTransaction`）兜着，所以敲完收尾 `**`
   * 立刻成型；`$…$` 此前没有对应机制 ⇒ 打完一串仍是纯文本（实测时间线见报告）。
   *
   * 判据**复用 `matchInlineMathAtCaret`**（见 mathScan.ts）：与 markdown-it 用同一个
   * `matchInlineMath`，`\$` 转义 / `$$` / 内容非空 / 不跨行 / 收尾 `$` 后不紧跟数字
   * 这些边界**不会漂**。输入规则只在「刚敲下的字符是 `$`」时尝试（`view.composing`
   * 期间 Tiptap 直接跳过输入规则 ⇒ 输入法组字不会被误判）。
   */
  addInputRules() {
    const markType = this.type
    return [
      new InputRule({
        find: /\$$/,
        handler: ({ state, range }) => {
          const $caret = state.doc.resolve(range.to)
          const parent = $caret.parent
          if (!parent.isTextblock) return null
          const base = $caret.start()
          // 光标之前的段落文本 + 刚敲下的那个 `$`（它此刻还**没**进文档）
          const before = state.doc.textBetween(base, range.to, '\n', '\ufffc') + '$'
          const hit = matchInlineMathAtCaret(before)
          if (!hit) return null
          const from = base + hit.from
          // 与解析同口径的复核：文档里此刻应当正好是"去掉刚敲那个 `$`"的原文
          const inDoc = hit.raw.slice(0, -1)
          if (state.doc.textBetween(from, range.to, '\n', '\ufffc') !== inDoc) return null
          const { tr } = state
          tr.replaceWith(from, range.to, state.schema.text(hit.raw, [markType.create()]))
          // 光标停到公式后面（不进 mark 范围里）
          tr.setSelection(TextSelection.create(tr.doc, from + hit.raw.length))
          // ⚠️ 必须清掉 storedMarks：光标贴在带 `mdMath` 的文本右边界时，PM 会沿用该位置的
          // mark 作为 storedMarks，紧接着输入的字会被**吞进公式里**（与 inputRules.ts 的
          // 链接规则同一个坑：那边是"Lumin尾巴"整段变成链接文字）。
          tr.setStoredMarks([])
          // 事务由 core 的 inputRulesPlugin 统一 dispatch，handler 本身无需返回值
          return
        }
      })
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: () => '', close: () => '', escape: false },
        parse: { setup: (md: unknown) => patchMathRules(md) }
      }
    }
  },
  /**
   * **归一化：带 `mdMath` 但不再配平的文本，把 mark 摘掉**（第十二轮用户口径）。
   *
   * 用户场景：`$\frac{1}{2}$` 在**行内公式末尾**按删除键删掉收尾 `$` ⇒ 文档里剩 `$\frac{1}{2}`。
   * 改前它**仍然带着 `mdMath`**（mark 是文本属性，删字符不会连 mark 一起删），于是渲染层
   * 把它当公式交给 KaTeX，`tex` 里带着那个前导 `$` ⇒ 屏上弹
   * `Can't use function '$' in math mode at position 1: $\frac{1}{2}` ✗
   * —— 这不符合所见即所得：**行内公式必须是一对配平的 `$…$`**，不配平就该**退回普通文本**。
   *
   * 判据直接复用 `scanInlineMathSpans`（= `matchInlineMath` 的左到右配对，与 markdown-it
   * 解析行内公式用的是**同一个函数**）：一段 marked 文本里，**被配平区间覆盖的字符保留 mark**、
   * **其余字符摘掉 mark**。这样三种情形都对：
   *   * 删收尾 `$` → `$\frac{1}{2}`：没有任何配平区间 ⇒ 整段摘掉 ✓
   *   * 删开头 `$` → `\frac{1}{2}$`：同理整段摘掉 ✓
   *   * 中间被改坏 → `$a$b$`：只保留 `$a$` 上的 mark，`b$` 退回普通文本 ✓
   *     （markdown-it 对 `$a$b$` 的判定就是"`$a$` 是公式、`b$` 是文本"，口径一致 ✓）
   *
   * ⚠️ 与"**语法错**的公式要报错"不冲突：这里只管**配平**（`$` 成对、内容非空、不跨行、
   * 收尾 `$` 后不紧跟数字）。配平但内容有错（`$\notarealmacro$`）**保留 mark**，
   * 继续由渲染层用 KaTeX 的 `throwOnError` 显示明确错误态（上一轮的既有口径）。
   *
   * 为什么放在 `appendTransaction`（本仓库 `inlineMarks` 也是这个做法）：删字符这类编辑
   * 不经过任何输入规则，只有在"事务应用之后"统一体检才能保证任何改法都被修好；返回 `null`
   * 表示没改动 ⇒ PM 不会多记历史（`Ctrl+Z` 的步数与改前一致）。
   */
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        appendTransaction(trs, _oldState, newState) {
          // 只有文档真的变过才体检（纯选区/纯装饰事务不进来）
          if (!trs.some((tr) => tr.docChanged)) return null
          const tr = newState.tr
          let touched = false
          newState.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return true
            if (!node.marks.some((m) => m.type === type)) return true
            const spans = scanInlineMathSpans(node.text)
            let cursor = 0
            for (const span of spans) {
              if (span.from > cursor) {
                tr.removeMark(pos + cursor, pos + span.from, type)
                touched = true
              }
              cursor = span.to
            }
            if (cursor < node.text.length) {
              tr.removeMark(pos + cursor, pos + node.text.length, type)
              touched = true
            }
            return true
          })
          return touched ? tr : null
        }
      })
    ]
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
