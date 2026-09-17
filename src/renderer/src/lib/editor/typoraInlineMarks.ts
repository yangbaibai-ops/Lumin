// ─── Typora 行内标记：真实文本标记模型 ───────────────────────────────────────
// 与 Typora 一致：`**` 等语法字符是文档里的真实文本（可选中、可编辑——
// 删掉一个 `*` 就把 `**加粗**` 变成 `*加粗*` 斜体），样式由标记文本派生。
//
// 数据模型（两条自定义 Mark）：
//  - mdStyle（attrs.style: bold|italic|strike|code）：被样式的正文，
//    WYSIWYG 渲染为 <strong>/<em>/<s>/<code>；markdown 序列化 open/close
//    均为空——语法由标记文本自身承担，序列化输出 == 源码（往返零漂移）；
//  - mdMarker（attrs.style + side: start|end）：语法标记文本（'**'/'*'/'~~'/'`'），
//    序列化同样为空（其文字即源码），WYSIWYG 渲染为 .md-marker 行内 span，
//    光标在样式范围内时经 .md-reveal-inline 类显现，移出即隐藏。
//
// 派生归一化（appendTransaction）：文档变更后重建含样式/标记的文本块——
//   1. 识别「标记文本 + 正文 + 配对标记文本」模式 → 派生样式（手打
//      '**加粗**' 即时成样式，无需任何输入规则）；
//   2. 样式 run 的标记被编辑（'**' 删成 '*'）→ 按标记文本重派样式、
//      补齐/修正两侧标记；标记删空 → 去样式；
//   3. 遗留 mark（bold/italic/strike/code，来自解析/粘贴）转换为 mdStyle。
// 历史合并：prosemirror-history 按相邻时间戳合并事务，追加事务与主事务
// 同组，撤销一步到位。
import { Extension, Mark } from '@tiptap/core'
import type { RawCommands } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Fragment, DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { Mark as PMMark, MarkType as PMMarkType, Node as PMNode } from '@tiptap/pm/model'
// 纯逻辑核心（标记派生/配对/物化 + 冗余嵌套强调判定 + 光标落点）：**无 PM 运行时依赖**，
// 由 tests/inlineMarkers.test.mjs 单测钉死。
import {
  LEGACY,
  MARKER_OF,
  PATTERN_TEST,
  STYLE_ORDER,
  blockCaretTarget,
  hasStrayMarker,
  markerPairOffsets,
  needsSourceReparse,
  normalizeAtoms,
  patchRedundantEmphasis,
  styleList,
  stylesOf
} from './inlineMarkerCore'
import type { Atom, MarkerSide, StyleKind } from './inlineMarkerCore'
// 核心的符号在本文件再导出一次：既有的导入面（其它模块从这里取用）保持不变
export {
  KIND_OF_MARKER,
  LEGACY,
  MARKER_OF,
  STYLE_ORDER,
  blockCaretTarget,
  emphasisDepth,
  hasStrayMarker,
  isRedundantEmphasis,
  isRunPart,
  literalSpan,
  literalizeStrayAtoms,
  markerPairOffsets,
  materializeStyledRun,
  needsSourceReparse,
  normalizeAtoms,
  patchRedundantEmphasis,
  recognizeTypedMarkers,
  reLiftLiteralPairs,
  repairPollutedMarkers,
  sameStyles,
  splitStrayMarkerRuns,
  styleList,
  stylesOf,
  toLiteral
} from './inlineMarkerCore'
export type { Atom, MarkerSide, StyleKind } from './inlineMarkerCore'

// 自定义命令类型声明（tiptap v3 命令合并，命名空间形式）
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mdStyle: {
      toggleMdBold: () => ReturnType
      toggleMdItalic: () => ReturnType
      toggleMdStrike: () => ReturnType
      toggleMdCode: () => ReturnType
      normalizeMdMarkers: () => ReturnType
    }
  }
}

const TAG_OF: Record<StyleKind, string> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code'
}

export const MdStyle = Mark.create({
  name: 'mdStyle',
  addAttributes() {
    return {
      /**
       * 样式集合（外→内，按 STYLE_ORDER）。DOM 呈现由本 mark 的 renderHTML 手工拼，
       * 这里显式 renderHTML: () => null 防止 Tiptap 再额外挂一个 data-styles 属性。
       */
      styles: { default: ['bold'], renderHTML: () => null }
    }
  },
  renderHTML({ mark }) {
    const styles = styleList(mark.attrs.styles)
    const primary = styles[0] ?? 'bold'
    // 只出一个元素，把全部样式写进 data-md-styles：PM 同类型 mark 不能并存，
    // 若渲染成嵌套的 <strong><code>，DOM 回读时后者会顶掉前者（样式丢失 + 回写churn）。
    return [TAG_OF[primary], { 'data-md-style': primary, 'data-md-styles': styles.join(' ') }, 0]
  },
  parseHTML() {
    // DOM → 文档回读必须还原 mdStyle（否则 PM 的 DOMObserver 把渲染后的
    // <strong> 解析成 legacy bold，与文档比对不一致 → readDOMChange 回写循环）
    return STYLE_ORDER.map((s) => ({
      tag: `${TAG_OF[s]}[data-md-style]`,
      priority: 60,
      getAttrs: (el: HTMLElement) => ({
        styles: styleList(el.getAttribute('data-md-styles') ?? el.getAttribute('data-md-style'))
      })
    }))
  },
  addStorage() {
    // 序列化：语法由 mdMarker 文本承担，此处不输出任何包裹符
    return { markdown: { serialize: { open: () => '', close: () => '' } } }
  }
})

export const MdMarker = Mark.create({
  name: 'mdMarker',
  addAttributes() {
    return { style: { default: 'bold' }, side: { default: 'start' } }
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        class: 'md-marker',
        'data-md-style': HTMLAttributes.style,
        'data-side': HTMLAttributes.side
      },
      0
    ]
  },
  parseHTML() {
    return [
      {
        tag: 'span.md-marker',
        priority: 60,
        getAttrs: (node) => ({
          style: (node as HTMLElement).dataset.mdStyle ?? 'bold',
          side: (node as HTMLElement).dataset.side ?? 'start'
        })
      }
    ]
  },
  addStorage() {
    // 序列化：标记文字本身即源码——open/close 为空，且 escape:false
    // 让标记字符（* 等）原样输出（若被转义成 \*，序列化结果与源码不一致，
    // 会破坏外部同步回声过滤并引发 setContent 循环重放）
    return {
      markdown: {
        serialize: { open: () => '', close: () => '', escape: false },
        // 解析前的钩子：冗余嵌套强调的多余标记当字面文本留住（每次 parse 都会调用，
        // 内部做了幂等保护）
        parse: { setup: (md: unknown) => patchRedundantEmphasis(md) }
      }
    }
  }
})

