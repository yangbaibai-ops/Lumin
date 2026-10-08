// ─── 公式的渲染 + 编辑态（点击公式 → 就能改源码，逐键实时渲染）────────────────────
//
// 为什么用**装饰 / NodeView** 而不是自定义文本节点：模型里公式的原文必须留在文档里
// （行内是带 `MdMath` mark 的文本节点，块级是 `attrs.source`），序列化才能逐字写回。
// 渲染与编辑都只是**视图**的事 —— 正好是 ProseMirror 装饰 / NodeView 的适用场景。
//
// ─── 两种形态（第三十轮按 Typora 截图重做）──────────────────────────────────────
// 截图里的块级编辑态是**一个带细边框的容器**：上半浅灰底源码区（等宽、`$$` 分列上下、
// 右上角「公式 ✓」），下半白底渲染区（居中、留白比正文大）。所以：
//
//   * **块级** = `mathBlock` 的 NodeView 内容，**随正文流**排布（见 mathMarkers.ts 的
//     `addNodeView`）。编辑时原渲染结果被容器取代，收起即恢复。
//     为什么不做成浮层：块级编辑区要占一整块还带上下留白，浮层会盖住正文；
//     而且"随流"意味着它天然就在公式原来那个位置，不需要算坐标。
//   * **行内** = **固定定位的紧凑浮层**（挂在编辑区容器上）。行内公式只有几个字符，
//     套整块容器会撑破那一行、把句子拆开（用户明确要求"不要让行内公式占一整行"），
//     所以它保留"浮在公式上方"的形态，只把**配色/边框/圆角/标签**与块级统一。
//
// ─── 交互语义 ──────────────────────────────────────────────────────────────────
//   * **永远不会**因为光标靠近而变样 —— 公式恒为渲染态（除了正在编辑的那一条）；
//   * **点击公式** → 进入编辑态；
//   * **逐键实时渲染**：每敲一个字符 dispatch 一次 ⇒ 文档里的 `$…$`/`source` 立即更新
//     ⇒ 渲染区（块级是容器下半、行内是框外那条公式）**原地**重画；
//   * **Esc** / 右上角 **✓ 按钮** = 收起编辑态，**不改内容**（内容早已实时写进文档）；
//   * **失焦** = 也收起（同样保留内容）；
//   * **源码清空**（`''`）= **删除这条公式**（行内连 `$` 定界符一起删，块级删整个节点）。
//
// ⚠️ 编辑区**不是 contenteditable 的后代**：块级容器挂在 NodeView 的 `dom` 上但整棵
// `contenteditable="false"`；行内浮层挂在编辑区容器上。两者的 textarea 都不参与
// ProseMirror 的 DOM 观察与光标导航。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import { mathRenderInfo } from './mathMarkers'

const mathPreviewKey = new PluginKey<MathPluginState>('lumin-math-preview')

/** 一段公式在文档里的位置信息（行内：mark 区间 / 块级：原子节点区间） */
interface MathHit {
  kind: 'inline' | 'block'
  /** 公式**整体**（含 `$` 定界符）的位置 */
  from: number
  to: number
  /** 公式**内容**的位置（行内已去掉两侧 `$`；块级与整体相同，用它整块删除） */
  innerFrom: number
  innerTo: number
  /** 渲染用的公式内容（行内已去掉 `$` 定界符） */
  tex: string
}

/** 正在编辑的那一段公式 */
interface MathSession {
  kind: 'inline' | 'block'
  active: MathHit
  /** 每次打开换一个 id：新会话的编辑 DOM 一定是新建的（旧 DOM 的焦点状态不串） */
  id: number
}

interface MathPluginState {
  active: MathSession | null
  /** 常驻装饰（行内：折叠原文 + 渲染 widget） */
  decos: DecorationSet
  /**
   * 编辑态的容器实例（行内浮层 / 块级随流容器都在这里）。
   *
   * 为什么存在**插件 state** 而不是视图字段：逐键写回会让装饰集整体重算，
   * 而 `Decoration.widget` 的 `eq()` 决定 PM 要不要重建那段 DOM —— 只要还是同一个
   * 实例对象，PM 就**不重建**，textarea 因此不丢焦点（这是"逐键实时渲染"能用的前提）。
   */
  box: MathEditorBase | null
}

// ─── 收集文档里的公式 ─────────────────────────────────────────────────────────

/**
 * 文档里所有公式（行内 + 块级）的位置。
 *
 * 行内「整段带 MdMath mark 的文本区间」：相邻文本节点合并成一段 —— 公式里的 `*`/`_`
 * 被字面量化后可能被切成多个文本节点，不合并就没法还原出完整原文。
 */
function collectMathHits(doc: PMNode): MathHit[] {
  const merged: { from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    if (!node.marks.some((m) => m.type.name === 'mdMath')) return true
    const last = merged[merged.length - 1]
    if (last && last.to === pos) {
      last.to = pos + node.nodeSize
      return true
    }
    merged.push({ from: pos, to: pos + node.nodeSize })
    return true
  })

  const out: MathHit[] = []
  for (const span of merged) {
    const raw = doc.textBetween(span.from, span.to, '')
    // 原文含定界符（`$…$`），交给 KaTeX 前去掉；内容区间也相应内缩
    const hasOpen = raw.startsWith('$')
    const hasClose = raw.endsWith('$') && raw.length > 1
    out.push({
      kind: 'inline',
      from: span.from,
      to: span.to,
      innerFrom: hasOpen ? span.from + 1 : span.from,
      innerTo: hasClose ? span.to - 1 : span.to,
      tex: hasOpen && hasClose ? raw.slice(1, -1) : raw
    })
  }

  doc.descendants((node, pos) => {
    if (node.type.name !== 'mathBlock') return true
    out.push({
      kind: 'block',
      from: pos,
      to: pos + node.nodeSize,
      innerFrom: pos,
      innerTo: pos + node.nodeSize,
      tex: String(node.attrs.source ?? '')
    })
    return true
  })
  return out
}

