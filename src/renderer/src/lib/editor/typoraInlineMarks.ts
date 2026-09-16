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

export type StyleKind = 'bold' | 'italic' | 'strike' | 'code'

/**
 * 样式嵌套顺序（外 → 内）。同一段文本可以同时是粗体与行内代码（`**粗体里的 `代码`**`），
 * 而 PM 里**一种 mark 只能挂一个**，所以样式的唯一载体是 `mdStyle` 的 `styles` **集合**；
 * 集合按这个固定顺序排列，标记文本的物化与 DOM 呈现都照它来 —— 顺序固定才能保证
 * 「同一份文档每次解析/序列化都得到同一串标记」（幂等是保真套件的硬门槛）。
 */
export const STYLE_ORDER: readonly StyleKind[] = ['bold', 'strike', 'italic', 'code']

const TAG_OF: Record<StyleKind, string> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code'
}

/** 样式集合规范化：去重 + 按 STYLE_ORDER 排序（非法值丢弃；空集合表示「无样式」） */
export function styleList(input: unknown): StyleKind[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : []
  const set = new Set<string>()
  for (const s of raw) if (typeof s === 'string' && s) set.add(s)
  return STYLE_ORDER.filter((s) => set.has(s))
}

const MARKER_OF: Record<StyleKind, string> = { bold: '**', italic: '*', strike: '~~', code: '`' }
const KIND_OF_MARKER: Record<string, StyleKind> = {
  '**': 'bold',
  '*': 'italic',
  '~~': 'strike',
  '`': 'code'
}
const LEGACY: Record<string, StyleKind> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
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
    return { markdown: { serialize: { open: () => '', close: () => '', escape: false } } }
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
/** 孤儿标记字符（`*`/`~`/`` ` `` 任意出现，包括不成对的那种） */
const STRAY_MARKER_RE = /[*~`]/

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
export type MarkerSide = 'start' | 'end' | 'literal'

interface Atom {
  kind: 'text' | 'marker' | 'break' | 'other'
  text?: string
  /** 原文照写（反斜杠转义）：不参与标记派生，序列化时原样输出 */
  verbatim?: boolean
  marker?: { style: StyleKind; side: MarkerSide }
  /** 该段文本的样式集合（外→内，已规范化）。空/缺省 = 无样式 */
  styles?: StyleKind[]
  otherMarks?: PMMark[]
  node?: PMNode
}

/** 原子的样式集合（规范化副本；无样式返回空数组） */
function stylesOf(a: Atom): StyleKind[] {
  return a.styles && a.styles.length ? styleList(a.styles) : []
}

/** 两个原子的样式集合是否相同 */
function sameStyles(a: Atom, b: Atom): boolean {
  const x = stylesOf(a)
  const y = stylesOf(b)
  return x.length === y.length && x.every((s, i) => s === y[i])
}

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
      //  实测 `$a * b$` 会被 `literalizeStrayMarkers` 从中间切开，公式碎成两段）。
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

/** 行内标记模式（任意位置；打字后与相邻文本合并为同一文本节点）。
    - '**' / '~~' / '`' 分支内容允许除换行外的任意字符（惰性，取最近闭合）；
    - 单 '*' 分支用 lookbehind/lookahead 排除与相邻 '*' 成对的情况——
      输入到一半的 '**5*' 不会被误切成 '*5*' 斜体（否则打完第五个
      '*' 会得到错乱的字面量/样式）。 */
const PATTERN = /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|~~([^~\n]+?)~~|`([^`\n]+?)`/g
const PATTERN_TEST = /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|~~([^~\n]+?)~~|`([^`\n]+?)`/

/** 识别「标记文本 + 正文 + 配对标记文本」模式（用户手打语法）。
    文本节点内任意位置扫描（'段落。**加粗**' 是同一节点），
    匹配处拆为 标记/样式正文/标记 三个原子。 */
function recognizeTypedMarkers(atoms: Atom[]): void {
  const out: Atom[] = []
  for (const a of atoms) {
    if (a.kind !== 'text' || stylesOf(a).length || a.marker || a.verbatim || !a.text) {
      out.push(a)
      continue
    }
    const text = a.text
    const pieces: Atom[] = []
    let last = 0
    PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATTERN.exec(text)) !== null) {
      let markerText = ''
      let content = ''
      let style: StyleKind | null = null
      if (m[1] !== undefined) {
        markerText = m[1]
        content = m[2]
        style = 'bold'
      } else if (m[3] !== undefined) {
        markerText = '*'
        content = m[3]
        style = 'italic'
      } else if (m[4] !== undefined) {
        markerText = '~~'
        content = m[4]
        style = 'strike'
      } else if (m[5] !== undefined) {
        markerText = '`'
        content = m[5]
        style = 'code'
      }
      if (!style || content.length === 0) continue
      if (m.index > last) {
        pieces.push({ kind: 'text', text: text.slice(last, m.index), otherMarks: a.otherMarks })
      }
      pieces.push({ kind: 'marker', text: markerText, marker: { style, side: 'start' } })
      pieces.push({ kind: 'text', text: content, styles: [style], otherMarks: a.otherMarks })
      pieces.push({ kind: 'marker', text: markerText, marker: { style, side: 'end' } })
      last = m.index + m[0].length
    }
    if (last === 0) {
      out.push(a)
      continue
    }
    if (last < text.length) {
      pieces.push({ kind: 'text', text: text.slice(last), otherMarks: a.otherMarks })
    }
    out.push(...pieces)
  }
  atoms.splice(0, atoms.length, ...out)
}

