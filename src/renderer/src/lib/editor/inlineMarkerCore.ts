// ─── 行内标记模型的**纯逻辑**核心（无 tiptap / prosemirror 运行时依赖）──────────
//
// 为什么单独拆一个文件：`typoraInlineMarks.ts` 里真正容易出错的部分——「手打标记的
// 识别与合并」「污染标记的拆分」「字面量配对重提升」「样式栈物化」以及「冗余嵌套强调
// 的判定」——全是对普通数组（Atom[]、token[]）的变换，跟 ProseMirror 一点关系都没有。
// 混在 1300 行的 mark 定义与插件里，只能靠起真应用来验；拆出来之后 `npm run test:unit`
// 就能把这些规则逐条钉死（见 tests/inlineMarkers.test.mjs）。
//
// 约定：
//   * 本文件**只允许** `import type`（类型在运行时被擦除）——单测在纯 Node 下 import 它，
//     不能因为牵扯 prosemirror / tiptap 而炸；
//   * Atom 是「一行行内内容的中间表示」：文本 / 标记文本 / 换行 / 不透明行内节点；
//     标记的派生、配对、字面量化全部只跟它有关。
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownItRendererRule } from './markdownTypes'

// ─── 样式与标记的基本词汇 ────────────────────────────────────────────────────
export type StyleKind = 'bold' | 'italic' | 'strike' | 'code'

/**
 * 样式嵌套顺序（外 → 内）。同一段文本可以同时是粗体与行内代码（`**粗体里的 `代码`**`），
 * 而 PM 里**一种 mark 只能挂一个**，所以样式的唯一载体是 `mdStyle` 的 `styles` **集合**；
 * 集合按这个固定顺序排列，标记文本的物化与 DOM 呈现都照它来 —— 顺序固定才能保证
 * 「同一份文档每次解析/序列化都得到同一串标记」（幂等是保真套件的硬门槛）。
 */
export const STYLE_ORDER: readonly StyleKind[] = ['bold', 'strike', 'italic', 'code']

/** 样式集合规范化：去重 + 按 STYLE_ORDER 排序（非法值丢弃；空集合表示「无样式」） */
export function styleList(input: unknown): StyleKind[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : []
  const set = new Set<string>()
  for (const s of raw) if (typeof s === 'string' && s) set.add(s)
  return STYLE_ORDER.filter((s) => set.has(s))
}

/** 样式 → 它的标记文本（**'标记文本即源码'**：这对字符就是要写进文档的原文） */
export const MARKER_OF: Record<StyleKind, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`'
}
/** 标记文本 → 样式（不在此表里的标记文本不可识别 → 整段字面量） */
export const KIND_OF_MARKER: Record<string, StyleKind> = {
  '**': 'bold',
  '*': 'italic',
  '~~': 'strike',
  '`': 'code'
}
/** 解析器（markdown-it/HTML）留下的遗留 mark → 样式 */
export const LEGACY: Record<string, StyleKind> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  code: 'code'
}

export type MarkerSide = 'start' | 'end' | 'literal'

export interface Atom {
  kind: 'text' | 'marker' | 'break' | 'other'
  text?: string
  /** 原文照写（反斜杠转义 / 冗余嵌套强调的字面标记）：不参与标记派生，序列化时原样输出 */
  verbatim?: boolean
  marker?: { style: StyleKind; side: MarkerSide }
  /** 该段文本的样式集合（外→内，已规范化）。空/缺省 = 无样式 */
  styles?: StyleKind[]
  otherMarks?: PMMark[]
  node?: PMNode
}

/** 原子的样式集合（规范化副本；无样式返回空数组） */
export function stylesOf(a: Atom): StyleKind[] {
  return a.styles && a.styles.length ? styleList(a.styles) : []
}

/** 两个原子的样式集合是否相同 */
export function sameStyles(a: Atom, b: Atom): boolean {
  const x = stylesOf(a)
  const y = stylesOf(b)
  return x.length === y.length && x.every((s, i) => s === y[i])
}