/**
 * 行内公式的常驻装饰：渲染 widget + 原文折叠。
 *
 * ⚠️ 铁律：**只要公式没有被编辑，这两条必须成对出现**。少了渲染 widget 就只剩一段
 * 被折叠掉的文本 —— 屏幕上**什么都没有**（公式"消失"）。
 * 块级不在这里：它的渲染是 NodeView 的事（见 mathMarkers.ts）。
 */
function buildMathDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  for (const hit of collectMathHits(doc)) {
    if (hit.kind !== 'inline') continue
    decos.push(Decoration.widget(hit.from, () => mathDom(hit.tex), { side: -1 }))
    decos.push(Decoration.inline(hit.from, hit.to, { class: 'md-math-source' }))
  }
  return DecorationSet.create(doc, decos)
}

/** 行内公式的渲染结果（`contenteditable=false`：光标不会落进 KaTeX 的 DOM 里） */
function mathDom(tex: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-math-rendered'
  span.setAttribute('data-md-math-rendered', tex)
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('title', tex)
  span.innerHTML = mathRenderInfo(tex, false).html
  return span
}

/** 位置必须落在文档范围内（`Decoration.widget` 越界会抛） */
function clamp(pos: number, doc: PMNode): number {
  return Math.max(0, Math.min(pos, doc.content.size))
}

// ─── 文案（由扩展选项从语言包注入）──────────────────────────────────────────────

/**
 * 编辑区的文案。**由扩展选项注入**（`buildEditorExtensions` 从语言包取），
 * 这样这个模块自己不 `import '../../i18n'`：它是 Tiptap 内核的一部分，而那条 import
 * 会把 Vue 与整份语言包的动态装载拖进 `node --test` 的依赖链（同一个坑见
 * `outlineText.ts` 的注释）。默认值只是"没注入时的兜底"，界面上永远走注入值。
 */
export interface MathLabels {
  /** 可见标签（Typora 截图里右上角那个「公式」） */
  label: string
  /** 容器 / 编辑区的可访问名（比可见标签更具体） */
  aria: string
  /** ✓ 按钮的可访问名（"确认并收起编辑"之类） */
  check: string
  /** 「Esc」提示（只在行内浮层上给） */
  esc: string
}

/**
 * 兜底文案：**故意留空**。
 *
 * 界面上的值一律由 `buildEditorExtensions` 从语言包注入（每一段都是 `t('editor.math*')`），
 * 所以这里的默认值永远不会出现在用户面前。留成空串而不是写一份中文兜底，是为了让
 * `tests/i18nHardcoded.test.mjs`（界面文案不许绕过语言包）对**所有**可能显示出来的
 * 字符串都有约束 —— 一份"反正不会用到"的中文兜底，恰恰是那种以后会真的显示出来的东西。
 */
const DEFAULT_LABELS: MathLabels = { label: '', aria: '', check: '', esc: '' }

/**
 * 公式**真正的横向范围**（用它量宽度，而不是量元素盒）。
 *
 * 为什么不能用 `getBoundingClientRect().width`：块级公式的 `.katex-html` 是
 * `display:block`，`.katex-display > .katex` 也是 `block` —— 它们的盒宽是**整列宽**
 * （实测 928px），拿它当"公式宽度"会把行内浮层拉成一条通栏。用 `Range` 选中
 * `.katex-html` 的内容量到的才是**字形本身**的范围（实测同一条公式 106px、整列 928px）。
 */
function inkRect(el: HTMLElement): { left: number; width: number } | null {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    const boxes = Array.from(range.getClientRects()).filter((b) => b.width > 0)
    if (!boxes.length) return { left: r.left, width: r.width }
    const left = Math.min(...boxes.map((b) => b.left))
    const right = Math.max(...boxes.map((b) => b.right))
    return { left, width: Math.max(right - left, 1) }
  } catch {
    return { left: r.left, width: r.width }
  }
}

/**
 * 把**行内**浮层摆到公式上方（用 `getBoundingClientRect` 算，不写死坐标）。
 *
 * 三条口径：
 *   * **上方优先**；上方真的放不下（公式在文档第一行/滚动到视口顶部）才翻到下方 ——
 *     硬贴上方会顶出视口。翻没翻由 `data-md-math-editor-side` 如实给出，套件据此断言。
 *   * **宽度贴公式**（下限 280，上限贴视口）：量的是字形范围（见 `inkRect`）。
 *   * 横向在公式上方居中，整体夹在视口内；纵向与公式留 8px。
 * @returns 实际放在哪一侧
 */