/** 修复被光标边界打字"污染"的标记文本：光标紧贴构造起点（`|**5**`）打字时，
    新字符会继承右侧 mdMarker 的 mark，与起始标记文本合并成同一节点（如 `2**`）；
    同理构造末尾（`**5**|`）打字会得到 `**2`。此时两侧标记文本不配对，归一化
    会误判为「不成对 → 整段字面量」，导致渲染失粗且需刷新才恢复。这里把粘连在
    标记外侧的多余字符拆回普通文本，只保留干净的标记本体。 */
function repairPollutedMarkers(atoms: Atom[]): boolean {
  let changed = false
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]
    if (a.kind !== 'marker' || !a.marker || !a.text) continue
    const side = a.marker.side
    if (side === 'literal') continue
    const canonical = MARKER_OF[a.marker.style]
    if (!canonical || a.text === canonical) continue
    const idx = side === 'start' ? a.text.lastIndexOf(canonical) : a.text.indexOf(canonical)
    if (idx < 0) continue
    const before = a.text.slice(0, idx)
    const after = a.text.slice(idx + canonical.length)
    // 标记本体中间还夹着字符（如在两颗星之间键入）→ 保持现状，交给字面量兜底
    if (side === 'start' && after) continue
    if (side === 'end' && before) continue
    const parts: Atom[] = []
    if (before) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'marker', text: canonical, marker: { ...a.marker, side } })
    if (after) parts.push({ kind: 'text', text: after })
    atoms.splice(i, 1, ...parts)
    i += parts.length - 1
    changed = true
  }
  return changed
}

/** 字面量标记「配对重提升」：字面量（side:'literal'）只是「当时不成对」的过渡态
    ——当两侧字面量标记在编辑/合并后重新围住一段无样式正文（如回车切段后再
    Backspace 合并成 `**` + `5` + `**`），应立即重新识别为样式构造（start/正文
    mdStyle/end），而不是永远停留在可见字面量、等刷新才恢复。
    仅在：起止原子都是字面量标记、文本等于某可识别标记（'**'/'*'/'~~'/'`'）且
    相等、中间只夹无样式正文原子、整段组合文本与完整构造模式完全吻合时触发。 */
function reLiftLiteralPairs(atoms: Atom[]): boolean {
  let changed = false
  let i = 0
  while (i < atoms.length) {
    const open = atoms[i]
    const openTxt =
      open.kind === 'marker' && open.marker?.side === 'literal' ? (open.text ?? '') : ''
    const kind = KIND_OF_MARKER[openTxt]
    if (!kind) {
      i++
      continue
    }
    // 收集中间的无样式正文（原子边界内不允许夹带其他标记/样式/块节点）
    let contentText = ''
    let contentOther: PMMark[] | undefined
    let j = i + 1
    for (; j < atoms.length; j++) {
      const a = atoms[j]
      if (a.kind === 'marker') {
        // 到达配对字面量：整体必须能被完整模式识别才转换
        if (a.marker?.side === 'literal' && (a.text ?? '') === openTxt) break
        // 中间出现其他标记 → 无法配对，放弃本窗口
        contentText = ''
        break
      }
      if (a.kind === 'text') {
        if (stylesOf(a).length) {
          // 正文已有样式 → 说明不是退化构造，跳过
          contentText = ''
          break
        }
        contentText += a.text ?? ''
        contentOther = contentOther ?? a.otherMarks
        continue
      }
      contentText = ''
      break
    }
    const close = contentText !== '' && j < atoms.length ? atoms[j] : null
    if (!close) {
      i++
      continue
    }
    // 整窗文本必须与 PATTERN 的完整构造一致（m.index=0 且整段匹配），
    // 防 `**a*b**` 这类跨内容误配
    const windowText = openTxt + contentText + openTxt
    PATTERN.lastIndex = 0
    const m = PATTERN.exec(windowText)
    const full = m && m.index === 0 && m[0] === windowText
    const mKind = m
      ? m[1] !== undefined
        ? 'bold'
        : m[3] !== undefined
          ? 'italic'
          : m[4] !== undefined
            ? 'strike'
            : m[5] !== undefined
              ? 'code'
              : ''
      : ''
    if (!full || mKind !== kind) {
      i++
      continue
    }
    const repl: Atom[] = [
      { kind: 'marker', text: openTxt, marker: { style: kind, side: 'start' as const } },
      { kind: 'text', text: contentText, styles: [kind], otherMarks: contentOther },
      { kind: 'marker', text: openTxt, marker: { style: kind, side: 'end' as const } }
    ]
    atoms.splice(i, j - i + 1, ...repl)
    i += 3
    changed = true
  }
  return changed
}