// ─── 手打标记的识别（'**加粗**' → 标记/正文/标记 三个原子）────────────────────
/** 行内标记模式（任意位置；打字后与相邻文本合并为同一文本节点）。
    - '**' / '~~' / '`' 分支内容允许除换行外的任意字符（惰性，取最近闭合）；
    - 单 '*' 分支用 lookbehind/lookahead 排除与相邻 '*' 成对的情况——
      输入到一半的 '**5*' 不会被误切成 '*5*' 斜体（否则打完第五个
      '*' 会得到错乱的字面量/样式）。 */
const PATTERN = /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|~~([^~\n]+?)~~|`([^`\n]+?)`/g
export const PATTERN_TEST =
  /(\*\*)(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|~~([^~\n]+?)~~|`([^`\n]+?)`/

/** 识别「标记文本 + 正文 + 配对标记文本」模式（用户手打语法）。
    文本节点内任意位置扫描（'段落。**加粗**' 是同一节点），
    匹配处拆为 标记/样式正文/标记 三个原子。 */
export function recognizeTypedMarkers(atoms: Atom[]): void {
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
export function repairPollutedMarkers(atoms: Atom[]): boolean {
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
export function reLiftLiteralPairs(atoms: Atom[]): boolean {
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
export function normalizeAtoms(atoms: Atom[]): Atom[] | null {
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
export function materializeStyledRun(out: Atom[], from: number): number {
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
export function isRunPart(a: Atom): boolean {
  if (a.kind === 'text' && a.text && stylesOf(a).length) return true
  return a.kind === 'other'
}

/** 把构造标记原子降级为字面量标记（side:'literal'，原样序列化 + 可见字符） */
export function toLiteral(atom: Atom): Atom {
  return {
    kind: 'marker',
    text: atom.text ?? '',
    marker: { style: atom.marker?.style ?? 'bold', side: 'literal' }
  }
}

// ─── 光标落点（工具栏/快捷键插入标记对，与归一化后的光标恢复共用）─────────────
/**
 * 空光标插入一对标记的落点：start 插在 `from`，end 紧跟其后，**光标落在两者之间**
 * （`**|**`）。三个位置都在「插入前」的坐标系里 —— 调用方按顺序插入时，第二次插入
 * 的起点就是 `end`。
 */
export function markerPairOffsets(
  from: number,
  marker: string
): { start: number; end: number; caret: number } {
  return { start: from, end: from + marker.length, caret: from + marker.length }
}

/**
 * 归一化替换了某个文本块的内容之后，光标应该落到哪里（**绝对**文档位置）。
 *
 * `blockPos` 是「块节点之前的位置」（与 `descendants` 给的 pos 同一个域，块内容从
 * `blockPos + 1` 开始），`offset` 是块内偏移。这里的公式就是当初写错的那一处：
 * 早先算的是 `before(depth) - 1`，顶层段落得到 -1，`>= 0` 的守卫直接不成立 →
 * 光标保护整段失效 → PM 把光标映射到被替换区间的末尾（点加粗得到 `****|` 而不是
 * `**|**`，手打 `**` 也跑到块尾）。**这个函数就是那条规则的唯一实现**，单测钉死。
 */
export function blockCaretTarget(blockPos: number, offset: number, contentSize: number): number {
  return blockPos + 1 + Math.max(0, Math.min(offset, contentSize))
}

// ─── 冗余嵌套强调（`****x****`）：多出来的那一对标记必须以**文本**活下来 ──────
//
// 问题：CommonMark 把 `****x****` 解析成 `<strong><strong>x</strong></strong>`（两组
// 定界符各自配成一对）。回到模型时「同一种 mark 只能挂一个」——嵌套的两层 strong
// 塌成一层 bold，**多出来的一对 `**` 就这么没了**：`****x****` 打开后只剩 `**x**`，
// 保存/重开一次文件就掉四个字符（实测：手打「在 `**x**` 前后各补一对 `**`」必现）。
//
// 解法（与反斜杠转义同一套：在 markdown-it 那一层把信息留住）：渲染器遇到
// **同类嵌套**（外层 strong 还没关上又开一个 strong）时，不再输出标签，而是把那对
// 定界符当**字面文本**写出来 ——
//   `****x****` → `<strong>**x**</strong>`
// 于是解析产物里多出来的 `**` 是真实文本（带外层的粗体样式），归一化时它随样式
// 一起被物化成一对标记：`**` + `**x**` + `**` = `****x****`，逐字节还原。
//
// 为什么这样不会把「粗体里的粗体」算成两个样式：`mdStyle` 的样式是**集合**，
// bold+bold 去重后还是 bold；那对多出来的标记只是**字面文本**，既不影响渲染
// （本来就是同一个 bold），也让源码一字不差。`***x***`（em+strong 不同类）与
// `**a**b**c**`（不嵌套）都走原路径，行为不变；`*a *b* c*`（嵌套斜体）同理保住。
export const EMPHASIS_MARKUP: { open: string; close: string; marker: string }[] = [
  { open: 'strong_open', close: 'strong_close', marker: '**' },
  { open: 'em_open', close: 'em_close', marker: '*' },
  // `~~x~~`（markdown-it 的 strikethrough）同样可能嵌套：`~~a ~~b~~ c~~`
  { open: 's_open', close: 's_close', marker: '~~' }
]

/** 本位置之前还有几层同型强调没关上（token 流是扁平的，用配对计数还原嵌套深度） */
export function emphasisDepth(
  tokens: { type: string }[],
  idx: number,
  open: string,
  close: string
): number {
  let depth = 0
  for (let i = 0; i < idx; i++) {
    const t = tokens[i].type
    if (t === open) depth += 1
    else if (t === close) depth -= 1
  }
  return depth
}

/**
 * 这个强调 token 是不是「同类嵌套里多出来的那一对」（该渲染成字面标记文本）。
 *
 * 开标签：前面已经有同型强调开着（深度 ≥ 1）；闭标签：关掉它之后还剩一层
 * （深度 ≥ 2，因为深度是**含自己这一层**数出来的）。
 */
export function isRedundantEmphasis(
  tokens: { type: string }[],
  idx: number,
  open: string,
  close: string
): boolean {
  const depth = emphasisDepth(tokens, idx, open, close)
  return tokens[idx] && tokens[idx].type === open ? depth >= 1 : depth >= 2
}

/**
 * 「逐字写回」的文本载体：复用 MdEscape（`escape:false` + 空包裹，序列化一个字符都不动）。
 *
 * 为什么必须挂一层「不转义」的 mark 而不是直接写裸文本：这层 `**` 会落在**样式正文**里
 * （外层 strong 的粗体样式要盖住它），而样式正文走的是 markdown 写出器的转义路径
 * ——裸文本里的 `*` 会被写成 `\*`（实测得到 `**\*\*x\*\***`）。带上 `escape:false` 的
 * mark 后按 noEsc 分支逐字输出（与行内代码正文用 MdCodeLiteral、反斜杠转义用 MdEscape
 * 同一个机制）。
 */
export function literalSpan(text: string): string {
  return `<span class="md-escape" data-md-escape="true">${text}</span>`
}

/**
 * 把上面的规则接到 markdown-it 的渲染器上：同类嵌套的那对定界符渲染成字面文本。
 *
 * 只在 setup 钩子里跑一次（幂等保护），并且**保留**上游/其它扩展原有的规则
 * （`prevOpen`/`prevClose` 继续生效，`self.renderToken` 是 markdown-it 的兜底）。
 */
export function patchRedundantEmphasis(md: unknown): void {
  const m = md as {
    __luminRedundantEmphasis?: boolean
    renderer?: { rules: Record<string, MarkdownItRendererRule | undefined> }
  }
  if (!m?.renderer?.rules || m.__luminRedundantEmphasis) return
  m.__luminRedundantEmphasis = true
  const rules = m.renderer.rules
  for (const { open, close, marker } of EMPHASIS_MARKUP) {
    const prevOpen = rules[open]
    const prevClose = rules[close]
    rules[open] = (tokens, idx, options, env, self) => {
      // 已经有一层同型强调开着 → 这一层是多出来的那对，写成字面标记
      if (isRedundantEmphasis(tokens, idx, open, close)) return literalSpan(marker)
      return prevOpen
        ? prevOpen(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }
    rules[close] = (tokens, idx, options, env, self) => {
      // 关掉它之后还剩一层同型强调开着 → 关的是内层（冗余的那对）
      if (isRedundantEmphasis(tokens, idx, open, close)) return literalSpan(marker)
      return prevClose
        ? prevClose(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }
  }
}