function placeBox(box: HTMLElement, anchor: HTMLElement, line: HTMLElement): 'above' | 'below' {
  const r = anchor.getBoundingClientRect()
  const ink = inkRect(line)
  const vw = window.innerWidth
  const vh = window.innerHeight
  const wanted = Math.max(ink ? ink.width : r.width, 280)
  box.style.width = Math.round(Math.min(wanted, vw - 24)) + 'px'
  const h = box.offsetHeight
  const above = r.top - h - 8
  const below = r.bottom + 8
  // 上方放得下就用上方；否则下方放得下就用下方；都不行才退到上方（夹到视口顶）
  const side: 'above' | 'below' = above >= 12 || below + h >= vh - 12 ? 'above' : 'below'
  const top = side === 'above' ? above : below
  box.setAttribute('data-md-math-editor-side', side)
  box.style.top = Math.round(Math.max(12, top)) + 'px'
  // 横向：把框的中心对到公式字形的中心
  const center = (ink ? ink.left : r.left) + (ink ? ink.width : r.width) / 2
  const left = center - box.offsetWidth / 2
  box.style.left =
    Math.round(Math.min(Math.max(12, left), Math.max(12, vw - box.offsetWidth - 12))) + 'px'
  return side
}

// ─── 编辑区 DOM（块级 / 行内共用）──────────────────────────────────────────────

/**
 * 造一套编辑区零件：`[bar: 公式 ✓] [source: $$/textarea/$$] [preview]`。
 *
 * 与 Typora 截图对齐的三件事：
 *   1. `$$` 定界符**分列源码上下两行**（不是挤在一行）—— 所以源码区是一个列；
 *   2. 右上角「公式」+ **✓ 按钮**（真 `<button>`：可聚焦、有可访问名；点它 = 收起编辑态）；
 *   3. 源码区在上、渲染区在下（浅灰/白底与分隔线交给 CSS）。
 *
 * @param delimiters 是否显示上下 `$$` 行 —— **只有块级给**。行内浮层很窄，
 *   多两行会把"紧凑"这件事毁掉（用户明确要求行内不要占一整行）。
 */
function buildEditorParts(
  labels: MathLabels,
  opts: { delimiters: boolean; showHint: boolean }
): {
  box: HTMLElement
  check: HTMLButtonElement
  ta: HTMLTextAreaElement
  preview: HTMLElement
} {
  const box = document.createElement('div')
  box.className = 'md-math-editor'
  box.setAttribute('data-md-math-editor', '')
  box.setAttribute('contenteditable', 'false')

  const bar = document.createElement('div')
  bar.className = 'md-math-editor__bar'
  // ✓ = 收起编辑态（等价 Esc）。用真 `<button>`：天然可聚焦、有可访问名，
  // 也让套件能用"可聚焦 + 可访问名"这两条标准判据断言，不必写死坐标。
  //
  // 可访问名用 `labels.check`（"确认并收起公式编辑"）而不是可见的「公式」——
  // 可见文本是截图那个样子的「公式 ✓」（标签 + 勾），但读屏听到的应该是**动作**。
  const check = document.createElement('button')
  check.type = 'button'
  check.className = 'md-math-editor__check'
  check.setAttribute('data-md-math-editor-check', '')
  check.setAttribute('aria-label', labels.check)
  check.setAttribute('title', labels.check)
  const checkText = document.createElement('span')
  checkText.setAttribute('data-md-math-editor-label', '')
  checkText.textContent = labels.label
  const mark = document.createElement('span')
  mark.setAttribute('data-md-math-editor-check-mark', '')
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '✓'
  check.append(checkText, mark)
  bar.append(check)
  if (opts.showHint) {
    const hint = document.createElement('span')
    hint.className = 'md-math-editor__hint'
    hint.textContent = labels.esc
    bar.append(hint)
  }

  const source = document.createElement('div')
  source.className = 'md-math-editor__source'
  const ta = document.createElement('textarea')
  ta.className = 'md-math-editor__src'
  ta.setAttribute('data-md-math-editor-src', '')
  ta.setAttribute('spellcheck', 'false')
  ta.setAttribute('autocapitalize', 'off')
  ta.setAttribute('autocomplete', 'off')
  ta.setAttribute('autocorrect', 'off')
  ta.setAttribute('rows', '1')
  // 横向不软换行（CSS 也是 `white-space: pre`）：长公式在框内横向滚动，而不是断成好几行
  // —— 实测软换行会在行尾留一个看不见的空格，还多出一条竖滚动条
  ta.setAttribute('wrap', 'off')
  ta.setAttribute('aria-label', labels.aria)
  if (opts.delimiters) {
    const open = document.createElement('div')
    open.className = 'md-math-editor__delim'
    open.setAttribute('data-md-math-editor-delim', 'open')
    open.textContent = '$$'
    const close = document.createElement('div')
    close.className = 'md-math-editor__delim'
    close.setAttribute('data-md-math-editor-delim', 'close')
    close.textContent = '$$'
    source.append(open, ta, close)
  } else {
    source.append(ta)
  }

  const preview = document.createElement('div')
  preview.className = 'md-math-editor__preview'
  preview.setAttribute('data-md-math-editor-preview', '')
  preview.setAttribute('contenteditable', 'false')

  box.append(bar, source, preview)
  return { box, check, ta, preview }
}