/** 单块内联序列归一化：返回修复后的原子列表（未变化返回 null）。
    语义（CommonMark 对齐，标记文本即源码真值）：
    - 两侧标记配对且可识别 → 以标记文本决定样式（'**'→粗、'*'→斜…），
      内容样式与其不一致时重派；
    - 两侧标记不配对 / 不可识别（如 '**5*'、回车切段把标记劈开）→ 整段
      退化为字面量：内容去样式、标记降级为 side:'literal' 的可见字符
      （保留 mdMarker mark 以原样序列化，源码不出现 '\*' 转义）；
    - 带样式内容缺一侧标记（回车切段/粘贴产物）→ 按标记文本补齐；
    - 无任何标记的纯样式正文（legacy/历史）→ 补全两侧标记；
    - 孤立标记 → 降级为字面量（同样原样序列化）。 */
function normalizeAtoms(atoms: Atom[]): Atom[] | null {
  const countBefore = atoms.length
  let changed = reLiftLiteralPairs(atoms)
  changed = repairPollutedMarkers(atoms) || changed
  recognizeTypedMarkers(atoms)
  // 手打模式识别会拆分原子（1 → 3+），其改动也算变化
  changed = changed || atoms.length !== countBefore
  const out = atoms.slice()
  let i = 0
  while (i < out.length) {
    const a = out[i]
    if (a.kind === 'marker' && a.marker?.side === 'literal') {
      i++ // 字面量标记保持原样
      continue
    }
    if (a.kind === 'marker' && a.marker?.side === 'start') {
      const runStyle = a.marker.style
      const startText = a.text ?? ''
      // 找本 start 的配对 end：**跳过内层嵌套构造**（深度计数），否则
      // `**粗体里的 `代码` 一样**` 会被当成「缺 end」而在内层标记后补一个 `**`，
      // 把外层构造劈成两个 —— 正是嵌套样式被写坏的那一步。
      let j = i + 1
      let depth = 0
      for (; j < out.length; j++) {
        const b = out[j]
        if (b.kind === 'marker') {
          const side = b.marker?.side
          if (side === 'start') depth++
          else if (side === 'end') {
            if (depth === 0) break
            depth--
          }
        } else if (b.kind !== 'text') break // 块节点/换行：构造被劈开
      }
      const closed = j < out.length && out[j].kind === 'marker' && out[j].marker?.side === 'end'
      const hasContent = depth === 0 && j > i + 1
      const endMarker = closed ? out[j] : null
      const endText = endMarker?.text ?? ''

      /** 外层样式必须出现在**所有**内容文本上（含嵌套构造里的正文）。 */
      const applyOuter = (desired: StyleKind): void => {
        for (let k = i + 1; k < j; k++) {
          const b = out[k]
          if (b.kind !== 'text' || !b.text) continue
          const want = styleList([desired, ...stylesOf(b)])
          if (!sameStyles(b, { kind: 'text', styles: want })) {
            out[k] = { ...b, styles: want }
            changed = true
          }
        }
      }

      if (hasContent && endMarker) {
        // 两侧标记齐全：以标记文本为准
        if (startText === endText && !!KIND_OF_MARKER[startText]) {
          const desired = KIND_OF_MARKER[startText]
          applyOuter(desired)
          if (desired !== runStyle) {
            out[i] = { ...a, marker: { style: desired, side: 'start' } }
            changed = true
          }
        } else {
          // 不配对（如 '**5*'）→ 整段字面量
          for (let k = i + 1; k < j; k++) out[k] = { ...out[k], styles: undefined }
          out[i] = toLiteral(a)
          out[j] = toLiteral(endMarker)
          changed = true
        }
        i = j + 1
        continue
      }
      if (hasContent && !endMarker) {
        // 缺 end 标记（回车切段产物）→ 按起始标记补齐继续该样式
        const desired = KIND_OF_MARKER[startText]
        if (desired) {
          applyOuter(desired)
          out.splice(j, 0, {
            kind: 'marker',
            text: startText,
            marker: { style: desired, side: 'end' }
          })
          changed = true
          i = j + 2
          continue
        }
        // 起始标记不可识别 → 内容去样式 + 起始标记字面量
        for (let k = i + 1; k < j; k++) out[k] = { ...out[k], styles: undefined }
        out[i] = toLiteral(a)
        changed = true
        i = j
        continue
      }
      // 孤立 start 标记（无内容）→ 字面量
      out[i] = toLiteral(a)
      changed = true
      i = i + 1
      continue
    }
    if (a.kind === 'text' && stylesOf(a).length) {
      // 「一组」= 连续的带样式文本原子 + 夹在其中的不透明行内内容（行内 HTML / 链接源码）；
      // 样式各不相同就说明存在**嵌套**
      let j = i
      while (j < out.length && isRunPart(out[j])) j++
      const prevMarker =
        i > 0 && out[i - 1].kind === 'marker' && out[i - 1].marker?.side === 'start'
      if (prevMarker) {
        i = j // 构造内容已由 start 分支处理
        continue
      }
      const next = j < out.length ? out[j] : null
      const uniform = out.slice(i, j).every((x) => x.kind !== 'text' || sameStyles(x, a))
      const runStyle = stylesOf(a)[0]
      if (uniform && next && next.kind === 'marker' && next.marker?.side === 'end') {
        const endText = next.text ?? ''
        if (endText === MARKER_OF[runStyle]) {
          // 样式正文缺 start（切段到新块）→ 补齐 start
          out.splice(i, 0, {
            kind: 'marker',
            text: endText,
            marker: { style: runStyle, side: 'start' }
          })
          changed = true
          i = j + 2
          continue
        }
        // end 标记文本与样式不符 → 内容去样式 + end 标记字面量
        for (let k = i; k < j; k++) out[k] = { ...out[k], styles: undefined }
        out[j] = toLiteral(next)
        changed = true
        i = j + 1
        continue
      }
      // 无任何标记的样式正文（legacy/历史/粘贴/嵌套）→ 按**样式栈**物化标记。
      // 单一样式时它退化成「两边各一对」的老行为；一段文本带多个样式（如「粗体里的行内代码」）
      // 时才写出嵌套的标记 —— 按单个样式各补一对会让外层构造在内层之前合上，
      // 产出 `**a **`b`** c**` 这种 CommonMark 下根本不成立的孤儿标记（渲染直接坏掉）。
      const n = materializeStyledRun(out, i)
      changed = true
      i = i + n
      continue
    }
    if (a.kind === 'marker') {
      // 孤立 end/未知标记 → 字面量
      out[i] = toLiteral(a)
      changed = true
      i = i + 1
      continue
    }
    i++
  }
  return changed ? out : null
}

