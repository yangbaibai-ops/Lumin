// ─── 行内公式的渲染 + 「点击公式 → 上方可编辑源码框」────────────────────────────
//
// 为什么用**装饰**而不是自定义节点：模型里公式的原文必须留在文档里（`$E = mc^2$` 就是一个
// 带 `MdMath` mark 的文本节点），序列化才能逐字写回。渲染成公式是**视图**的事 ——
// 正好是 ProseMirror 装饰的适用场景。
//
// 这套 prosemirror-view（1.42）的 `Decoration` 只提供 `widget` / `inline` / `node`
// （**没有** `replace`），所以「行内公式显示成公式而不是 `$…$`」用两步拼出来：
//   1. `Decoration.widget(from, …)` 在公式起点插入 KaTeX 渲染结果（`contenteditable=false`）；
//   2. `Decoration.inline(from, to, { class: 'md-math-source' })` 给原文加个类，
//      CSS 把它折叠掉（`font-size: 0`）—— 与行内标记（`.md-marker`）同一套手法：
//      **不用 `display: none`**，因为那会破坏浏览器的光标导航。
//
// ⚠️ 铁律（改这个文件前先读）：**只要公式没有被编辑，1 与 2 必须成对出现**。
// 少了 1 就只剩一段被折叠掉的文本 —— 屏幕上**什么都没有**（公式"消失"）。
//
// ─── 交互（第二十九轮按用户口径重做）───────────────────────────────────────────
// 用户原话：「点击公式时，会在公式**上方**展示公式的源码（可编辑），像 Typora 一样，
// 可以编辑公式实时渲染，大小适中、布局合理。」
//
// 所以本轮的语义是**显式**的，不再靠"光标靠近"推断。旧实现（「光标落进公式就露出 `$…$`」）
// 有两个毛病，正好都是用户要修的：
//   ① 在公式旁边打字会把它变成源码 → 看着像闪烁、还引起整段布局跳动；
//   ② 源码只是**原地**把 `$…$` 露出来，不是"上方一个可编辑的框"，跟 Typora 不一样。
//
// 现在的口径：
//   * **永远不会**因为光标靠近而变样 —— 公式恒为渲染态（少了整类布局跳动）；
//   * **点击公式** → 公式**上方**浮出源码编辑框（等宽字体、贴合公式宽度、与公式共用一条
//     `--accent` 边线视觉成组；`position: fixed` ⇒ 不占正文流，不挤动别的内容）；
//   * **逐键实时渲染**：框里每敲一个字符就 dispatch 一次文档事务 ⇒ 文档里的 `$…$` 立即更新
//     ⇒ 公式**原地**重画（不重新打开、不重载文档）；
//   * **Esc** = 收起编辑框（**不改内容**）；**失焦** = 也收起，同样**保留**内容 ——
//     内容一旦敲进去就已经实时写进文档了，两者不需要在"保留/丢弃"上再分叉；
//   * **源码清空**（`''`）= **删除这条公式**（Typora 一致，也是用键盘删掉公式最直观的操作）：
//     行内公式连 `$` 定界符一起删，块级公式删掉整个块节点。
//
// ⚠️ 编辑框**不是 contenteditable 的后代**：它挂在编辑区容器上（`position: fixed`），
// 不参与 ProseMirror 的 DOM 观察与光标导航 —— 放进 contenteditable 里会让 PM 把它当成
// 文档内容的一部分（焦点/选区/输入法都会打架）。
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
  /** 公式**整体**（含 `$` 定界符）的位置：编辑框挂在这个位置之前 */
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
  /** 每次打开换一个 id：新会话的编辑框 DOM 一定是新建的（旧 DOM 的焦点状态不串） */
  id: number
}