/** 把 KaTeX 产物画进渲染区，并同步错误态 */
function renderEditorPreview(
  box: HTMLElement,
  preview: HTMLElement,
  tex: string,
  display: boolean
): void {
  if (!tex.trim()) {
    preview.innerHTML = ''
    box.removeAttribute('data-md-math-invalid')
    return
  }
  const { html, error } = mathRenderInfo(tex, display)
  preview.innerHTML = html
  // 错误态跟着**真实的 KaTeX 结果**走（`mathRenderInfo` 用 `throwOnError:true` 接住，
  // 未定义宏也算错），不靠正则猜公式合不合法
  if (error) box.setAttribute('data-md-math-invalid', '')
  else box.removeAttribute('data-md-math-invalid')
}

// ─── 编辑区的公共行为 ─────────────────────────────────────────────────────────

/**
 * 块级 / 行内编辑区共用的输入、写回、错误态、Esc/✓/失焦语义。
 *
 * 子类只决定两件事：DOM 摆在哪儿（随流 / 浮层）、以及预览是"一直画"还是"只在出错时画"。
 */
abstract class MathEditorBase {
  readonly id: number
  readonly dom: HTMLElement
  protected readonly view: EditorView
  protected readonly labels: MathLabels
  protected readonly ta: HTMLTextAreaElement
  protected readonly check: HTMLButtonElement
  protected readonly preview: HTMLElement
  /** 正在由本对象回写文档：避免 `input → dispatch → pull` 的自激 */
  private writing = false
  /** 输入法组合中：组合期间不回写（会把中文输入打断成一个个字母） */
  private composing = false

  constructor(
    view: EditorView,
    id: number,
    labels: MathLabels,
    delimiters: boolean,
    showHint: boolean
  ) {
    this.view = view
    this.id = id
    this.labels = labels
    const parts = buildEditorParts(labels, { delimiters, showHint })
    this.dom = parts.box
    this.ta = parts.ta
    this.check = parts.check
    this.preview = parts.preview

    this.ta.addEventListener('input', this.onInput)
    this.ta.addEventListener('keydown', this.onKeyDown)
    this.ta.addEventListener('blur', this.onBlur)
    this.ta.addEventListener('compositionstart', this.onCompositionStart)
    this.ta.addEventListener('compositionend', this.onCompositionEnd)
    // ✓ 按钮：`mousedown` 阻止默认，逐字写回**不受影响**（内容早已进文档）；
    // 用 `mousedown` 而不是 `click` 是因为 textarea 的 blur 已经会收起编辑态 ——
    // 让收起只发生一次，语义更清楚（内容无论如何都已经写回去了）
    this.check.addEventListener('mousedown', this.onCheckDown)
    // 编辑区里的鼠标动作**不要**冒泡到编辑区根节点（PM 会据此改选区/触发点击语义）
    this.dom.addEventListener('mousedown', (e) => e.stopPropagation())
    this.dom.addEventListener('click', (e) => e.stopPropagation())
  }

  /** 子类：DOM 摆放 / 尺寸（块级什么都不用做，行内要算坐标） */
  abstract place(): void

  /** 子类：更新渲染区（块级一直画；行内只在出错时画） */
  protected abstract paintPreview(tex: string): void

  /** 与文档对齐（源码值 + 渲染区 + 错误态）—— 子类提供"当前文档里的原文" */
  pull(tex: string): void {
    if (!this.writing && this.ta.value !== tex) this.ta.value = tex
    this.paintPreview(this.ta.value)
    this.autosize()
  }

  focus(): void {
    this.ta.focus({ preventScroll: true })
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length)
  }

  /** 摘掉监听（DOM 归调用方处理） */
  detach(): void {
    this.ta.removeEventListener('input', this.onInput)
    this.ta.removeEventListener('keydown', this.onKeyDown)
    this.ta.removeEventListener('blur', this.onBlur)
    this.ta.removeEventListener('compositionstart', this.onCompositionStart)
    this.ta.removeEventListener('compositionend', this.onCompositionEnd)
    this.check.removeEventListener('mousedown', this.onCheckDown)
  }

  /** 销毁：摘监听 + 清自己的 DOM */
  destroy(): void {
    this.detach()
    this.dom.remove()
  }

  /** textarea 自动高（长公式要能看全；`rows=1` 只是下限） */
  protected autosize(): void {
    this.ta.style.height = 'auto'
    this.ta.style.height = Math.min(this.ta.scrollHeight, 12 * 24) + 'px'
  }

  /** 编辑区 → 文档（逐键）。文档一变 ⇒ 视图跟着重算 ⇒ 公式原地重画 */
  protected commit(): void {
    this.writing = true
    try {
      applySource(this.view, this.ta.value, this.id)
    } finally {
      this.writing = false
    }
    const live = locateSessionHit(this.view, this.id)
    if (live) this.pull(live.tex)
    this.place()
  }

  private onInput = (): void => {
    if (this.writing || this.composing) return
    this.commit()
  }

  private onCompositionStart = (): void => {
    this.composing = true
  }

  private onCompositionEnd = (): void => {
    this.composing = false
    this.commit()
  }

  /** Esc / ✓ = 收起编辑态（**不改内容**）；Tab = 缩进（`\begin{align}` 要能排版） */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeSession(this.view)
      this.view.focus()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const { selectionStart: a, selectionEnd: b, value } = this.ta
      this.ta.value = value.slice(0, a) + '  ' + value.slice(b)
      this.ta.setSelectionRange(a + 2, a + 2)
      this.commit()
    }
  }

  private onCheckDown = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    closeSession(this.view)
  }

  /** 失焦也收起，但**保留内容**（内容早就逐个字符实时写进文档了） */
  private onBlur = (): void => {
    closeSession(this.view)
  }
}