/**
 * 行内代码正文的「不要转义」标记。
 *
 * 为什么需要它：prosemirror-markdown 只按**最内层 mark** 的 `escape === false` 决定
 * 是否原样输出（`renderInline` 里的 noEsc 分支）。mdMarker 靠这个机制让 `**` 原样落地；
 * 而 `mdStyle(code)` 的正文没有这层保护，于是代码跨度里的反斜杠会被转义：
 *   `` `a \* b` `` → 序列化成 `` `a \\\* b` ``；而**代码跨度里反斜杠不是转义字符**，
 *   下次解析照样原样读回，于是一次编辑多一层反斜杠 —— **每保存一次文件就变一次**
 *   （非幂等的源码增长，实测踩到）。
 *
 * 所以给 code 样式的正文再贴一个「空包裹 + escape:false」的 mark，作为最内层 mark
 * 走 noEsc 分支。它必须注册在 MdStyle **之后**（PM 按 schema 顺序排 marks，
 * 最内层取数组最后一个），也不能渲染出任何可见东西。
 */
export const MdCodeLiteral = Mark.create({
  name: 'mdCodeLiteral',
  renderHTML() {
    return ['span', { 'data-md-code-literal': 'true' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-code-literal]' }]
  },
  addStorage() {
    return { markdown: { serialize: { open: () => '', close: () => '', escape: false } } }
  }
})

// ─── 反斜杠转义（MdEscape）：让 `\*` 原样往返 ────────────────────────────────
//
// 问题：markdown-it 的 inline `escape` 规则会**吃掉**反斜杠（`\*` → 文本 `*`），
// 于是「字面星号」在往返后变成「斜体标记」——语义变了（§4.52 的已知缺口第一号）。
// 信息在解析那一刻就丢了，后面再怎么归一化都补不回来。
//
// 解法（用 tiptap-markdown 官方给的 `parse.setup` 钩子，与列表标记保留同一套机制）：
//   1. 把 `escape` 规则换成「推一个自定义 token，内容仍是原样的 `\X`」；
//   2. 渲染这个 token 成 `<span data-md-escape>\X</span>`；
//   3. 一个 mark（escape:false，open/close 为空）认领它 → 序列化时**逐字写回**。
// 于是 `\*不是斜体\*` 往返后还是 `\*不是斜体\*`，而不是变成斜体。

/** ASCII 标点（CommonMark 里可被反斜杠转义的字符集） */
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
/** 放进正则字符类前要转义的元字符 */
function charClassSource(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&')
}
/** 「反斜杠 + ASCII 标点」的守卫（blockNeedsNormalize 用；不匹配普通反斜杠） */
const ESCAPED_PUNCT_RE = new RegExp('\\\\[' + charClassSource(ASCII_PUNCT) + ']')
// 孤儿标记字符（`*`/`~`/`` ` `` 任意出现，包括不成对的那种）的判据只有一份：
// inlineMarkerCore.hasStrayMarker（字面量化用的是同一套字符集）

/** markdown-it 行内状态（只用到这几个成员） */
interface MdEscapeState {
  src: string
  pos: number
  posMax: number
  push(type: string, tag: string, nesting: number): { content: string }
  md?: { utils?: { isMdAsciiPunct(ch: number): boolean; isPunctChar(ch: string): boolean } }
}

/**
 * 替换 markdown-it 的 inline escape 规则（**照抄上游分支结构**，只改一处：可转义字符
 * 不再被"吃掉"反斜杠，而是原样 `\X` 交给带 `escape:false` 的 mark 逐字写回）。
 *
 * 上游这条规则有三种分支，一个都不能漏（实测漏掉第一种会让「反斜杠硬换行」变成
 * 「字面反斜杠 + 软换行」，整段被并成一行 —— §4.52 的 paragraph-breaks 夹具立刻变红）：
 *   1. `\` + 换行 → `hardbreak` 节点（并吃掉行尾空格）；
 *   2. `\` + 空格 → 一个字面反斜杠（反斜杠在空格前不是转义）；
 *   3. 其余 → 可转义标点保留 `\X`，不可转义字符本来就原样输出。
 */
function patchEscapeRule(md: unknown): void {
  const m = md as {
    __luminEscapeRule?: boolean
    inline?: {
      ruler: { at(name: string, fn: (s: MdEscapeState, silent: boolean) => boolean): void }
    }
    renderer?: { rules: Record<string, unknown> }
  }
  if (!m?.inline?.ruler || m.__luminEscapeRule) return
  m.__luminEscapeRule = true

  // 自定义 token 必须自带渲染规则（markdown-it 对未知类型的兜底是 renderToken，
  // 那会输出一个空标签而不是我们的 span）。内容里的 & < > 要转义 —— 它来自用户源码。
  if (m.renderer?.rules) {
    m.renderer.rules.md_escape = (tokens: { content: string }[], idx: number): string =>
      `<span data-md-escape>${escapeHtmlForAttr(tokens[idx].content)}</span>`
  }

  m.inline.ruler.at('escape', (state: MdEscapeState, silent: boolean): boolean => {
    const pos = state.pos
    const max = state.posMax
    if (state.src.charCodeAt(pos) !== 0x5c /* \ */) return false
    let p = pos + 1

    // ⓪ `\` 是这一段行内内容的**最后一个字符**（段尾孤立反斜杠）：它是字面反斜杠，
    //    必须原样写回。两个理由：
    //    · CommonMark/markdown-it 的硬换行都要求 `\` 后面**还有内容**（`hardbreak` 规则
    //      判的是 `pos < posMax`），所以段尾这个 `\` 不是硬换行，不能推 hardbreak；
    //    · 这里若 `return false`（修复前的行为），markdown-it 会把它当普通文本，
    //      序列化器再转义成 `\\` —— 于是「打开一个以 `a\` 结尾的段落、保存」会让文件
    //      **涨一个字符**（实测：`a\` → `a\\`，幂等但字节被改）。
    //    与下面 ② 的「`\` + 空格」同理：字面反斜杠一律走 `md_escape`（escape:false）逐字写回。
    if (p >= max) {
      if (!silent) {
        const token = state.push('md_escape', '', 0)
        token.content = '\\'
      }
      state.pos = p
      return true
    }

    let code = state.src.charCodeAt(p)

    // ① `\` + 换行 = 硬换行（上游还会顺手吃掉后面的行尾空格）
    if (code === 0x0a) {
      if (!silent) state.push('hardbreak', 'br', 0)
      p += 1
      while (p < max) {
        code = state.src.charCodeAt(p)
        if (code !== 0x20 && code !== 0x09) break
        p += 1
      }
      state.pos = p
      return true
    }

    // ② `\` + 空格：不是转义，输出一个字面反斜杠（后续空格由别的规则处理）
    if (code === 0x20) {
      if (!silent) {
        const token = state.push('md_escape', '', 0)
        token.content = '\\'
      }
      state.pos = p
      return true
    }

    // ③ 其余：保留原文 `\X`（可转义标点与不可转义字符都原样写回，语义与上游一致 ——
    //    上游对不可转义字符本来就是原样保留，对可转义标点则是"吃掉反斜杠"，这正是我们要改的）
    let escaped = state.src[p]
    if (code >= 0xd800 && code <= 0xdbff && p + 1 < max) {
      const low = state.src.charCodeAt(p + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        escaped += state.src[p + 1]
        p += 1
      }
    }
    if (!silent) {
      const token = state.push('md_escape', '', 0)
      token.content = '\\' + escaped
    }
    state.pos = p + 1
    return true
  })
}

/** 极少量的 HTML 转义（这个 span 的内容来自用户源码，不能原样拼进 HTML） */
function escapeHtmlForAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  )
}