/**
 * 把「一段没有任何标记的样式正文」按**样式栈**物化成标记序列（原地替换 out[i..j)）。
 *
 * 输入形如（一段解析产物）：`a`[bold] `b`[bold,code] `c`[bold]
 * 输出：`**` `a` `` ` `` `b` `` ` ` `` `` ` `` `c` `**`
 * ——前后两段的样式集合取公共前缀（bold）保持不动，只开关差集（code），于是标记是嵌套的。
 * 每段的样式集合本身按 STYLE_ORDER 规范化过，所以同一份文档每次物化得到同一串标记（幂等）。
 *
 * @returns 物化后的原子个数
 */
function materializeStyledRun(out: Atom[], from: number): number {
  const active: StyleKind[] = []
  const ins: Atom[] = []
  const openMarker = (s: StyleKind): Atom => ({
    kind: 'marker',
    text: MARKER_OF[s],
    marker: { style: s, side: 'start' }
  })
  const closeMarker = (s: StyleKind): Atom => ({
    kind: 'marker',
    text: MARKER_OF[s],
    marker: { style: s, side: 'end' }
  })
  let j = from
  while (j < out.length && isRunPart(out[j])) j++
  for (let k = from; k < j; k++) {
    const atom = out[k]
    // 不透明内容（行内 HTML 原文、展开态的链接源码）：夹在样式正文里也要**保持外层构造不闭合**
    // ——「**加粗里的 <kbd>Ctrl</kbd> 还是加粗**」；它自己不参与样式栈
    if (!stylesOf(atom).length) {
      ins.push(atom)
      continue
    }
    const want = stylesOf(atom)
    let p = 0
    while (p < active.length && p < want.length && active[p] === want[p]) p++
    for (let d = active.length - 1; d >= p; d--) ins.push(closeMarker(active[d]))
    for (let d = p; d < want.length; d++) ins.push(openMarker(want[d]))
    active.length = p
    active.push(...want.slice(p))
    ins.push(atom)
  }
  for (let d = active.length - 1; d >= 0; d--) ins.push(closeMarker(active[d]))
  out.splice(from, j - from, ...ins)
  return ins.length
}