// ─── 块级编辑态（随正文流，Typora 形态）──────────────────────────────────────

/**
 * 块级公式的编辑态：上半源码区 / 下半渲染区，**在正文流里**占一块（Typora 形态）。
 *
 * 它靠**块级 widget 装饰**挂进文档流（`Decoration.widget(pos, …, {side:-2})`，
 * 位置就是公式节点的起点），同时给那个节点加 `.md-math-editing` 把原来的渲染结果收起 ——
 * 于是容器正好"顶替"公式原来的位置：
 *   * 不需要算坐标、不需要 fixed/z-index；
 *   * 宽度就是正文列宽；
 *   * 上下留白由容器自己的 margin 给（`.md-preview .md-math-block` 被收起了，不再占位）。
 *
 * ⚠️ 为什么不用 NodeView 承载它（第三十轮踩过的坑）：会话是**只改视图**的事务
 * （文档一个字符都没变），而 ProseMirror 在"doc 没变"时**不会调用 `view.update()`** ——
 * NodeView 因此永远收不到通知（实测：点击后会话确实开了，但界面上什么都没有）。
 * 装饰则由 `props.decorations` 在每次重绘时重算，PM 一定接得住。
 */
class BlockMathEditor extends MathEditorBase {
  constructor(view: EditorView, id: number, labels: MathLabels, pos: number) {
    // 块级：给 `$$` 分列上下；`Esc` 提示不给（bar 已经够挤，且 ✓ 是可见出口）
    super(view, id, labels, true, false)
    this.dom.classList.add('md-math-editor--block')
    this.dom.setAttribute('data-md-math-editor-shape', 'block')
    // 位置锚：套件用它断言"编辑的确实是那一条公式"，不靠坐标猜
    this.dom.setAttribute('data-md-math-editor-pos', String(pos))
  }

  /** `eq` 恒真：同一个会话里 PM 不重建这个 widget 的 DOM（textarea 因此不丢焦点） */
  eq(): boolean {
    return true
  }

  /** 随正文流：位置由排版决定，不需要 JS 做事 */
  place(): void {
    /* 块级不该算坐标：它是正文流里的一块（见文件头的形态说明） */
  }

  /**
   * 渲染区**一直画**（这是 Typora 形态的"下半"）。
   * 与行内不同：行内的预览只在出错时才有意义（不然就是框外那条公式的重复），
   * 而块级的渲染区就是用户要看的那个公式本身（编辑时原节点已被容器取代）。
   */
  protected paintPreview(tex: string): void {
    this.preview.style.display = ''
    renderEditorPreview(this.dom, this.preview, tex, true)
  }
}

// ─── 行内编辑态（紧凑浮层）────────────────────────────────────────────────────

/**
 * 行内公式的编辑态：**固定定位的紧凑浮层**，浮在公式上方。
 *
 * 为什么不套块级那套形态：行内公式只有几个字符，整块容器（带上下 `$$`、带下半渲染区、
 * 带上下留白）会把那一行撑开、把句子拆成三截 —— 用户明确要求"不要让行内公式占一整行"。
 * 所以这里只统一**配色/边框/圆角/标签**，尺寸与摆放保持"浮层"。
 */
class InlineMathEditor extends MathEditorBase {
  /** 本次会话对应的公式区间（用来量宽度、找锚点） */
  private hit: MathHit

  constructor(view: EditorView, session: MathSession, labels: MathLabels) {
    super(view, session.id, labels, false, true)
    this.hit = session.active
    this.dom.classList.add('md-math-editor--inline')
    this.dom.setAttribute('data-md-math-editor-shape', 'inline')
  }

  /**
   * 行内的渲染区**只在出错时**显示：语法正确时框外那条公式就是它的渲染结果，
   * 再画一份只是噪音（错误信息则是唯一能说清"错在哪"的东西）。
   */
  protected paintPreview(tex: string): void {
    const { html, error } = mathRenderInfo(tex, false)
    const preview = this.preview
    if (!tex.trim()) {
      preview.innerHTML = ''
      preview.style.display = 'none'
      this.dom.removeAttribute('data-md-math-invalid')
      return
    }
    preview.innerHTML = html
    preview.style.display = error ? '' : 'none'
    if (error) this.dom.setAttribute('data-md-math-invalid', '')
    else this.dom.removeAttribute('data-md-math-invalid')
  }

  setSession(session: MathSession): void {
    this.hit = session.active
  }

  /** `eq` 恒真：同一个会话里 PM 不重建这个 widget 的 DOM（textarea 因此不丢焦点） */
  eq(): boolean {
    return true
  }