// ─── 冗余嵌套强调（`****x****`）：多出来的那一对标记必须以**文本**活下来 ──────
// 规则与「为什么」见 inlineMarkerCore.ts 的 EMPHASIS_MARKUP / isRedundantEmphasis /
// patchRedundantEmphasis（纯逻辑 + 单测）；这里只把它挂到 markdown-it 的 parse.setup 上。

/**
 * 转义文本的 mark：内容就是 `\X` 原文，`escape:false` + 空包裹 → 序列化逐字写回。
 * 注册在其它行内 mark **之后**（PM 按 schema 顺序排 marks，`escape:false` 只对最内层那个生效）。
 */
export const MdEscape = Mark.create({
  name: 'mdEscape',
  renderHTML() {
    return ['span', { class: 'md-escape', 'data-md-escape': 'true' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-escape]', priority: 60 }]
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: () => '', close: () => '', escape: false },
        // 解析前的钩子：换掉 escape 规则（每次 parse 都会调用，内部做了幂等保护）
        parse: { setup: (md: unknown) => patchEscapeRule(md) }
      }
    }
  }
})

/** 一个文本节点上的**全部**样式（mdStyle 的集合 + 解析器留下的遗留 mark） */
function nodeStyles(node: PMNode): { styles: StyleKind[]; other: PMMark[] } {
  const collected: StyleKind[] = []
  const other: PMMark[] = []
  for (const m of node.marks) {
    // 这两个 mark 只是「序列化时不要转义」的载体，不是样式
    if (m.type.name === 'mdEscape' || m.type.name === 'mdCodeLiteral') continue
    if (m.type.name === 'mdStyle') {
      collected.push(...styleList(m.attrs.styles))
      continue
    }
    const legacy = LEGACY[m.type.name]
    if (legacy) {
      collected.push(legacy)
      continue
    }
    other.push(m)
  }
  return { styles: styleList(collected), other }
}

function toAtoms(frag: Fragment): Atom[] {
  const atoms: Atom[] = []
  frag.forEach((n) => {
    if (n.isText) {
      // 链接源码展开态（[文字](网址)，pointer.ts linkSource）、**行内 HTML 原文**
      // （`<kbd>`，htmlPassthrough.ts 的 MdHtml）与**行内公式原文**（`$…$`，mathMarkers.ts 的
      // MdMath）都视为不透明文本：内容按字面保留，不参与行内标记派生
      // （否则 HTML/公式里的 `*`/`_`/`\` 会被当成 Markdown 语法再解释一遍 ——
      //  实测 `$a * b$` 会被字面量化（literalizeStrayAtoms）从中间切开，公式碎成两段）。
      if (
        n.marks.some(
          (m) =>
            m.type.name === 'linkSource' || m.type.name === 'mdHtml' || m.type.name === 'mdMath'
        )
      ) {
        atoms.push({ kind: 'other', node: n })
        return
      }
      const mk = n.marks.find((m) => m.type.name === 'mdMarker')
      if (mk) {
        atoms.push({
          kind: 'marker',
          text: n.text,
          marker: { style: mk.attrs.style as StyleKind, side: mk.attrs.side as MarkerSide }
        })
        return
      }
      // **转义文本**（`\*`，mdEscape）：内容一个字符都不能动（verbatim），
      // 但它**仍然是所在样式正文的一部分** —— 若当成 'other'，样式正文会被它切成两段，
      // 于是 `**粗体里的 \* 星号**` 被拆成两个 `**…**` 构造（实测输出 `****\*****`）。
      // 所以按普通「带样式文本」处理（参与同样式连续段），只多一个 verbatim 标记：
      // recognizeTypedMarkers 不扫描它，fromAtoms 记得把 mdEscape 贴回去。
      const isEscaped = n.marks.some((m) => m.type.name === 'mdEscape')
      // 样式取**全部**（集合）：`**粗体里的 `代码`**` 里那段代码同时是粗体与代码，
      // 只留一个会让渲染或序列化缺一半（旧写法把第二个样式塞进 otherMarks，
      // 于是 markdown 写出器又按遗留 mark 写了一遍包裹符 → 双份标记）。
      const { styles, other } = nodeStyles(n)
      atoms.push({ kind: 'text', text: n.text, styles, otherMarks: other, verbatim: isEscaped })
    } else if (n.type.name === 'hardBreak') {
      atoms.push({ kind: 'break', node: n })
    } else {
      atoms.push({ kind: 'other', node: n })
    }
  })
  return atoms
}

function fromAtoms(atoms: Atom[], schema: EditorState['schema']): Fragment {
  const mdMarker = schema.marks.mdMarker
  const mdStyle = schema.marks.mdStyle
  const nodes: PMNode[] = []
  for (const a of atoms) {
    if (a.kind === 'marker') {
      if (!a.text || !a.marker) continue
      nodes.push(
        schema.text(a.text, [mdMarker.create({ style: a.marker.style, side: a.marker.side })])
      )
    } else if (a.kind === 'text') {
      if (!a.text) continue
      const marks = [...(a.otherMarks ?? [])]
      const styles = stylesOf(a)
      if (styles.length) {
        marks.push(mdStyle.create({ styles }))
        // 代码跨度：再贴一层「不要转义」（见 MdCodeLiteral 的说明）
        if (styles.includes('code')) marks.push(schema.marks.mdCodeLiteral.create({}))
      }
      // 转义文本：把 mdEscape 贴回去 —— 必须**最后**贴，`escape:false` 只对最内层 mark 生效
      if (a.verbatim) marks.push(schema.marks.mdEscape.create({}))
      nodes.push(schema.text(a.text, marks))
    } else if (a.node) {
      nodes.push(a.node)
    }
  }
  return Fragment.fromArray(nodes)
}

/** 解析 raw 行文本为行内结构（复用加载/刷新同一条 markdown-it 管线），
    供「源码权威重推」对齐实时与刷新的渲染语义。 */
function parseInlineHtml(schema: EditorState['schema'], html: string): PMNode | null {
  try {
    const dom = new DOMParser().parseFromString(html, 'text/html')
    const parsed = PMDOMParser.fromSchema(schema).parse(dom.body)
    let inline: PMNode | null = null
    parsed.forEach((n) => {
      if (!inline && n.isTextblock) inline = n
    })
    return inline
  } catch {
    return null
  }
}