/** 一段「样式构造」能包住哪些原子：带样式的正文，以及夹在其中的不透明行内内容 */
function isRunPart(a: Atom): boolean {
  if (a.kind === 'text' && a.text && stylesOf(a).length) return true
  return a.kind === 'other'
}

/** 把构造标记原子降级为字面量标记（side:'literal'，原样序列化 + 可见字符） */
function toLiteral(atom: Atom): Atom {
  return {
    kind: 'marker',
    text: atom.text ?? '',
    marker: { style: atom.marker?.style ?? 'bold', side: 'literal' }
  }
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

/** 把解析产物里“未被样式消费”的裸标记字符（* ~ `）包成字面量标记：
    它们不是样式语法（CommonMark 解析为普通字符），但若不包一层
    mdMarker(literal)（序列化 escape:false），markdown 写出器会给普通文本里
    的 `*` 加反斜杠转义 → 源码漂移（`**5*` 变 `\**5*`）。字面量标记让这些
    字符原样输出且可见，与"标记文本即源码真值"模型一致。 */
function literalizeStrayMarkers(frag: Fragment, schema: EditorState['schema']): Fragment {
  const mdMarker = schema.marks.mdMarker
  const nodes: PMNode[] = []
  frag.forEach((node) => {
    if (
      !node.isText ||
      node.marks.some(
        (m) =>
          m.type.name === 'mdStyle' ||
          m.type.name === 'mdMarker' ||
          m.type.name === 'mdEscape' ||
          // 行内 HTML / 公式原文：靠各自的 `escape:false` 原样输出，
          // 包成字面量标记反而会被当源码再解析（公式还会被从中间切开）
          m.type.name === 'mdHtml' ||
          m.type.name === 'mdMath'
      )
    ) {
      nodes.push(node)
      return
    }
    const chars = node.text ?? ''
    let plain = ''
    let stray = ''
    const flush = (): void => {
      if (stray) {
        nodes.push(schema.text(stray, [mdMarker.create({ style: 'bold', side: 'literal' })]))
        stray = ''
      }
      if (plain) {
        nodes.push(schema.text(plain, node.marks))
        plain = ''
      }
    }
    for (const ch of chars) {
      if (ch === '*' || ch === '~' || ch === '`') {
        if (plain) flush()
        stray += ch
      } else {
        if (stray) flush()
        plain += ch
      }
    }
    flush()
  })
  return Fragment.fromArray(nodes)
}

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
    交给 normalizeAtoms 的「legacy → 补全两侧标记」分支。 */
function resolveBlockContent(
  schema: EditorState['schema'],
  block: PMNode,
  htmlParse: ((raw: string) => string) | undefined
): Fragment | null {
  const current = block.content
  const atoms = toAtoms(current)
  const fixed = normalizeAtoms(atoms)

  // 触发重推的条件：文本里还有**标记字符或反斜杠转义**（后者见 MdEscape：
  // 用户手打的 `\*` / `\#` 要靠重推走一遍带 escape 规则的解析器，才能变成"原样输出"的转义文本）
  if (htmlParse && !hasLegacyInlineMark(block) && /[*~`\\]/.test(block.textContent)) {
    // 仅对“纯行内文本”（无子块/链接/图片）重推——链接的真实源码不在文本里
    let pure = true
    current.forEach((c) => {
      if (!c.isText || c.marks.some((m) => m.type.name === 'link' || m.type.name === 'linkSource'))
        pure = false
    })
    if (pure) {
      try {
        const inline = parseInlineHtml(schema, htmlParse(block.textContent))
        if (inline) {
          const atoms2 = toAtoms(inline.content)
          const f2 = normalizeAtoms(atoms2)
          const frag2 = literalizeStrayMarkers(fromAtoms(f2 ?? atoms2, schema), schema)
          if (!frag2.eq(current)) return frag2
        }
      } catch {
        /* 解析失败 → 回退常规归一化 */
      }
    }
  }

  if (!fixed) return null
  const frag = fromAtoms(fixed, schema)
  return frag.eq(current) ? null : frag
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
      // 这正是 literalizeStrayMarkers 存在的理由，只是此前漏了「不成对」这一档。
      STRAY_MARKER_RE.test(n.text ?? '') ||
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

/** 收集所有「start 标记 + 样式正文 + end 标记」构造（含标记字符区间） */
function collectRuns(doc: EditorState['doc']): MdRun[] {
  const runs: MdRun[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    let start = -1
    let startMarkerEnd = -1
    let style: StyleKind | null = null
    node.content.forEach((child, offset) => {
      const abs = pos + 1 + offset
      if (!child.isText) return
      const m = child.marks.find((mk) => mk.type.name === 'mdMarker')
      if (!m) return
      if (m.attrs.side === 'start' && start < 0) {
        start = abs
        startMarkerEnd = abs + child.nodeSize
        style = m.attrs.style as StyleKind
      } else if (m.attrs.side === 'end' && start >= 0) {
        runs.push({
          start,
          end: abs + child.nodeSize,
          style: style ?? 'bold',
          startMarker: [start, startMarkerEnd],
          endMarker: [abs, abs + child.nodeSize]
        })
        start = -1
        startMarkerEnd = -1
        style = null
      }
    })
  })
  return runs
}

/**
 * 选区覆盖的样式构造范围 → 装饰类（光标在构造内/边缘即展开标记）
 */
function buildRevealDecorations(state: EditorState): DecorationSet {
  const { from, to } = state.selection
  const decos: Decoration[] = []
  for (const r of collectRuns(state.doc)) {
    // 左右边界均含：光标落在正文/标记内或紧贴构造两端（`|**s**`、`**s**|`）
    // 都展开标记（可继续选中/编辑 `*`），完全移入相邻普通文本才折叠
    if (from <= r.end && to >= r.start) {
      decos.push(Decoration.inline(r.start, r.end, { class: 'md-reveal-inline' }))
    }
  }
  return DecorationSet.create(state.doc, decos)
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
      // 空选区：插入一对标记，光标落中间。
      // 注意本版 PM 的 insertText(text, from, to) 无 marks 参数（marks 取自
      // storedMarks/位置），带标记文本须走 replaceRangeWith 显式构造节点
      tr.replaceRangeWith(
        from,
        from,
        state.schema.text(open, [mdMarker.create({ style, side: 'start' })])
      )
      tr.replaceRangeWith(
        from + open.length,
        from + open.length,
        state.schema.text(open, [mdMarker.create({ style, side: 'end' })])
      )
      tr.setSelection(TextSelection.create(tr.doc, from + open.length))
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
    return [
      new Plugin({
        key: inlineMarkPluginKey,
        appendTransaction: (_transactions, _oldState, newState) => {
          try {
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
                caretBlockStart = $sel.before(d) - 1
                caretOffset = Math.min(sel.from - $sel.before(d) - 1, $sel.node(d).content.size)
                break
              }
            }
            const blockStarts: number[] = []
            tr.doc.descendants((node, pos) => {
              if (node.isTextblock && blockNeedsNormalize(node)) blockStarts.push(pos)
            })
            for (const blockPos of blockStarts) {
              const curPos = blockPos + delta
              const block = tr.doc.nodeAt(curPos)
              if (!block || !block.isTextblock) continue
              // 常规归一化 + 源码权威重推（与加载/刷新一致的 markdown-it 语义，
              // 消除『实时与刷新不一致』）
              const frag = resolveBlockContent(tr.doc.type.schema, block, htmlParse)
              if (!frag) continue
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
                tr.setSelection(TextSelection.create(tr.doc, caretBlockStart + 1 + caretOffset))
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
          init: (_config, state) => buildRevealDecorations(state),
          apply: (tr, oldSet, _oldState, newState) => {
            if (tr.docChanged || tr.selectionSet) return buildRevealDecorations(newState)
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