  /**
   * 公式的**可视盒**：`anchor` 用来算"上方有没有位置"，`line` 用来量宽度。
   * 行内两者都是那个渲染结果本身。
   */
  anchor(): { anchor: HTMLElement; line: HTMLElement } | null {
    const doc = this.view.state.doc
    let el: HTMLElement | null = null
    try {
      const dom = this.view.nodeDOM(clamp(this.hit.from, doc))
      el = dom instanceof HTMLElement ? dom : null
    } catch {
      el = null
    }
    if (!el) {
      // 位置暂时无效（视图正在重建 / 节点还没挂上）→ 按文档位置在编辑区里找最近的行内公式
      const all = Array.from(this.view.dom.querySelectorAll<HTMLElement>('[data-md-math-rendered]'))
      for (const candidate of all) {
        if (Math.abs(this.view.posAtDOM(candidate, 0) - this.hit.from) <= 1) {
          el = candidate
          break
        }
      }
    }
    if (!el) return null
    const rendered = el.matches('[data-md-math-rendered]')
      ? el
      : el.querySelector<HTMLElement>('[data-md-math-rendered]')
    return rendered ? { anchor: rendered, line: rendered } : null
  }

  /** 摆到公式上方（上方放不下就翻到下方），宽度贴公式 */
  place(): void {
    const target = this.anchor()
    if (!target) return
    const side = placeBox(this.dom, target.anchor, target.line)
    this.dom.setAttribute('data-md-math-editor-side', side)
  }
}

// ─── 会话 ⇄ 文档 ─────────────────────────────────────────────────────────────

/** 按 id 找到**当前文档里**对应的那一段公式（位置可能已被编辑映射过） */
function locateSessionHit(view: EditorView, id: number): MathHit | null {
  const session = mathPreviewKey.getState(view.state)?.active
  if (!session || session.id !== id) return null
  return locateLive(view, session)
}

/**
 * 按会话找到**当前文档里**对应的那一段公式（位置可能已被编辑映射过）。
 *
 * 为什么要"重新找"而不是直接用会话里记的位置：逐键写回会改变文档，
 * 前面内容变长变短都会把位置推走。
 */
function locateLive(view: EditorView, session: MathSession): MathHit | null {
  const hits = collectMathHits(view.state.doc)
  const exact = hits.find((h) => h.kind === session.kind && h.from === session.active.from)
  if (exact) return exact
  // 位置漂了（前面的内容被改过）：优先按内容认，再按"就近"认。
  // ⚠️ 块级公式不按内容认：它的 `tex` 是节点属性，读写都比位置更容易漂
  //    （而且属性刚被改过时"按旧内容找"必然找不到）；块级的落点靠位置区间。
  if (session.kind === 'block') {
    return (
      hits.find((h) => h.kind === 'block' && Math.abs(h.from - session.active.from) <= 4) ?? null
    )
  }
  return (
    hits.find((h) => h.kind === 'inline' && h.tex === session.active.tex) ??
    hits.find((h) => h.kind === 'inline' && Math.abs(h.from - session.active.from) <= 2) ??
    null
  )
}

/** 行内公式写回时要带上 `MdMath` mark（否则它就不再是公式、不再逐字写回） */
function liveMarks(state: EditorState, live: MathHit): readonly Mark[] {
  let marks: readonly Mark[] = []
  state.doc.nodesBetween(live.innerFrom, live.innerTo, (node) => {
    if (node.isText && node.marks.some((m) => m.type.name === 'mdMath')) {
      marks = node.marks
      return false
    }
    return true
  })
  return marks
}

/** 这一段公式**当前**的原文（行内从文本节点读、块级从节点属性读） */
function currentTex(state: EditorState, live: MathHit, kind: 'inline' | 'block'): string {
  if (kind === 'inline') return live.tex
  return String(state.doc.nodeAt(live.from)?.attrs.source ?? '')
}

/** 同上，但从一个文档直接读（`apply` 里只拿得到 `newState.doc`，没有 EditorState） */
function currentTexOf(doc: PMNode, live: MathHit, kind: 'inline' | 'block'): string {
  if (kind === 'inline') return live.tex
  return String(doc.nodeAt(live.from)?.attrs.source ?? '')
}

/**
 * 把源码写回文档（**唯一的写入口**：逐键输入、输入法组合结束、Tab 缩进都走这里）。
 *
 * 写的是「公式内容」那一段区间 —— 定界符 `$` 与（块级的）节点身份都不动。
 * 源码为空 ⇒ 删除整条公式（语义见文件头的交互说明）。
 * @param id 发起写入的编辑区 id：会话已经被别人接管时**直接忽略**（防止过期写入）
 * @returns 是否真的改动了文档
 */
export function applySource(view: EditorView, tex: string, id?: number): boolean {
  const session = mathPreviewKey.getState(view.state)?.active
  if (!session) return false
  if (id !== undefined && session.id !== id) return false
  const live = locateLive(view, session)
  if (!live) return false
  const kind = session.kind
  const { state } = view
  if (tex === '') {
    view.dispatch(
      state.tr
        .delete(live.innerFrom, live.innerTo)
        .setMeta(mathPreviewKey, { session: { kind: 'close' } })
    )
    return true
  }
  if (tex === currentTex(state, live, kind)) return false
  if (kind === 'inline') {
    // 行内：替换**内容区间**（两侧 `$` 定界符与 `mdMath` mark 都留着）
    const text = state.schema.text(tex, liveMarks(state, live))
    view.dispatch(state.tr.replaceWith(live.innerFrom, live.innerTo, text))
    return true
  }
  // 块级：原文在**节点属性** `source` 里（节点本身没有文本内容，`textBetween` 恒为空串）。
  // ⚠️ 这里千万不能 `replaceWith(...)` —— 那会把整个 `mathBlock`（原子节点）换成一段文字，
  // 于是公式退化成一个普通段落（实测过：`$$…$$` 被吃掉、`\frac{1}{` 变成正文）。
  // 正确做法是给节点打一个新属性，NodeView 的 `update` 会据此重画。
  const node = state.doc.nodeAt(live.from)
  if (!node || node.type.name !== 'mathBlock') return false
  view.dispatch(state.tr.setNodeMarkup(live.from, undefined, { ...node.attrs, source: tex }))
  return true
}