// ─── 字面量化（「未被样式消费的裸标记字符」）——实现已搬进纯逻辑核心 ─────────────
//
// 背景：`*`/`~`/`` ` `` 这些字符若在 CommonMark 里没被样式构造消费，就只能是**字面文本**；
// 不给它们 `escape:false` 的载体的话，markdown 写出器会补反斜杠 → 源码漂移
// （`**5*` → `\**5*`，`**2****2**` → `**2\*\*\*\*2**`）。
//
// 实现现在只有**一份**：`inlineMarkerCore.literalizeStrayAtoms`，作为 `normalizeAtoms`
// 的最后一步跑（字面量化的产物不该再被拿去配对）。它同时覆盖两档：
//   * 无样式正文 → `mdMarker(side:'literal')`（原样序列化，文本变了还能「配对重提升」）；
//   * **样式正文** → 独立 verbatim 原子（`fromAtoms` 贴 `MdEscape` 的 `escape:false`
//     → 逐字写回）。这一档此前被漏掉：`**2****2**` 在 CommonMark 里是一个 strong
//     包住字面 `2****2`，而旧的 `literalizeStrayMarkers` 见到 `mdStyle` 就整段跳过，
//     于是写出器把那四颗星转义成了 `\*\*\*\*`（用户报的缺陷）。
// 走原子层还顺带让**装载路径**（带 legacy mark、不做源码重推的块）也吃到同一条规则。

/** 这个块里还有没有「解析器留下的」行内 mark（bold/italic/strike/code）。
    它们意味着内容是从 Markdown/HTML **解析**出来的，标记字符早已被解析器吃掉，
    块文本里剩下的 `*`/`_` 只是普通字符（行内代码里尤其常见）。 */
function hasLegacyInlineMark(block: PMNode): boolean {
  let legacy = false
  block.descendants((n) => {
    if (
      n.isText &&
      n.marks.some(
        (m) =>
          m.type.name === 'bold' ||
          m.type.name === 'italic' ||
          m.type.name === 'strike' ||
          m.type.name === 'code'
      )
    ) {
      legacy = true
    }
    return !legacy
  })
  return legacy
}

/** 一个行内片段里的**全部文本字符**（重推的「不丢字符」护栏用；行内节点贡献空串） */
function fragmentText(frag: Fragment): string {
  let out = ''
  frag.forEach((n) => {
    if (n.isText) out += n.text ?? ''
  })
  return out
}

/** 单块最终结构：常规原子归一化 + 「源码权威重推」。
    ——为什么需要重推：实时编辑产生的边缘源码（如 `**5*`、删掉 `*5*` 的收尾
    `*`）与 markdown-it 的解析语义可能不同（`**5*` 会被解析为 字面 `*` + 斜体
    `5`）。若不重推，这类结构要等“刷新（重新从源码解析）”才显示正确——即用户
    遇到的『实时渲染滞后』。这里对纯行内文本块，把它的原文喂给与加载相同的
    markdown-it 解析器，把解析结果经同一归一化转成标记模型，优先采用（差异
    时才替换，稳定态零开销）；解析不可用/不适用时回退常规归一化。

    ⚠️ **只对「标记文本模型」的块生效**：重推的输入是 block.textContent，而已解析
    出来的块文本里**没有**标记字符（`**加粗**` 只剩 `加粗` 带 legacy mark）。
    若此时还去重推，等于把「带样式的文本」当成源码再解析一遍 —— 解析结果没有任何
    样式，反而把 legacy mark 明确带出来的样式全抹掉。实测：
    `行内代码里**不**解析标记：\`a * b\` 与 \`c_d_e\`。` 因为文本里有个字面 `*`
    命中旧守卫，整行样式被抹平（内容损坏）。所以带 legacy mark 的块一律不重推，
    交给 normalizeAtoms 的「legacy → 补全两侧标记」分支。

    ⚠️ **重推结果必须逐字保文**（`fragmentText(frag2) === block.textContent`）：重推
    是「重新解释同一段源码」，一个字符都不许丢/变。把一行纯文本喂给**块级**解析器时，
    它可能把这一行当成别的语法构造 —— 实测：空段落点「删除线」得到 `~~~~`，而
    `~~~~` 在 CommonMark 里是**代码围栏**的开头，解析产物的文本为空，整段字符被清空
    （点一次删除线，四个 `~` 直接消失）。文本对不上就不采用，退回常规归一化。 */
function resolveBlockContent(
  schema: EditorState['schema'],
  block: PMNode,
  htmlParse: ((raw: string) => string) | undefined
): Fragment | null {
  const current = block.content
  const atoms = toAtoms(current)
  const fixed = normalizeAtoms(atoms)

  // 触发重推的条件（判据在纯逻辑核心 needsSourceReparse，单测钉死）：文本里还有
  // **标记字符或反斜杠转义**（后者见 MdEscape：用户手打的 `\*` / `\#` 要靠重推走一遍
  // 带 escape 规则的解析器，才能变成"原样输出"的转义文本）。
  // 「仅纯行内文本」（无子块/链接/图片）也在这里判——链接的真实源码不在文本里。
  if (
    htmlParse &&
    needsSourceReparse(block.textContent, {
      legacyStyles: hasLegacyInlineMark(block),
      pure: isPureInlineContent(current)
    })
  ) {
    try {
      const inline = parseInlineHtml(schema, htmlParse(block.textContent))
      if (inline) {
        const atoms2 = toAtoms(inline.content)
        const f2 = normalizeAtoms(atoms2)
        const frag2 = fromAtoms(f2 ?? atoms2, schema)
        if (!frag2.eq(current) && fragmentText(frag2) === block.textContent) return frag2
      }
    } catch {
      /* 解析失败 → 回退常规归一化 */
    }
  }

  if (!fixed) return null
  const frag = fromAtoms(fixed, schema)
  return frag.eq(current) ? null : frag
}

/** 块内容是不是「纯行内文本」（没有子块，也没有链接/链接源码这种源码不在文本里的东西） */
function isPureInlineContent(content: Fragment): boolean {
  let pure = true
  content.forEach((c) => {
    if (!c.isText || c.marks.some((m) => m.type.name === 'link' || m.type.name === 'linkSource')) {
      pure = false
    }
  })
  return pure
}

/**
 * 「逐字块」：内容是按字面理解的源码，**绝不能**拿去做行内标记派生。
 *
 * 为什么必须显式排除代码块：ProseMirror 里 `isTextblock` 只表示「内容是 inline」，
 * 代码块（`code: true`）也是 textblock。若把它当普通段落处理，「源码权威重推」就会
 * 把代码文本当 Markdown 再解析一遍 —— 而重推走的是**不保留空白**的 DOMParser，
 * 代码里的换行会全部塌成空格。实测：代码块里只要出现成对反引号
 * （``let a = `x`\nlet b = 2``），一次编辑后整段代码被并成一行（**内容损坏**）。
 */
function isVerbatimBlock(block: PMNode): boolean {
  return block.type.name === 'codeBlock' || block.type.spec.code === true
}

