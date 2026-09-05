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
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model'

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

const MARKER_OF: Record<StyleKind, string> = { bold: '**', italic: '*', strike: '~~', code: '`' }
const KIND_OF_MARKER: Record<string, StyleKind> = { '**': 'bold', '*': 'italic', '~~': 'strike', '`': 'code' }
const LEGACY: Record<string, StyleKind> = { bold: 'bold', italic: 'italic', strike: 'strike', code: 'code' }

export const MdStyle = Mark.create({
  name: 'mdStyle',
  addAttributes() {
    return { style: { default: 'bold' } }
  },
  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes.style as StyleKind
    const tag = kind === 'bold' ? 'strong' : kind === 'italic' ? 'em' : kind === 'strike' ? 's' : 'code'
    return [tag, { 'data-md-style': kind }, 0]
  },
  parseHTML() {
    // DOM → 文档回读必须还原 mdStyle（否则 PM 的 DOMObserver 把渲染后的
    // <strong> 解析成 legacy bold，与文档比对不一致 → readDOMChange 回写循环）
    return [
      { tag: 'strong[data-md-style="bold"]', priority: 60, getAttrs: () => ({ style: 'bold' }) },
      { tag: 'em[data-md-style="italic"]', priority: 60, getAttrs: () => ({ style: 'italic' }) },
      { tag: 's[data-md-style="strike"]', priority: 60, getAttrs: () => ({ style: 'strike' }) },
      { tag: 'code[data-md-style="code"]', priority: 60, getAttrs: () => ({ style: 'code' }) }
    ]
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

// ─── 归一化 ───
export type MarkerSide = 'start' | 'end' | 'literal'

interface Atom {
  kind: 'text' | 'marker' | 'break' | 'other'
  text?: string
  marker?: { style: StyleKind; side: MarkerSide }
  style?: StyleKind
  otherMarks?: PMMark[]
  node?: PMNode
}

function toAtoms(frag: Fragment): Atom[] {
  const atoms: Atom[] = []
  frag.forEach((n) => {
    if (n.isText) {
      // 链接源码展开态（[文字](网址)，pointer.ts linkSource）视为不透明文本：
      // 归一化不得扫描其内容（否则会把源码里的 `**` 误派生为样式标记）
      if (n.marks.some((m) => m.type.name === 'linkSource')) {
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
      const st = n.marks.find((m) => m.type.name === 'mdStyle' || !!LEGACY[m.type.name])
      const other = n.marks.filter((m) => m !== st)
      if (st) {
        const style = st.type.name === 'mdStyle' ? (st.attrs.style as StyleKind) : LEGACY[st.type.name]
        atoms.push({ kind: 'text', text: n.text, style, otherMarks: other })
      } else {
        atoms.push({ kind: 'text', text: n.text, otherMarks: other })
      }
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
const PATTERN =
  /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|\~\~([^~\n]+?)\~\~|\`([^`\n]+?)\`/g
const PATTERN_TEST =
  /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|\~\~([^~\n]+?)\~\~|\`([^`\n]+?)\`/

/** 识别「标记文本 + 正文 + 配对标记文本」模式（用户手打语法）。
    文本节点内任意位置扫描（'段落。**加粗**' 是同一节点），
    匹配处拆为 标记/样式正文/标记 三个原子。 */
function recognizeTypedMarkers(atoms: Atom[]): void {
  const out: Atom[] = []
  for (const a of atoms) {
    if (a.kind !== 'text' || a.style || a.marker || !a.text) {
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
      pieces.push({ kind: 'text', text: content, style, otherMarks: a.otherMarks })
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
    const openTxt = open.kind === 'marker' && open.marker?.side === 'literal' ? open.text ?? '' : ''
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
        if (a.style) {
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
    const mKind = m ? (m[1] !== undefined ? 'bold' : m[3] !== undefined ? 'italic' : m[4] !== undefined ? 'strike' : m[5] !== undefined ? 'code' : '') : ''
    if (!full || mKind !== kind) {
      i++
      continue
    }
    const repl: Atom[] = [
      { kind: 'marker', text: openTxt, marker: { style: kind, side: 'start' as const } },
      { kind: 'text', text: contentText, style: kind, otherMarks: contentOther },
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
      // 构造内容：紧跟的连续同样式文本
      let j = i + 1
      while (j < out.length && out[j].kind === 'text' && out[j].style === runStyle) j++
      const hasContent = j > i + 1
      const endMarker =
        j < out.length && out[j].kind === 'marker' && out[j].marker?.side === 'end' ? out[j] : null
      const endText = endMarker?.text ?? ''

      if (hasContent && endMarker) {
        // 两侧标记齐全：以标记文本为准
        if (startText === endText && !!KIND_OF_MARKER[startText]) {
          const desired = KIND_OF_MARKER[startText]
          if (desired !== runStyle) {
            for (let k = i + 1; k < j; k++) out[k] = { ...out[k], style: desired }
            changed = true
          }
        } else {
          // 不配对（如 '**5*'）→ 整段字面量
          for (let k = i + 1; k < j; k++) out[k] = { ...out[k], style: undefined }
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
          if (desired !== runStyle) {
            for (let k = i + 1; k < j; k++) out[k] = { ...out[k], style: desired }
          }
          out.splice(j, 0, { kind: 'marker', text: startText, marker: { style: desired, side: 'end' } })
          changed = true
          i = j + 2
          continue
        }
        // 起始标记不可识别 → 内容去样式 + 起始标记字面量
        for (let k = i + 1; k < j; k++) out[k] = { ...out[k], style: undefined }
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
    if (a.kind === 'text' && a.style) {
      const runStyle = a.style
      let j = i + 1
      while (j < out.length && out[j].kind === 'text' && out[j].style === runStyle) j++
      const prevMarker = i > 0 && out[i - 1].kind === 'marker' && out[i - 1].marker?.side === 'start'
      const next = j < out.length ? out[j] : null
      if (prevMarker) {
        i = j // 构造内容已由 start 分支处理
        continue
      }
      if (next && next.kind === 'marker' && next.marker?.side === 'end') {
        const endText = next.text ?? ''
        if (endText === MARKER_OF[runStyle]) {
          // 样式正文缺 start（切段到新块）→ 补齐 start
          out.splice(i, 0, { kind: 'marker', text: endText, marker: { style: runStyle, side: 'start' } })
          changed = true
          i = j + 2
          continue
        }
        // end 标记文本与样式不符 → 内容去样式 + end 标记字面量
        for (let k = i; k < j; k++) out[k] = { ...out[k], style: undefined }
        out[j] = toLiteral(next)
        changed = true
        i = j + 1
        continue
      }
      // 无任何标记的纯样式正文（legacy/历史/粘贴）→ 补全两侧标记
      out.splice(i, 0, { kind: 'marker', text: MARKER_OF[runStyle], marker: { style: runStyle, side: 'start' } })
      j++
      out.splice(j, 0, { kind: 'marker', text: MARKER_OF[runStyle], marker: { style: runStyle, side: 'end' } })
      changed = true
      i = j + 1
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
      nodes.push(schema.text(a.text, [mdMarker.create({ style: a.marker.style, side: a.marker.side })]))
    } else if (a.kind === 'text') {
      if (!a.text) continue
      const marks = [...(a.otherMarks ?? [])]
      if (a.style) marks.push(mdStyle.create({ style: a.style }))
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
    if (!node.isText || node.marks.some((m) => m.type.name === 'mdStyle' || m.type.name === 'mdMarker')) {
      nodes.push(node)
      return
    }
    const chars = node.text ?? ''
    let plain = ''
    let stray = ''
    const flush = () => {
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

/** 单块最终结构：常规原子归一化 + 「源码权威重推」。
    ——为什么需要重推：实时编辑产生的边缘源码（如 `**5*`、删掉 `*5*` 的收尾
    `*`）与 markdown-it 的解析语义可能不同（`**5*` 会被解析为 字面 `*` + 斜体
    `5`）。若不重推，这类结构要等“刷新（重新从源码解析）”才显示正确——即用户
    遇到的『实时渲染滞后』。这里对纯行内文本块，把它的原文喂给与加载相同的
    markdown-it 解析器，把解析结果经同一归一化转成标记模型，优先采用（差异
    时才替换，稳定态零开销）；解析不可用/不适用时回退常规归一化。 */
function resolveBlockContent(
  schema: EditorState['schema'],
  block: PMNode,
  htmlParse: ((raw: string) => string) | undefined
): Fragment | null {
  const current = block.content
  const atoms = toAtoms(current)
  const fixed = normalizeAtoms(atoms)

  if (htmlParse && /[*~`]/.test(block.textContent)) {
    // 仅对“纯行内文本”（无子块/链接/图片）重推——链接的真实源码不在文本里
    let pure = true
    current.forEach((c) => {
      if (!c.isText || c.marks.some((m) => m.type.name === 'link' || m.type.name === 'linkSource')) pure = false
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

/** 块是否需要归一化：含样式标记，或文本匹配手打标记模式（'**x**' 等） */
function blockNeedsNormalize(block: PMNode): boolean {
  if (!block.isTextblock) return false
  let found = false
  block.content.descendants((n) => {
    if (found || !n.isText) return
    // 链接源码展开态文本不参与派生（与 toAtoms 一致）
    if (n.marks.some((m) => m.type.name === 'linkSource')) return
    if (
      n.marks.some((m) => m.type.name === 'mdStyle' || m.type.name === 'mdMarker' || !!LEGACY[m.type.name]) ||
      PATTERN_TEST.test(n.text ?? '')
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

// ─── 命令：样式开关（标记 + 样式同事务写入）──
function toggleStyle(style: StyleKind): (props: {
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
    state.doc.nodesBetween(Math.max(0, from - 8), Math.min(state.doc.content.size, to + 8), (node, pos) => {
      if (!node.isText) return
      const sm = node.marks.find((m) => m.type.name === 'mdMarker' && m.attrs.side === 'start' && m.attrs.style === style)
      if (sm) runStart = pos
      const em = node.marks.find((m) => m.type.name === 'mdMarker' && m.attrs.side === 'end' && m.attrs.style === style)
      if (em) runEnd = pos + node.nodeSize
    })
    const active = runStart >= 0 && runEnd >= 0 && from >= runStart && to <= runEnd

    if (active) {
      // 移除：删两端标记 + 去样式
      tr.delete(runEnd - open.length, runEnd)
      tr.delete(runStart, runStart + open.length)
      const contentFrom = runStart
      const contentTo = runEnd - open.length - open.length
      tr.removeMark(contentFrom, contentTo, mdStyle)
      tr.setSelection(TextSelection.create(tr.doc, Math.max(contentFrom, contentTo)))
      dispatch(tr)
      return true
    }
    if (empty) {
      // 空选区：插入一对标记，光标落中间。
      // 注意本版 PM 的 insertText(text, from, to) 无 marks 参数（marks 取自
      // storedMarks/位置），带标记文本须走 replaceRangeWith 显式构造节点
      tr.replaceRangeWith(from, from, state.schema.text(open, [mdMarker.create({ style, side: 'start' })]))
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
    tr.replaceRangeWith(safeFrom, safeFrom, state.schema.text(open, [mdMarker.create({ style, side: 'start' })]))
    tr.replaceRangeWith(end, end, state.schema.text(open, [mdMarker.create({ style, side: 'end' })]))
    tr.addMark(safeFrom + open.length, end, mdStyle.create({ style }))
    // 选区保持覆盖正文（气泡菜单不塌缩），光标在构造内（显隐装饰即时生效）
    tr.setSelection(TextSelection.create(tr.doc, safeFrom + open.length, Math.min(end, tr.doc.content.size)))
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
      normalizeMdMarkers: () => ({ state, tr, dispatch }: {
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
        const st = (this.editor as unknown as { storage?: { markdown?: { parser?: { parse: (s: string) => string } } } }).storage
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
                caretOffset = Math.min(caretOffset, Math.max(0, newBlock ? newBlock.content.size : 0))
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