interface MathPluginState {
  active: MathSession | null
  /** 常驻装饰（折叠原文 + 渲染 widget）。正在编辑的那条公式**额外**追加一个编辑框 widget */
  decos: DecorationSet
  /** 编辑框实例：跨事务复用 ⇒ `eq()` 为真 ⇒ PM 不重建 DOM ⇒ textarea 不丢焦点 */
  box: SourceBox | null
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

/** 折叠原文 + 渲染公式的常驻装饰（**不含**编辑框：那条按需追加） */
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

// ─── 源码编辑框 ──────────────────────────────────────────────────────────────

/**
 * 编辑框里的三段文案。**由扩展选项注入**（`buildEditorExtensions` 从语言包取），
 * 这样这个模块自己不 `import '../../i18n'`：它是 Tiptap 内核的一部分，而那条 import
 * 会把 Vue 与整份语言包的动态装载拖进 `node --test` 的依赖链（同一个坑见
 * `outlineText.ts` 的注释）。默认值只是"没注入时的兜底"，界面上永远走注入值。
 */
export interface MathLabels {
  inline: string
  block: string
  esc: string
}

/**
 * 兜底文案：**故意留空**。
 *
 * 界面上的值一律由 `buildEditorExtensions` 从语言包注入（三段都是 `t('editor.math*')`），
 * 所以这里的默认值永远不会出现在用户面前。留成空串而不是写一份中文兜底，是为了让
 * `tests/i18nHardcoded.test.mjs`（界面文案不许绕过语言包）对**所有**可能显示出来的
 * 字符串都有约束 —— 一份"反正不会用到"的中文兜底，恰恰是那种以后会真的显示出来的东西。
 */
const DEFAULT_LABELS: MathLabels = { inline: '', block: '', esc: '' }

/**
 * 编辑框 DOM（**固定定位**，挂在编辑区容器上，不在 contenteditable 里）。
 *
 * 布局：顶行是「公式源码」提示（右侧 `Esc` 提示），下面是等宽 textarea；
 * 只有**渲染失败**时才多出一行 KaTeX 预览 —— 此时它是唯一能说清"错在哪"的东西
 * （语法正确时预览与框外那个公式一模一样，多显示一份只是噪音）。
 */
function buildBox(labels: MathLabels): {
  box: HTMLElement
  ta: HTMLTextAreaElement
  preview: HTMLElement
  label: HTMLElement
} {
  const box = document.createElement('div')
  box.className = 'md-math-editor'
  box.setAttribute('data-md-math-editor', '')
  box.setAttribute('contenteditable', 'false')

  const labelRow = document.createElement('div')
  labelRow.className = 'md-math-editor__label'
  const label = document.createElement('span')
  label.setAttribute('data-md-math-editor-label', '')
  label.textContent = labels.inline
  const hint = document.createElement('span')
  hint.className = 'md-math-editor__hint'
  hint.textContent = labels.esc
  labelRow.append(label, hint)

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
  ta.setAttribute('aria-label', labels.inline)

  const preview = document.createElement('div')
  preview.className = 'md-math-editor__preview'
  preview.setAttribute('data-md-math-editor-preview', '')

  box.append(labelRow, ta, preview)
  return { box, ta, preview, label }
}

/**
 * 公式**真正的横向范围**（用它量宽度，而不是量元素盒）。
 *
 * 为什么不能用 `getBoundingClientRect().width`：块级公式的 `.katex-html` 是
 * `display:block`，`.katex-display > .katex` 也是 `block` —— 它们的盒宽是**整列宽**
 * （实测 928px），拿它当"公式宽度"会把源码框拉成一条通栏，与"贴合公式"相反。
 * 用 `Range` 选中 `.katex-html` 的内容量到的才是**字形本身**的范围
 * （实测同一条公式 106px、整列 928px）。
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
 * 把编辑框摆到**公式上方**（用 `getBoundingClientRect` 算，不写死坐标）。
 *
 * 三条口径：
 *   * **上方优先**（用户明确要"上方"）；上方真的放不下（公式在文档第一行/滚动到视口顶部）
 *     才翻到下方 —— 硬贴上方会顶出视口，那比"在下方"更糟。翻没翻由
 *     `data-md-math-editor-side` 如实给出，套件据此断言而不猜坐标。
 *   * **宽度贴公式**（下限 280，上限贴视口）：量的是**字形范围**（见 `inkRect`），
 *     不是 KaTeX 那个整列宽的 `block` 盒。
 *   * 横向**在公式上方居中**（与公式"视觉成一组"），并整体夹在视口内；纵向与公式留 8px。
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
  // 横向：把框的中心对到公式字形的中心（块级公式因此正好压在它上面，不会贴到列首）
  const center = (ink ? ink.left : r.left) + (ink ? ink.width : r.width) / 2
  const left = center - box.offsetWidth / 2
  box.style.left =
    Math.round(Math.min(Math.max(12, left), Math.max(12, vw - box.offsetWidth - 12))) + 'px'
  return side
}

/** 编辑框里那段小预览（只在渲染失败时显示：它是唯一能说清"错在哪"的东西） */
function renderBoxPreview(
  box: HTMLElement,
  preview: HTMLElement,
  tex: string,
  display: boolean
): void {
  if (!tex.trim()) {
    preview.textContent = ''
    preview.style.display = 'none'
    box.removeAttribute('data-md-math-invalid')
    return
  }
  const { html, error } = mathRenderInfo(tex, display)
  preview.innerHTML = html
  preview.style.display = error ? '' : 'none'
  // 错误态跟着**真实的 KaTeX 产物**走（认 `katex-error`），不靠正则猜公式合不合法
  if (error) box.setAttribute('data-md-math-invalid', '')
  else box.removeAttribute('data-md-math-invalid')
}

/**
 * 源码编辑框：**自己监听输入**并把源码写回文档（逐键），不依赖 Vue 的响应式。
 *
 * 为什么把"输入"做在 DOM 事件里而不是走受控组件：编辑框不是文档的一部分（它固定在编辑区
 * 容器上），走 Vue 只会把数据流绕远；这里唯一的真相仍然是**文档**（`pull()` 每次从
 * `view.state.doc` 读回内容），所以撤销/存盘重载/外部替换都能自然对齐。
 */
class SourceBox {
  readonly dom: HTMLElement
  private ta: HTMLTextAreaElement
  private preview: HTMLElement
  private label: HTMLElement
  private view: EditorView
  private session: MathSession
  private labels: MathLabels
  /** 正在由本对象回写文档：避免 `input → dispatch → pull` 的自激 */
  private writing = false
  /** 输入法组合中：组合期间不回写（会把中文输入打断成一个个字母） */
  private composing = false