/** 块是否需要归一化：含样式标记、文本匹配手打标记模式（'**x**' 等），或还有反斜杠转义 */
function blockNeedsNormalize(block: PMNode): boolean {
  if (!block.isTextblock) return false
  if (isVerbatimBlock(block)) return false
  let found = false
  block.content.descendants((n) => {
    if (found || !n.isText) return
    // 链接源码展开态文本不参与派生（与 toAtoms 一致）
    if (n.marks.some((m) => m.type.name === 'linkSource')) return
    if (
      n.marks.some(
        (m) => m.type.name === 'mdStyle' || m.type.name === 'mdMarker' || !!LEGACY[m.type.name]
      ) ||
      PATTERN_TEST.test(n.text ?? '') ||
      // 单个「孤儿标记字符」（`$a * b$` 里的那个 `*`）：不成对所以 PATTERN_TEST 不命中，
      // 但若不包成字面量标记，markdown 写出器会给它补反斜杠 → **源码漂移**（`*` → `\*`）。
      // 这正是字面量化（literalizeStrayAtoms）存在的理由：不成对的标记字符也得有
      // `escape:false` 的载体，否则写出器会给它补反斜杠。
      hasStrayMarker(n.text ?? '') ||
      // 反斜杠 + ASCII 标点（`\*`、`\#`…）：要交给带 escape 规则的解析器转成"原样输出"的转义文本。
      // 用「反斜杠 + 标点」而不是「任意反斜杠」做守卫：Windows 路径这类普通反斜杠不会命中，
      // 免得每次按键都对整段做一次 markdown-it 解析。
      ESCAPED_PUNCT_RE.test(n.text ?? '')
    ) {
      found = true
    }
  })
  return found
}

// ─── 显隐（光标感知，PM Decoration 机制）──
export interface MdRun {
  start: number // 构造起点（start 标记首字符）
  end: number // 构造终点（end 标记末字符之后）
  style: StyleKind
  startMarker: [number, number] // start 标记文本区间 [start, start+len)
  endMarker: [number, number] // end 标记文本区间
}

/**
 * 一个块的行内容清单（**块内相对偏移**，块内容起点 = 0）。
 *
 * 为什么按块缓存：装饰（显隐类 + 转义反斜杠的拆分 span）每次事务都要重算，
 * 而它只跟**块的内容**有关。若每键都全文遍历整篇文档（`doc.descendants` + 逐字符扫
 * mark），成本就随文档长度线性增长 —— 实测 100 段文档每键 41ms、400 段 541ms
 * （打字直接卡死，见 tools/_probe-perf.js 的前后对照）。
 *
 * PM 的节点是**不可变 + 结构共享**的：没被这次编辑碰到的块，节点对象**同一个引用**。
 * 所以用 `WeakMap<PMNode, 清单>` 缓存「块 → 清单」是安全且精确的 —— 内容一变就是新
 * 节点，缓存自然失效；位置变化不影响（清单存的是块内相对偏移，绝对位置在遍历时加）。
 */
interface BlockDecos {
  runs: MdRun[]
  escapes: EscapeRun[]
}

/** 块内清单计算（原 collectRuns/collectEscapeRuns 的按块版本，偏移相对块内容起点） */
function blockInventory(block: PMNode): BlockDecos {
  const runs: MdRun[] = []
  const units: EscapeUnit[] = []
  block.content.forEach((child, offset) => {
    if (!child.isText) return
    // ① 标记构造（一对 `**` + 正文）
    const m = child.marks.find((mk) => mk.type.name === 'mdMarker')
    if (m) {
      const cur = runs[runs.length - 1]
      if (m.attrs.side === 'start') {
        // start 已开时忽略新的 start（与旧的 collectRuns 逐字一致）
        if (!cur || cur.end >= 0) {
          runs.push({
            start: offset,
            end: -1, // 占位，配对成功时改写
            style: m.attrs.style as StyleKind,
            startMarker: [offset, offset + child.nodeSize],
            endMarker: [-1, -1]
          })
        }
      } else if (m.attrs.side === 'end' && cur && cur.end === -1) {
        cur.end = offset + child.nodeSize
        cur.endMarker = [offset, offset + child.nodeSize]
      }
    }
    // ② 转义文本单元（`\X`）：同一层 MdEscape 还承担「冗余嵌套强调多出来的那对定界符」
    //    的逐字写回（内容形如 `**`，**没有**反斜杠）—— 那种是字面标记，不是转义。
    if (
      child.text &&
      child.text[0] === '\\' &&
      child.marks.some((mk) => mk.type.name === 'mdEscape')
    ) {
      for (let i = 0; i < child.text.length; i++) {
        if (child.text[i] !== '\\') continue
        const ch = i + 1 < child.text.length ? child.text[i + 1] : null
        units.push({
          bsFrom: offset + i,
          bsTo: offset + i + 1,
          charFrom: ch === null ? null : offset + i + 1,
          charTo: ch === null ? null : offset + i + 2,
          revealable: ch !== null && ASCII_PUNCT.includes(ch)
        })
        i++ // 被转义的那个字符与反斜杠同属一个单元，跳过
      }
    }
  })
  // 只保留真正配好对的构造（end 为 -1 的是孤立 start 标记，不参与显隐）
  const closed = runs.filter((r) => r.end >= 0)
  return { runs: closed, escapes: groupEscapeRuns(units) }
}

/**
 * 收集文档里所有**连续转义段**（显隐的判定单位）。清单从按块的 `blockInventory` 来。
 *
 * 连续判据：后一个单元的反斜杠**紧跟前一个「被转义字符」的末尾**
 * （`\*\*\*\*` 的 8 个字符两两相接 → 1 段 4 个）；中间隔着任何别的字符就断开
 * （`\* \*` 中间有空格 → 2 段，各自独立显隐）。
 * 这与 `.md-marker` 把「一对 `**` + 正文」当作**一个整体**同显同隐是同一个思路，
 * 只是这里的「构造」是一段连续的转义。
 *
 * 跨块不会连：块之间的位置差至少 2（块边界 + 内容起点），而 `charTo` 最大到块内容末尾，
 * 所以按块分组与「全文一起分组」等价（旧实现就是全文一起分组）。
 * 同一块内**跨文本节点**仍能连（PM 未合并的同 mark 相邻文本，位置是相接的）。
 */
function groupEscapeRuns(units: EscapeUnit[]): EscapeRun[] {
  const runs: EscapeRun[] = []
  for (const u of units) {
    const cur = runs[runs.length - 1]
    const prev = cur?.units[cur.units.length - 1]
    if (cur && prev && prev.charTo !== null && prev.charTo === u.bsFrom) {
      cur.units.push(u)
      cur.end = u.charTo ?? u.bsTo
    } else {
      runs.push({ start: u.bsFrom, end: u.charTo ?? u.bsTo, units: [u] })
    }
  }
  return runs
}

/** 一个转义单元：反斜杠 [bsFrom, bsTo) + 被它转义的字面字符 [charFrom, charTo)
    （反斜杠是文本节点最后一个字符时没有「被转义字符」，两个 char 字段为 null；偏移相对块内容起点）。
    revealable = 该单元是不是**真转义**（`\` + ASCII 标点，即 CommonMark 的可转义集合）：
    只有真转义参与「按光标显隐」，其余照旧常显（理由见 pushEscapeDecorations）。 */