// ─── 插件 ────────────────────────────────────────────────────────────────────

/**
 * 打开源码框的事务元数据（**只挂在事务上**，不进文档、不参与序列化）。
 * `{kind:'close'}` = 收起；否则 = 打开/换到这条公式。
 */
type MathSessionMeta = { session: { kind: 'close' } | { kind: 'open'; hit: MathHit; id: number } }

/** 打开编辑态（**只改视图**：文档内容一个字符都不动） */
export function openMathEditor(view: EditorView, hit: MathHit): void {
  view.dispatch(
    view.state.tr.setMeta(mathPreviewKey, {
      session: { kind: 'open', hit, id: Date.now() + Math.random() }
    } satisfies MathSessionMeta)
  )
}

/** 收起编辑态（Esc / ✓ / 失焦；**保留**已写进文档的内容） */
export function closeSession(view: EditorView): void {
  if (!mathPreviewKey.getState(view.state)?.active) return
  view.dispatch(
    view.state.tr.setMeta(mathPreviewKey, { session: { kind: 'close' } } satisfies MathSessionMeta)
  )
}

/** 点击落在哪一条公式上（`pos` 由 PM 给出；再按 DOM 上的原文属性兜底） */
function locate(doc: PMNode, pos: number, el: HTMLElement): MathHit | null {
  const hits = collectMathHits(doc)
  const byPos = hits.find((h) => pos >= h.from && pos <= h.to)
  if (byPos) return byPos
  const block = el.closest('[data-md-math-block]')
  const domSource =
    el.getAttribute('data-md-math-rendered') ?? block?.getAttribute('data-source') ?? null
  if (domSource === null) return null
  return (
    hits.find((h) => h.kind === 'block' && h.tex === domSource) ??
    hits.find((h) => h.tex === domSource) ??
    null
  )
}

export const MathPreview = Extension.create<{ labels?: Partial<MathLabels> }>({
  name: 'mathPreview',
  addOptions() {
    return { labels: undefined }
  },
  addProseMirrorPlugins() {
    const labels: MathLabels = { ...DEFAULT_LABELS, ...(this.options.labels ?? {}) }
    return [
      new Plugin<MathPluginState>({
        key: mathPreviewKey,
        state: {
          init: (_config, state) => ({
            active: null,
            decos: buildMathDecorations(state.doc),
            box: null
          }),
          apply: (tr, value, _oldState, newState) => {
            const meta = tr.getMeta(mathPreviewKey) as MathSessionMeta | undefined
            const session = meta?.session
            let active = value.active
            if (session) {
              if (session.kind === 'close') active = null
              else active = { kind: session.hit.kind, active: session.hit, id: session.id }
            } else if (active) {
              // ⚠️ 只有**改动确实碰到过这段公式**时才重新认领它。
              //
              // 为什么不能有 doc 变化就重找：会话本身靠"只改视图"的事务打开/收起，
              // 而视图层还要再 dispatch 一次**空事务**去逼 PM 重算装饰（见 MathPreviewView）——
              // 那些事务的 `docChanged` 可能是假、也可能让位置漂一点。一律重找的话，
              // 一次无关重绘就能把会话"认丢"（实测：编辑框刚出现就自己收起）。
              // 判据用 `tr.mapping` 把原区间映射一遍：映射后还是同一段 ⇒ 这段公式没被碰过。
              const from0 = active.active.from
              const to0 = active.active.to
              const movedFrom = tr.mapping.map(from0)
              const movedTo = tr.mapping.map(to0)
              if (movedFrom === from0 && movedTo === to0) {
                // 位置没动，直接用（内容可能被改过，比如逐键写回 —— 由 pull 去对齐）
                active = {
                  ...active,
                  active: {
                    ...active.active,
                    tex: currentTexOf(newState.doc, active.active, active.kind)
                  }
                }
              } else {
                const hits = collectMathHits(newState.doc)
                const moved =
                  hits.find((h) => h.kind === active!.kind && h.from === movedFrom) ??
                  hits.find((h) => h.kind === active!.kind && Math.abs(h.from - movedFrom) <= 4) ??
                  hits.find((h) => h.kind === active!.kind && h.tex === active!.active.tex)
                active = moved ? { ...active, active: moved } : null
              }
            }
            const decos = tr.docChanged
              ? buildMathDecorations(newState.doc)
              : value.decos.map(tr.mapping, tr.doc)
            return { active, decos, box: value.box }
          }
        },
        props: {
          decorations(state) {
            const st = mathPreviewKey.getState(state)
            if (!st) return undefined
            const active = st.active
            const box = st.box
            if (!active || !box) return st.decos
            const pos = clamp(active.active.from, state.doc)
            if (active.kind === 'block') {
              // 块级：容器**随正文流**顶替公式原来的位置，同时把那个节点收起来
              //（`.md-math-editing` → `display:none`，见 overlays.css）。
              // `side:-2` = 排在这个节点**之前**（widget 默认会排在节点内容之后）。
              return st.decos.add(state.doc, [
                Decoration.widget(pos, () => box.dom, { side: -2 }),
                Decoration.node(pos, active.active.to, { class: 'md-math-editing' })
              ])
            }
            // 行内：**保留**这条公式的渲染 widget（公式照常显示在浮层下面），
            // 只是额外追加一个浮层。绝不把常驻装饰去掉 —— 去掉就成"公式消失"了。
            return st.decos.add(state.doc, [Decoration.widget(pos, () => box.dom, { side: -1 })])
          },
          handleClick(view, pos, event) {
            const el = event.target as HTMLElement | null
            // 点编辑区自己（✓/textarea）不算"点公式"
            if (el?.closest?.('[data-md-math-editor]')) return false
            const found = el?.closest?.('[data-md-math-rendered],[data-md-math-block]')
            if (!(found instanceof HTMLElement)) return false
            const hit = locate(view.state.doc, pos, found)
            if (!hit) return false
            openMathEditor(view, hit)
            return true // 已处理：别再让 PM 按落点写一次选区
          }
        },
        view: (view) => new MathPreviewView(view, labels)
      })
    ]
  }
})