  constructor(view: EditorView, session: MathSession, labels: MathLabels) {
    this.view = view
    this.session = session
    this.labels = labels
    const built = buildBox(labels)
    this.dom = built.box
    this.ta = built.ta
    this.preview = built.preview
    this.label = built.label

    this.ta.value = session.active.tex
    this.ta.addEventListener('input', this.onInput)
    this.ta.addEventListener('keydown', this.onKeyDown)
    this.ta.addEventListener('blur', this.onBlur)
    this.ta.addEventListener('compositionstart', this.onCompositionStart)
    this.ta.addEventListener('compositionend', this.onCompositionEnd)
    // 编辑框里的鼠标动作**不要**冒泡到编辑区（PM 会据此改选区/触发点击语义）
    this.dom.addEventListener('mousedown', (e) => e.stopPropagation())
    this.dom.addEventListener('click', (e) => e.stopPropagation())
    this.pull()
  }

  /** `eq` 恒真：同一个会话里 PM 不重建这个 widget 的 DOM（textarea 因此不丢焦点） */
  eq(): boolean {
    return true
  }

  /** 会话换成别的一条公式（或公式内容被外部改过）时对齐 */
  setSession(session: MathSession): void {
    this.session = session
    this.pull()
  }

  /** 文档里的真值 ⇒ 编辑框（源码 + 错误态预览） */
  pull(): void {
    const live = locateLive(this.view, this.session)
    if (!live) return
    if (!this.writing && this.ta.value !== live.tex) this.ta.value = live.tex
    this.label.textContent = this.session.kind === 'block' ? this.labels.block : this.labels.inline
    renderBoxPreview(this.dom, this.preview, this.ta.value, this.session.kind === 'block')
    this.autosize()
  }