interface EscapeUnit {
  bsFrom: number
  bsTo: number
  charFrom: number | null
  charTo: number | null
  revealable: boolean
}

/** 一个「连续转义段」：反斜杠之间只隔着各自的被转义字符（`\*\*\*\*` = 1 段 4 个）。
    偏移同样相对块内容起点。 */
interface EscapeRun {
  start: number
  end: number
  units: EscapeUnit[]
}

/**
 * 选区覆盖的样式构造范围 → 装饰类（光标在构造内/边缘即展开标记）
 *
 * 同时产出**转义反斜杠**的拆分 + 显隐装饰（见 pushEscapeDecorations）：模型里 `\*` 是
 * **一个**文本节点（内容含反斜杠，靠 MdEscape 的 `escape:false` 逐字写回），PM 按 mark
 * 渲染时整段只能落在一个 `<span class="md-escape">` 里 —— 想「只把反斜杠画成暗色、
 * 且按光标显隐」就必须把它的渲染拆开。renderHTML 做不到（一个 mark 的内容洞是连续的），
 * 所以在**装饰层**拆：反斜杠 [pos, pos+1) 一个 span、被转义的字面字符 [pos+1, pos+size)
 * 另一个 span。两者都随 selection 重建（`apply` 里 `docChanged || selectionSet` 时整份重算），
 * 所以转义反斜杠的显隐与 mdMarker 一样是「每次选区变化即时重算」的。
 * 纯观感：`textContent`、模型、落盘字节一个都不动（`data-md-escape` 仍在 mark 的
 * renderHTML 上，解析语义不变）。
 *
 * **性能口径（本轮）**：按块缓存的清单（`blockInventory`）让「内容没变的块」在每次事务里
 * 只花一次 WeakMap 查表；只有被这次编辑改到的块才会重新扫 marks/标记字符。
 * 遍历本身仍是「整篇走一遍 textblock」（PM 的可变树访问，每节点常数开销），但**逐字符扫
 * 标记/转义的线性开销**与**分配**都只发生在变化过的块上。
 * 不改成「只算可见视口」是**故意的**：转义拆分出来的 `.md-escape-backslash`/`.md-escape-char`
 * 是**常显**的渲染结构（不只显隐类），而 PM 的 docView 是惰性构建、滚动不会重建已有视图
 * —— 视口外的块若不带这套装饰，滚过去就会看到「反斜杠直接露在正文里」。宁可多算一点，
 * 也不能让渲染结构随滚动位置变。
 */
function buildRevealDecorations(
  state: EditorState,
  cache: WeakMap<PMNode, BlockDecos>
): DecorationSet {
  const { from, to } = state.selection
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    let inv = cache.get(node)
    if (!inv) {
      inv = blockInventory(node)
      cache.set(node, inv)
    }
    // 清单是块内相对偏移（块内容起点 = pos + 1），这里加回绝对位置
    const base = pos + 1
    for (const r of inv.runs) {
      const rs = base + r.start
      const re = base + r.end
      // 左右边界均含：光标落在正文/标记内或紧贴构造两端（`|**s**`、`**s**|`）
      // 都展开标记（可继续选中/编辑 `*`），完全移入相邻普通文本才折叠
      if (from <= re && to >= rs) {
        decos.push(Decoration.inline(rs, re, { class: 'md-reveal-inline' }))
      }
    }
    pushEscapeDecorations(decos, inv, base, from, to)
  })
  return DecorationSet.create(state.doc, decos)
}

/**
 * 转义文本的拆分 + 显隐装饰：`\X` → 反斜杠 span + 字面字符 span，
 * 反斜杠按光标显隐（与 `.md-marker` **同一套机制、同一判据**）。
 *
 * 只在**真的以反斜杠开头**的转义文本上做（`node.text[0] === '\\'`，见 blockInventory）：同一层
 * `MdEscape` mark 还承担「冗余嵌套强调多出来那对定界符」的逐字写回
 * （`inlineMarkerCore.literalSpan`，内容形如 `**`，**没有**反斜杠）—— 那种是
 * 字面标记，不是转义，不该被画成暗色。
 *
 * 显隐（本轮改动：从「暗色常显」改成「跟 `**` 一样按光标显隐」）：
 *   * 判据与 mdMarker 构造**逐字一致**——
 *     `from <= run.end && to >= run.start`（左右边界均含）：光标/选区落在转义段内，
 *     或紧贴段的两端（`|\*`、`\*|`，与 `|**x**` 同理），都显示；完全移入相邻普通文本才折叠；
 *   * **整段统一判定**：连续转义段的所有 `\` 一起显/隐（`\*\*\*\*` 4 个同进同出），
 *     与「一对 `**` 整体显隐」同理；中间隔字符的 `\* \*` 是两段，各管各的；
 *   * **只有「真转义」（`\` + ASCII 标点）折叠**，非标点的 `\X` 一律常显（带
 *     `.md-reveal-inline` 的「已展开」态）：`C:\Users\x`、`C:\a\b` 这类 Windows 路径
 *     在本应用里也是 MdEscape 文本节点（那是**逐字写回**的载体，不是转义语义），
 *     把它们折叠会让路径在屏幕上少字符（`C:Usersx`）—— 边界取证见套件 H7 与手册 §4.70 六；
 *   * 只给反斜杠 span 加 `.md-reveal-inline`（**同一个元素**上），折叠/显示由
 *     style.css 的 `font-size: 0` / `font-size: inherit` 承担（不用 `display:none`，
 *     否则会破坏光标导航与命中）；`.md-escape-char` 始终正常显示。
 *
 * 纯观感：`textContent`、模型、落盘字节一个都不动（`data-md-escape` 仍由
 * `MdEscape.renderHTML` 承载，解析语义不变）。
 */
function pushEscapeDecorations(
  decos: Decoration[],
  inv: BlockDecos,
  base: number,
  from: number,
  to: number
): void {
  for (const run of inv.escapes) {
    const reveal = from <= base + run.end && to >= base + run.start
    for (const u of run.units) {
      // 真转义：在段内才显示，移出即折叠；非真转义：永远显示（同一个显隐类的「已展开」态）
      const shown = u.revealable ? reveal : true
      decos.push(
        Decoration.inline(base + u.bsFrom, base + u.bsTo, {
          class: shown ? 'md-escape-backslash md-reveal-inline' : 'md-escape-backslash'
        })
      )
      if (u.charFrom !== null && u.charTo !== null) {
        decos.push(
          Decoration.inline(base + u.charFrom, base + u.charTo, { class: 'md-escape-char' })
        )
      }
    }
  }
}

/**
 * 选区（或空选区的光标处）里有没有某种样式。
 *
 * 样式现在是**集合**（`**粗体里的 `代码`**` 上那段代码同时有 bold 与 code），
 * 所以不能再用 `ed.isActive('mdStyle', { style })` 那套「属性相等」判断。
 * 参数类型刻意宽松：宿主传进来的是 Pinia store 里被解包过的编辑器对象，
 * 它与 `@tiptap/core` 的 Editor 类不同构（实例字段在映射类型里丢了），逐成员对齐只会卡住调用方。
 */