/**
 * 插件视图：编辑态的**生命周期**（建 / 对齐 / 收）。
 *
 * 两种形态共用一条流水线：
 *   * **行内**：容器挂在编辑区**容器**上（`position: fixed`），要算坐标、要跟着滚动重摆；
 *   * **块级**：容器交给 `props.decorations` 当**块级 widget** 挂进正文流，不用算坐标。
 *
 * 实例都存在**插件 state** 的 `box` 上（不是视图字段）：装饰每次重算都会重新问
 * `st.box` 要 DOM，只有"还是同一个实例对象"时 PM 才不重建那段 DOM —— 这是
 * textarea 在逐键重绘中**不丢焦点**的前提。
 */
class MathPreviewView {
  private view: EditorView
  private labels: MathLabels
  /** 当前会话 id（0 = 没有会话）：用来判断"要不要换实例" */
  private sessionId = 0
  /** 当前会话是哪种形态（换形态时必须换实例，DOM 结构不同） */
  private sessionKind: 'inline' | 'block' | null = null
  private rafId = 0

  /**
   * 视口动了就把**行内浮层**重新贴回公式上。
   *
   * 为什么必须是**捕获**阶段：编辑区正文是可滚动的内层容器，`window` 上收不到它的
   * scroll 事件；捕获阶段能拿到任意后代元素的滚动。用 rAF 合并（滚动一次会连发多次，
   * 每次都量 `getBoundingClientRect` 会抖）。
   */
  private onViewport = (): void => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      const st = mathPreviewKey.getState(this.view.state)
      st?.box?.place()
    })
  }

  constructor(view: EditorView, labels: MathLabels) {
    this.view = view
    this.labels = labels
    this.sync()
    window.addEventListener('scroll', this.onViewport, true)
    window.addEventListener('resize', this.onViewport)
  }

  update(): void {
    this.sync()
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    window.removeEventListener('scroll', this.onViewport, true)
    window.removeEventListener('resize', this.onViewport)
    this.drop()
  }

  private sync(): void {
    const st = mathPreviewKey.getState(this.view.state)
    const active = st?.active ?? null
    if (!st || !active) {
      this.drop()
      return
    }
    // 同一条会话 + 同一种形态 ⇒ 只对齐内容（逐键写回就走这一条，DOM 不重建）
    if (st.box && this.sessionId === active.id && this.sessionKind === active.kind) {
      st.box.pull(active.active.tex)
      st.box.place()
      return
    }
    this.drop()
    const box =
      active.kind === 'block'
        ? new BlockMathEditor(this.view, active.id, this.labels, active.active.from)
        : new InlineMathEditor(this.view, active, this.labels)
    st.box = box
    this.sessionId = active.id
    this.sessionKind = active.kind
    box.pull(active.active.tex)
    if (active.kind === 'inline') {
      // 行内浮层不在 contenteditable 里：挂到编辑区**容器**上
      const host = this.view.dom.parentElement ?? document.body
      host.appendChild(box.dom)
      // 先挂上再摆（还没挂时量不到高度）：下一帧摆一次，避免"先闪一下默认位置"
      box.place()
    } else {
      // 块级：容器由装饰挂进正文流 —— 这里必须**主动重绘一次**，
      // 否则新实例的 DOM 要等下一次事务才会上屏（点击后"什么都没发生"就是这么来的：
      // 开会话的事务 `docChanged` 为假，PM 不会自己重算装饰）。
      this.view.dispatch(this.view.state.tr)
    }
    requestAnimationFrame(() => {
      if (mathPreviewKey.getState(this.view.state)?.box === box) box.focus()
    })
  }

  private drop(): void {
    const st = mathPreviewKey.getState(this.view.state)
    const box = st?.box ?? null
    if (box) {
      box.destroy()
      if (st) st.box = null
      // 容器是装饰挂上去的：摘掉之后要重绘一次才会真的消失（与挂上时同理）
      if (this.sessionKind === 'block') this.view.dispatch(this.view.state.tr)
    }
    this.sessionId = 0
    this.sessionKind = null
  }
}

export type { MathHit }