  /**
   * 公式的**可视盒**：`anchor` 用来算"上方有没有位置"，`line` 用来量宽度。
   *
   * 两者为什么分开：块级公式的外层 `.md-math-block` 是**整列宽**（`text-align:center` +
   * `overflow-x:auto`），拿它量宽度会得到整个正文列的宽度 —— 源码框就会拉成一条通栏大条，
   * 与用户口径的"贴合公式、与公式成一组"相反。真正的公式宽度在 KaTeX 的
   * `.katex-html` 上（`white-space:nowrap` 的那个行盒）。
   */
  anchor(): { anchor: HTMLElement; line: HTMLElement } | null {
    const doc = this.view.state.doc
    let el: HTMLElement | null = null
    try {
      const dom = this.view.nodeDOM(clamp(this.session.active.from, doc))
      el = dom instanceof HTMLElement ? dom : null
    } catch {
      el = null
    }
    if (!el) {
      // 位置暂时无效（视图正在重建 / 节点还没挂上）→ 按文档位置在编辑区里找最近的公式
      const all = Array.from(
        this.view.dom.querySelectorAll<HTMLElement>('[data-md-math-rendered],[data-md-math-block]')
      )
      for (const candidate of all) {
        if (this.session.kind === 'block') {
          if (candidate.hasAttribute('data-md-math-block')) {
            el = candidate
            break
          }
        } else {
          const pos = this.view.posAtDOM(candidate, 0)
          if (Math.abs(pos - this.session.active.from) <= 1) {
            el = candidate
            break
          }
        }
      }
    }
    if (!el) return null

    const rendered = el.matches('[data-md-math-rendered]')
      ? el
      : el.querySelector<HTMLElement>('[data-md-math-rendered]')
    if (rendered && this.session.kind === 'inline') {
      return { anchor: rendered, line: rendered }
    }
    const block = el.matches('[data-md-math-block]')
      ? el
      : (el.closest<HTMLElement>('[data-md-math-block]') ?? null)
    if (block) {
      // 纵向锚点用 `.katex-display`（KaTeX 自己的那块，margin 已由 CSS 归零），
      // 不用外面那个 `.md-math-block`（它带自己的 padding，会把框推远一点点）；
      // 横向字形范围用 `.katex-html`：那是居中块，只有 Range 才量得到真宽度。
      const line = block.querySelector<HTMLElement>('.katex-html') ?? block
      const display = block.querySelector<HTMLElement>('.katex-display')
      return { anchor: display ?? block, line }
    }
    return rendered ? { anchor: rendered, line: rendered } : null
  }

  /** 摆到公式上方（上方放不下就翻到下方），宽度贴公式 */
  place(): void {
    const target = this.anchor()
    if (!target) return
    const side = placeBox(this.dom, target.anchor, target.line)
    this.dom.setAttribute('data-md-math-editor-side', side)
  }

  focus(): void {
    this.ta.focus({ preventScroll: true })
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length)
  }

  destroy(): void {
    this.ta.removeEventListener('input', this.onInput)
    this.ta.removeEventListener('keydown', this.onKeyDown)
    this.ta.removeEventListener('blur', this.onBlur)
    this.ta.removeEventListener('compositionstart', this.onCompositionStart)
    this.ta.removeEventListener('compositionend', this.onCompositionEnd)
    this.dom.remove()
  }

  /** 一次按键/一行内容 ⇒ 高度跟着走（`rows=1` 只是下限，长公式要能看全） */
  private autosize(): void {
    this.ta.style.height = 'auto'
    this.ta.style.height = Math.min(this.ta.scrollHeight, 8 * 24) + 'px'
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

  /** 编辑框 → 文档（逐键）。文档一变，本插件的装饰就跟着重算 ⇒ 公式原地重画 */
  private commit(): void {
    this.writing = true
    try {
      applySource(this.view, this.ta.value)
    } finally {
      this.writing = false
    }
    this.pull()
    this.place()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeSession(this.view)
      this.view.focus()
      return
    }
    // Tab 在源码框里应当是"缩进"（`\begin{align}` 这类多行公式要能排版），
    // 不是"跳到下一个控件" —— 否则这条框一按 Tab 就没了
    if (e.key === 'Tab') {
      e.preventDefault()
      const { selectionStart: a, selectionEnd: b, value } = this.ta
      this.ta.value = value.slice(0, a) + '  ' + value.slice(b)
      this.ta.setSelectionRange(a + 2, a + 2)
      this.commit()
    }
  }

  /** 失焦也收起，但**保留内容**（内容早就逐个字符实时写进文档了） */
  private onBlur = (): void => {
    closeSession(this.view)
  }
}

/** 按会话找到**当前文档里**对应的那一段公式（位置可能已被编辑映射过） */
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

/**
 * 把源码写回文档（**唯一的写入口**：逐键输入、输入法组合结束、Tab 缩进都走这里）。
 *
 * 写的是「公式内容」那一段区间 —— 定界符 `$` 与（块级的）节点身份都不动。
 * 源码为空 ⇒ 删除整条公式（语义见文件头的交互说明）。
 * @returns 是否真的改动了文档
 */