export function selectionHasMdStyle(
  ed: { state: unknown; getAttributes(name: string): Record<string, unknown> },
  kind: StyleKind
): boolean {
  try {
    const state = ed.state as EditorState
    const { from, to, empty } = state.selection
    if (empty) return styleList(ed.getAttributes('mdStyle').styles).includes(kind)
    let hit = false
    state.doc.nodesBetween(from, to, (n) => {
      if (hit) return false
      if (
        n.isText &&
        n.marks.some((m) => m.type.name === 'mdStyle' && styleList(m.attrs.styles).includes(kind))
      ) {
        hit = true
        return false
      }
      return true
    })
    return hit
  } catch {
    return false
  }
}

// ─── 命令：样式开关（标记 + 样式同事务写入）──
/**
 * 按节点改写一段范围内的 mdStyle 样式集合：`add` 加入、`remove` 去掉，其余保留。
 *
 * 为什么不能直接用 `tr.addMark` / `tr.removeMark`：PM 里同一种 mark 只能挂一个，
 * `addMark` 是整体覆盖（「粗体里的代码」再加粗体会把 code 顶掉），`removeMark` 是整体清空
 * （取消粗体会把 code 一起清掉）。样式是**集合**，必须按文本节点算并集/差集。
 */
function setStylesOnRange(
  tr: Transaction,
  mdStyle: PMMarkType,
  from: number,
  to: number,
  add: StyleKind | null,
  remove: StyleKind | null
): void {
  if (to <= from) return
  const tasks: { from: number; to: number; styles: StyleKind[] }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    const cur = node.marks.find((m) => m.type.name === 'mdStyle')
    const set = new Set(styleList(cur?.attrs.styles))
    if (add) set.add(add)
    if (remove) set.delete(remove)
    tasks.push({
      from: Math.max(from, pos),
      to: Math.min(to, pos + node.nodeSize),
      styles: styleList([...set])
    })
  })
  for (const t of tasks) {
    if (t.to <= t.from) continue
    if (t.styles.length) tr.addMark(t.from, t.to, mdStyle.create({ styles: t.styles }))
    else tr.removeMark(t.from, t.to, mdStyle)
  }
}

function toggleStyle(
  style: StyleKind
): (props: {
  state: EditorState
  tr: Transaction
  dispatch: (tr: Transaction) => void
}) => boolean {
  return ({ state, tr, dispatch }) => {
    const { from, to, empty } = state.selection
    const mdStyle = state.schema.marks.mdStyle
    const mdMarker = state.schema.marks.mdMarker
    const open = MARKER_OF[style]

    // 选区是否已完全落在此样式的 run 内（含标记）
    let runStart = -1
    let runEnd = -1
    state.doc.nodesBetween(
      Math.max(0, from - 8),
      Math.min(state.doc.content.size, to + 8),
      (node, pos) => {
        if (!node.isText) return
        const sm = node.marks.find(
          (m) => m.type.name === 'mdMarker' && m.attrs.side === 'start' && m.attrs.style === style
        )
        if (sm) runStart = pos
        const em = node.marks.find(
          (m) => m.type.name === 'mdMarker' && m.attrs.side === 'end' && m.attrs.style === style
        )
        if (em) runEnd = pos + node.nodeSize
      }
    )
    const active = runStart >= 0 && runEnd >= 0 && from >= runStart && to <= runEnd

    if (active) {
      // 移除：删两端标记 + 从样式集合里**只去掉这一种**
      tr.delete(runEnd - open.length, runEnd)
      tr.delete(runStart, runStart + open.length)
      const contentFrom = runStart
      const contentTo = runEnd - open.length - open.length
      // 只去掉这一种样式：`**粗体里的 `代码`**` 上取消粗体后，那段代码仍应是行内代码
      setStylesOnRange(tr, mdStyle, contentFrom, contentTo, null, style)
      tr.setSelection(TextSelection.create(tr.doc, Math.max(contentFrom, contentTo)))
      dispatch(tr)
      return true
    }
    if (empty) {
      // 空选区：插入一对标记，光标落中间（`**|**`）。
      // 落点由纯函数 markerPairOffsets 给出（单测钉死）：start 在 from、end 紧跟其后、
      // 光标在两者正中间 —— 归一化管道随后会把这对「空构造」降级成字面标记
      // （CommonMark 不接受空强调），光标由 appendTransaction 的光标保护放回原偏移，
      // 所以三个位置必须一开始就自洽，否则用户会看到光标跳到块尾。
      // 注意本版 PM 的 insertText(text, from, to) 无 marks 参数（marks 取自
      // storedMarks/位置），带标记文本须走 replaceRangeWith 显式构造节点
      const pair = markerPairOffsets(from, open)
      tr.replaceRangeWith(
        pair.start,
        pair.start,
        state.schema.text(open, [mdMarker.create({ style, side: 'start' })])
      )
      tr.replaceRangeWith(
        pair.end,
        pair.end,
        state.schema.text(open, [mdMarker.create({ style, side: 'end' })])
      )
      tr.setSelection(TextSelection.create(tr.doc, pair.caret))
      dispatch(tr)
      return true
    }
    // 应用：包裹选区（光标落在构造内、结束标记之前 → 显隐装饰即时生效）
    const size = state.doc.content.size
    const safeFrom = Math.max(0, Math.min(from, size))
    const safeTo = Math.max(safeFrom, Math.min(to, size))
    const end = safeTo + open.length
    tr.replaceRangeWith(
      safeFrom,
      safeFrom,
      state.schema.text(open, [mdMarker.create({ style, side: 'start' })])
    )
    tr.replaceRangeWith(
      end,
      end,
      state.schema.text(open, [mdMarker.create({ style, side: 'end' })])
    )
    // 样式集合按节点并集写回（不能直接用 addMark：PM 同类型 mark 只能有一个，
    // 直接 add 会把已有的行内代码样式顶掉）
    setStylesOnRange(tr, mdStyle, safeFrom + open.length, end, style, null)
    // 选区保持覆盖正文（气泡菜单不塌缩），光标在构造内（显隐装饰即时生效）
    tr.setSelection(
      TextSelection.create(tr.doc, safeFrom + open.length, Math.min(end, tr.doc.content.size))
    )
    dispatch(tr)
    return true
  }
}

const inlineMarkPluginKey = new PluginKey('typora-inline-marks')