export function applySource(view: EditorView, tex: string): boolean {
  const session = mathPreviewKey.getState(view.state)?.active
  if (!session) return false
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

/** 这一段公式**当前**的原文（行内从文本节点读、块级从节点属性读） */
function currentTex(state: EditorState, live: MathHit, kind: 'inline' | 'block'): string {
  if (kind === 'inline') return live.tex
  return String(state.doc.nodeAt(live.from)?.attrs.source ?? '')
}

// ─── 插件 ────────────────────────────────────────────────────────────────────

/**
 * 打开源码框的事务元数据（**只挂在事务上**，不进文档、不参与序列化）。
 * `{kind:'close'}` = 收起；否则 = 打开/换到这条公式。
 */
type MathSessionMeta = { session: { kind: 'close' } | { kind: 'open'; hit: MathHit; id: number } }

/** 打开源码编辑框（**只改视图**：文档内容一个字符都不动） */
export function openMathEditor(view: EditorView, hit: MathHit): void {
  view.dispatch(
    view.state.tr.setMeta(mathPreviewKey, {
      session: { kind: 'open', hit, id: Date.now() + Math.random() }
    } satisfies MathSessionMeta)
  )
}

/** 收起源码编辑框（Esc / 失焦；**保留**已写进文档的内容） */
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
              // 文档变了（逐键写回 / 撤销 / 外部替换）：把"正在编辑哪一段"跟着映射过去
              const hits = collectMathHits(newState.doc)
              const moved =
                hits.find((h) => h.kind === active!.kind && h.from === active!.active.from) ??
                hits.find(
                  (h) =>
                    h.kind === active!.kind &&
                    Math.abs(h.from - active!.active.from) <= Math.max(2, tr.steps.length * 4)
                ) ??
                hits.find((h) => h.kind === active!.kind && h.tex === active!.active.tex)
              active = moved ? { ...active, active: moved } : null
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
            if (!st.active) return st.decos
            // 正在编辑：**保留**这条公式的渲染 widget（公式照常显示在框下面），
            // 只是额外追加一个编辑框。绝不把常驻装饰去掉 —— 去掉就成"公式消失"了。
            const pos = clamp(st.active.active.from, state.doc)
            const box = st.box
            return st.decos.add(state.doc, [
              Decoration.widget(pos, () => (box ? box.dom : document.createElement('span')), {
                side: -1
              })
            ])
          },
          handleClick(view, pos, event) {
            const el = event.target as HTMLElement | null
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
 * 插件视图：编辑框的**生命周期**（建/摆/对齐/收）。
 *
 * 为什么还要一个 view 而不是全放在装饰里：摆位置要 `getBoundingClientRect`（要等 DOM 挂上、
 * 要跟着滚动/窗口尺寸重算），这些只能在视图层做。编辑框实例存在**插件 state** 上，
 * 所以事务重算不会把它换掉（textarea 因此不丢焦点）。
 */
class MathPreviewView {
  private view: EditorView
  private labels: MathLabels
  private box: SourceBox | null = null
  private sessionId = 0
  private rafId = 0
  /**
   * 视口动了就把框重新贴回公式上。
   *
   * 为什么必须是**捕获**阶段：编辑区正文是可滚动的内层容器，`window` 上收不到它的
   * scroll 事件；捕获阶段能拿到任意后代元素的滚动。用 rAF 合并（滚动一次会连发多次，
   * 每次都量 `getBoundingClientRect` 会抖）。
   */
  private onViewport = (): void => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      this.box?.place()
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
    if (!active) {
      this.drop()
      return
    }
    if (!this.box || this.sessionId !== active.id) {
      this.drop()
      const box = new SourceBox(this.view, active, this.labels)
      this.box = box
      this.sessionId = active.id
      // 编辑框挂到编辑区**容器**上（不在 contenteditable 里）
      const host = this.view.dom.parentElement ?? document.body
      host.appendChild(box.dom)
      // 先挂上再摆（还没挂时量不到高度）：下一帧摆一次，避免"先闪一下默认位置"
      box.place()
      requestAnimationFrame(() => {
        if (this.box === box) {
          box.place()
          box.focus()
        }
      })
      st!.box = box
      return
    }
    this.box.setSession(active)
    this.box.place()
  }

  private drop(): void {
    if (!this.box) return
    const st = mathPreviewKey.getState(this.view.state)
    if (st) st.box = null
    this.box.destroy()
    this.box = null
    this.sessionId = 0
  }
}

export type { MathHit }