export const TyporaInlineMarks = Extension.create({
  name: 'typoraInlineMarks',
  addCommands() {
    // 运行时平铺返回（CommandManager 直接展开顶层键）；类型经声明合并
    // 命名空间 + UnionToIntersection 拍平为顶层命令
    return {
      toggleMdBold: () => toggleStyle('bold'),
      toggleMdItalic: () => toggleStyle('italic'),
      toggleMdStrike: () => toggleStyle('strike'),
      toggleMdCode: () => toggleStyle('code'),
      /** 全文档归一化（初始加载：解析产物只有遗留 bold 等 mark，无标记文本） */
      normalizeMdMarkers:
        () =>
        ({
          state,
          tr,
          dispatch
        }: {
          state: EditorState
          tr: Transaction
          dispatch: (tr: Transaction) => void
        }) => {
          const blocks: Array<{ pos: number; block: PMNode }> = []
          state.doc.descendants((node, pos) => {
            if (node.isTextblock && blockNeedsNormalize(node)) blocks.push({ pos, block: node })
          })
          let delta = 0
          let changed = false
          for (const { pos, block } of blocks) {
            const cur = pos + delta
            const atoms = toAtoms(block.content)
            const fixed = normalizeAtoms(atoms)
            if (!fixed) continue
            const frag = fromAtoms(fixed, state.schema)
            if (frag.eq(block.content)) continue
            tr.replaceWith(cur + 1, cur + 1 + block.content.size, frag)
            delta += frag.size - block.content.size
            changed = true
          }
          if (changed) dispatch(tr)
          return changed
        }
    } as unknown as Partial<RawCommands>
  },
  addKeyboardShortcuts() {
    return {
      'Mod-b': () => this.editor.commands.toggleMdBold(),
      'Mod-i': () => this.editor.commands.toggleMdItalic(),
      'Mod-Shift-x': () => this.editor.commands.toggleMdStrike(),
      'Mod-e': () => this.editor.commands.toggleMdCode()
    }
  },
  addProseMirrorPlugins() {
    // 源码权威重推的 markdown-it 解析入口：延迟取 tiptap-markdown 的 parser
    // （storage 在编辑器创建时才初始化），与加载/刷新用同一条解析管线
    const htmlParse: ((raw: string) => string) | undefined = (raw) => {
      try {
        const st = (
          this.editor as unknown as {
            storage?: { markdown?: { parser?: { parse: (s: string) => string } } }
          }
        ).storage
        return st?.markdown?.parser ? st.markdown.parser.parse(raw) : ''
      } catch {
        return ''
      }
    }
    // 装饰的**按块清单缓存**（见 buildRevealDecorations）：PM 节点不可变 + 结构共享，
    // 没被编辑碰到的块还是同一个节点对象 ⇒ 清单可以一直复用，不必每键重扫全文。
    const decoCache = new WeakMap<PMNode, BlockDecos>()
    // 归一化的**按块状态缓存**（见 appendTransaction）：块节点对象出现一次就只处理一次。
    // 这是把「每键成本随文档长度线性增长」压回「只跟被编辑的那个块有关」的关键 ——
    // 实测（tools/_probe-perf.js）400 段文档从 541ms/键 降到 <1ms/键。
    const normalizeClean = new WeakMap<PMNode, true>()
    return [
      new Plugin({
        key: inlineMarkPluginKey,
        appendTransaction: (_transactions, _oldState, newState) => {
          try {
            // 没有文档变更 ⇒ 没有任何块需要重新派生（显隐装饰由 state.apply 负责）
            if (!_transactions.some((t) => t.docChanged)) return null
            const tr = newState.tr
            let any = false
            let delta = 0
            // 光标保护：记录选择所在块与块内偏移（统一用 contentPos 域：绝对 - 1）
            const sel = newState.selection
            let caretBlockStart = -1
            let caretOffset = -1
            const $sel = sel.$from
            for (let d = $sel.depth; d > 0; d--) {
              if ($sel.node(d).isTextblock) {
                // `$sel.before(d)` 就是「该文本块之前的位置」——与下面 `descendants` 给出的
                // `pos` 同一个域（`curPos + 1` 才是块内容起点），所以这里**不能**再减一。
                // 减一的话顶层段落会算出 -1：`caretBlockStart >= 0` 的守卫直接不成立，
                // 光标保护整段失效；嵌套块（引用/列表项）则被统一左移一位。后果是
                // 「归一化替换块内容后光标被 PM 映射到被替换区间的末尾」——用户点工具栏
                // 加粗得到 `****|` 而不是 `**|**`，手打 `**` 也会跑到块尾（实测）。
                caretBlockStart = $sel.before(d)
                caretOffset = Math.min(sel.from - $sel.before(d) - 1, $sel.node(d).content.size)
                break
              }
            }
            const blockStarts: number[] = []
            tr.doc.descendants((node, pos) => {
              if (!node.isTextblock) return
              // 这个块节点已经处理过（且处理完是稳定的）⇒ 直接跳过。
              // PM 只重建被编辑路径上的节点，所以「没被碰到的块」引用不变：
              // 一次 WeakMap 查表就够，不必再对它做逐字符的标记扫描/归一化。
              if (normalizeClean.has(node)) return
              if (!blockNeedsNormalize(node)) {
                normalizeClean.set(node, true)
                return
              }
              blockStarts.push(pos)
            })
            for (const blockPos of blockStarts) {
              const curPos = blockPos + delta
              const block = tr.doc.nodeAt(curPos)
              if (!block || !block.isTextblock) continue
              // 常规归一化 + 源码权威重推（与加载/刷新一致的 markdown-it 语义，
              // 消除『实时与刷新不一致』）
              const frag = resolveBlockContent(tr.doc.type.schema, block, htmlParse)
              if (!frag) {
                // 结果与现状一致 ⇒ 这个块节点从此可以跳过（它是稳定态）
                normalizeClean.set(block, true)
                continue
              }
              tr.replaceWith(curPos + 1, curPos + 1 + block.content.size, frag)
              if (curPos === caretBlockStart) {
                const newBlock = tr.doc.nodeAt(curPos)
                caretBlockStart = curPos
                caretOffset = Math.min(
                  caretOffset,
                  Math.max(0, newBlock ? newBlock.content.size : 0)
                )
              }
              delta += frag.size - block.content.size
              any = true
            }
            if (any && caretBlockStart >= 0 && caretOffset >= 0) {
              try {
                // 落点规则见 inlineMarkerCore.blockCaretTarget（单测钉死）
                tr.setSelection(
                  TextSelection.create(
                    tr.doc,
                    blockCaretTarget(
                      caretBlockStart,
                      caretOffset,
                      tr.doc.nodeAt(caretBlockStart)?.content.size ?? caretOffset
                    )
                  )
                )
              } catch {
                /* 落点非法则维持映射结果 */
              }
            }
            return any ? tr : null
          } catch (err) {
            // 护栏：归一化失败绝不让编辑器崩溃（回滚为不追加任何事务）
            if (typeof window !== 'undefined' && typeof console !== 'undefined') {
              console.error('[mdStyle normalize] skipped:', err)
            }
            return null
          }
        },
        state: {
          init: (_config, state) => buildRevealDecorations(state, decoCache),
          apply: (tr, oldSet, _oldState, newState) => {
            if (tr.docChanged || tr.selectionSet) return buildRevealDecorations(newState, decoCache)
            return oldSet
          }
        },
        props: {
          decorations(state) {
            return this.getState(state)
          }
        }
      })
    ]
  }
})
