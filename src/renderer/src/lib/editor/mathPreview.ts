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
//   * **源码清空**（`''`）：**块级保留框架**（`source: ''` + 渲染区 `< Empty Math Block >`，
//     第九轮口径）；**行内删掉整条**（连两侧 `$` 定界符一起，见 `deleteMathNode`）。
//   * **空源码框里按退格/Delete** = 删掉整条公式（第十轮口径，见 `deleteMathNode`）；
//     源码**非空**时退格只删字符 —— 判据是"按下的那一刻源码框为空"。
//
// ⚠️ 编辑区**不是 contenteditable 的后代**：块级容器挂在 NodeView 的 `dom` 上但整棵
// `contenteditable="false"`；行内浮层挂在编辑区容器上。两者的 textarea 都不参与
// ProseMirror 的 DOM 观察与光标导航。
//
// ─── 第三十一轮：源码区"打不进字 / 点一下就收"的三条真因（都是实测出来的）─────────────
//
// ① **块级源码区里的按键被 ProseMirror 抢走**（不是"DOM 重建丢焦点"，那条被实测证伪：
//    打戳后连敲、连做 5 种事务，textarea 元素与焦点都没动过）。块级编辑容器是**块级
//    widget**，它的 DOM 就在 `view.dom`（contenteditable 根）**里面** —— 于是 textarea 上的
//    按键会冒泡到 PM，被 `editHandlers.keypress` 接走：点击原子节点让选区成了 `NodeSelection`
//    （不是 TextSelection），PM 走的是"把字符插进文档"那一支 —— `tr.insertText(ch)` +
//    `preventDefault()`。结果是**整条 `$$…$$` 被这个字符替换掉**（文档被改坏），
//    而且 textarea 一个字符都没收到（`input` 事件根本不发生）。行内浮层挂在
//    `view.dom.parentElement` 上（PM 之外），所以只有块级出这个问题。
//    修法：widget 规格加 `stopEvent`（PM 的 `eventBelongsToView` 见到它就整类忽略）
//    ＋ `ignoreSelection`，与 `codeBlock.ts` 对 CodeMirror 的处置同一套路；
//    代价是 PM 的历史快捷键也收不到了，所以撤销/重做由源码区**自己派给 PM 的 history**
//    （与 `CodeBlockView.onCmHistoryKey` 的口径一致）。
// ② **点源码区就收起**：`blur → closeSession` 把"点 `$$` 行 / 点源码区空白 / 点顶行"
//    也当成了失焦（那些元素不是 textarea）。修法：非文本框上的 mousedown 一律
//    `preventDefault()`（焦点根本不离开 → 不触发 blur）并把焦点交回源码框；
//    blur 本身也改成**下一帧再判定**，焦点仍在容器内就不收起。
// ③ **公式要高亮**：`<textarea>` 没法只染一部分文本。做法是"镜像层"：透明的输入层
//    ＋ 同文本的装饰层（见 `mathHighlight.ts` 的模块头，对齐口径见 CSS）。
//
// ─── 第三十二轮（用户第九轮反馈）：形态收敛 + 行内可编辑 + 不可拖 + `$$`⏎ + 空公式 ────
//
// ① **源码区不再是一个"输入框"**：`.md-math-editor__src` 的边框/描边/
//    `:focus-visible` 外环全部去掉（底色与留白区分即可，`$$` 行保留成装饰性提示）；
//    「公式 ✓」从"占一整行的顶栏"改成**贴在容器右上角的绝对定位小标记**（不参与流、
//    不撑高容器）。焦点可见性改由**容器**的 `:focus-within` 边框给出（见 overlays.css
//    与 tests/focusVisibility.test.mjs 的登记）。
// ② **行内源码区也能编辑**：真因是"行内 widget 没挂 `stopEvent`"（详见上面 blockBoxShape
//    的说明）+ 手动 `appendChild` 与装饰重复挂载导致 DOM 被搬来搬去；修法是两种形态
//    共用一个屏蔽口径，并统一由装饰挂载（`MathPreviewView.sync()` 里不再手动 append）。
// ③ **公式不可拖拽**：见 `dragRules.blocksMathDrag`（只拦数学节点，图片/表格照旧）。
// ④ **`$$` + 回车 = 空公式块 + 直接进编辑态**：`props.handleKeyDown` 里认"整段恰好是 `$$`"
//    的段落（行中间不误触发、代码块不认识这个按键），插一个 `mathBlock` 节点后立刻开会话。
// ⑤ **空公式保留框架**：块级源码为空时**不再删节点**（`source: ''`），渲染区/预览区显示
//    `< Empty Math Block >`（只存在于视图，**序列化里一个字都不加**）。
//
// ─── 第三十三轮（用户第十轮反馈）：空公式块的"出路" + 逐键打字的行内公式 ───────────────
//
// ① **空公式块里按退格没反应**：不是"被谁拦了"，而是**两端都没有处理者** —— 空 textarea
//    对退格本来就不做事，而它的按键又被 widget 的 `stopEvent` 挡在 PM 之外（那是打字能
//    进去的前提）。修法：源码框为空时按退格/Delete = `deleteMathNode()` 删整条（一个事务、
//    一步撤销、光标交回编辑器）。源码非空时退格**只删字符**（判据是按下那一刻是否为空）。
//    光标紧贴块两端（块前段落行尾按 Delete / 块后段落行首按退格）与"块被选中后按退格"
//    本来就走 PM/Tiptap 的既有路径（实测一次即删、可撤销），本轮只补了回归断言。
// ② **逐键敲 `$E=mc^2$` 没有行内公式出现**：`MdMath` 这个 mark **只由 markdown 解析产生**，
//    而 markdown-it 只在"把 markdown 读进编辑器"时跑 —— **逐键打字不经过它**（实测：每个
//    中间态的渲染 widget 数恒为 0，连 `[data-md-math]` 节点都没有；光标位置/段落位置无关）。
//    修法：给 `MdMath` 加一条 **输入规则**（收尾 `$` 落下那一刻收成公式），判据复用
//    `matchInlineMathAtCaret` ⇒ 与解析规则同一套口径（见 mathMarkers.ts / mathScan.ts）。
import { Extension } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Fragment, type Mark, type Node as PMNode } from '@tiptap/pm/model'
import { fillHighlight } from './mathHighlight'
import { emptyMathDom, mathRenderInfo } from './mathMarkers'
import { scanInlineMathSpans } from '../mathScan'
// 幂等安装的小工具（第五十五轮）：同 key 只留最新一份监听（见 `installOnce` 的说明）
import { installOnce } from './inlineMarkerCore.ts'

/** 「焦点 / 组字变化要重算插入符」的四个 DOM 事件（装与卸必须用同一份清单） */
const CARET_FLAG_EVENTS = ['focus', 'blur', 'compositionstart', 'compositionend'] as const

/**
 * 视口/焦点监听的**清理函数**，按 `view` 存。
 * `window` 与 `view.dom` 都比本视图实例活得久（HMR 下尤其），所以安装必须幂等 —— 见
 * `MathPreviewView.installViewport`。
 */
const mathViewportUninstall = new WeakMap<EditorView, () => void>()

const mathPreviewKey = new PluginKey<MathPluginState>('lumin-math-preview')

/**
 * 源码区**自己处理**的事件类型（与 `codeBlock.ts` 给 CodeMirror 的那张表同一套路）。
 *
 * 为什么要交给它自己：块级源码区是 PM 的 widget，DOM 就在 contenteditable 根里面 ——
 * 只要有一个按键冒泡上去，PM 的 keypress / keymap 就会按**文档选区**（点击原子节点得到的
 * `NodeSelection`）去执行 `tr.insertText(ch)`，把整条 `$$…$$` 换成那个字符（实测：敲一个 `x`，
 * 公式消失、doc 里多出一个 `x` 段落）。这张表里的类型一律让 PM 视而不见。
 */
const MATH_BOX_EVENTS = new Set([
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'keypress',
  'input',
  'beforeinput',
  'cut',
  'copy',
  'paste',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'touchstart',
  'touchmove',
  'touchend'
])

/**
 * `Decoration.widget` 的 `stopEvent`：落在源码区（或它的任何子节点）里的事件，PM 不处理。
 *
 * 必须是**模块级同一份引用**：`WidgetType.eq` 会用 `compareObjs` 逐个属性比 `spec`，
 * 每次重绘现造一个闭包会让 spec 永远不相等（见 `blockBoxShape` 的说明）。
 */
function stopMathBoxEvents(event: Event): boolean {
  const target = event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (!target.closest('[data-md-math-editor]')) return false
  return MATH_BOX_EVENTS.has(event.type)
}

/**
 * 编辑容器的 widget 规格**形状**：`side`（块级排在这个节点之前 / 行内贴在公式前）+
 * 对 PM 屏蔽事件（见 `stopMathBoxEvents`）+ 忽略装饰层内部的选区变化。
 *
 * 这里定的是"形状"（逐属性相等即可），真正交给 `Decoration.widget` 的是每个会话在
 * `MathEditorBase.widgetSpec` 里合成的**同一份对象**：`spec.key` 相等时 `WidgetType.eq`
 * 直接返回 true，`toDOM` 的引用相等是第二道保险 —— 两道都成立，PM 才不会拆掉 textarea。
 *
 * ⚠️ **两种形态都要 `stopEvent`**（第九轮修正）：行内浮层虽然是用 `appendChild` 挂到
 * `view.dom.parentElement` 上"想"避开 PM，但 `props.decorations` 里的那条 widget 会把
 * 同一个 DOM 收进**段落内部**（实测 `box.parentElement` 是 `P`）—— 于是行内源码区同样在
 * `view.dom` 里，PM 照样接管它的按键：`Ctrl+A` 会被 `selectAll` 抢成 `AllSelection`，
 * 紧接着敲一个字就被 `editHandlers.keypress` 拿去 `tr.insertText`（源码框一个字没进、
 * 编辑态直接消失）。上一轮只给块级挂了 `stopEvent`，这就是"块级修好了行内还没有"的原因。
 */
const blockBoxShape = { side: -2, stopEvent: stopMathBoxEvents, ignoreSelection: true }

/** 行内：同一个屏蔽口径，只是排布方向不同（`side: -1`） */
const inlineBoxShape = { side: -1, stopEvent: stopMathBoxEvents, ignoreSelection: true }

/** `Decoration.widget` 的 spec 里我们用得到的那几项（`key` 由会话实例自己补） */
type MathWidgetShape = {
  side?: number
  stopEvent?: (event: Event) => boolean
  ignoreSelection?: boolean
}

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
    /**
     * 一段 marked 文本里可能有**多条**公式：相邻的 marked 文本节点会被上面的合并逻辑并成一段，
     * 并起来之后 `$a$` + `$b$` 就成了 `$a$$b$`。按 `scanInlineMathSpans`（与 markdown-it
     * 同一个配对函数）切出来的区间分别渲染；**切不出区间的部分不是公式**，不交给 KaTeX
     * —— 改前这里会把带 `$` 的原文直接喂给 KaTeX，屏上就弹
     * `Can't use function '$' in math mode`（第十二轮用户报的那条）。
     * 正常情况下"不配平"的 mark 会被 `MdMath` 的归一化摘掉，这里是**第二道保险**。
     */
    for (const piece of scanInlineMathSpans(raw)) {
      const from = span.from + piece.from
      const to = span.from + piece.to
      out.push({
        kind: 'inline',
        from,
        to,
        innerFrom: from + 1,
        innerTo: to - 1,
        tex: raw.slice(piece.from + 1, piece.to - 1)
      })
    }
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
    decos.push(Decoration.inline(hit.from, hit.to, { class: 'md-math-source' }))
    /**
     * ⚠️ `key` 是必须的：`WidgetType.eq` 里 `toDOM` 要**引用相等**才复用 DOM，而这里每次
     * 重算装饰都会现造一个闭包 —— 少了 key，逐键写回会把文档里**每一个**行内公式的渲染
     * 节点拆掉重造（实测：一次按键里 4 次 added/removed 同一段 `SPAN.md-math-rendered`）。
     * key 里带 `tex` 是关键的一半：内容变了就必须换 key（否则会复用旧 DOM ⇒ 画面停在旧公式）。
     *
     * 位置是 `hit.from`（`side: -1`）：渲染结果插在公式**起点**，后面紧跟被折叠成 0 宽的原文
     * ⇒ 视觉上渲染结果正好顶替原文的位置。
     *
     * ⚠️ 试过把它挪到 `hit.to`（右边界）想让"公式右边界"变成 DOM 子节点边界、好让光标有正常
     * 高度 —— **实测无效**：PM 会把位置解析进 `Decoration.inline` 包装出的那个 span 内部的文本
     * 节点（`docView.domFromPos` 会下钻到装饰包装里），光标照样落在 `font-size: 0` 的文本片段上、
     * 高度仍是 0。见第十一轮报告里"右边界光标可见性"一节。
     */
    decos.push(
      Decoration.widget(hit.from, () => mathDom(hit.tex), {
        side: -1,
        key: `md-math-rendered:${hit.from}:${hit.tex}`
      })
    )
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

// ─── 自绘插入符（第十二轮）─────────────────────────────────────────────────────

/**
 * 光标所在位置若落在**某个行内公式的文本区间**里，返回这段 marked 文本的区间（文档坐标）。
 *
 * 为什么需要它：折叠后的原文是 `font-size: 0`（`.md-math-source`，见 overlays.css），
 * 落在它内部的插入符由这段文本片段的字体度量决定 —— 字号 0 的片段没有行高，实测
 * `getSelection().getRangeAt(0).getBoundingClientRect().height === 0`：
 * **原生插入符画不出来**（用户在段落末尾的公式右侧点一下，界面上就是"没有光标"，
 * 虽然模型里的选区是对的、键盘打进去的字也确实落在正文 —— 见第十二轮报告的实测）。
 *
 * 这里的范围**刻意收窄**：只在"位置确实处于行内公式的 marked 文本区间内（含左右两个边界）"
 * 时才算命中，别的地方一律返回 null ⇒ 其它位置仍然用原生插入符，行为一点不变。
 *
 * 实现上只走"光标所在文本块内的相邻文本节点"（不去遍历整篇文档），逐键重绘也不会有额外开销。
 */
function inlineMathRunAt(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(clamp(pos, doc))
  if (!$pos.parent.isTextblock) return null
  const isMarkedText = (node: PMNode | null | undefined): boolean =>
    !!node && node.isText && !!node.marks.some((m) => m.type.name === 'mdMath')
  // 位置两侧只要有一侧是带 mark 的文本，就说明光标贴在这段公式上（边界也算）
  if (!isMarkedText($pos.nodeBefore) && !isMarkedText($pos.nodeAfter)) return null
  const parent = $pos.parent
  const index = $pos.index()
  let from = $pos.pos
  let to = $pos.pos
  for (let i = index - 1; i >= 0; i -= 1) {
    const node = parent.child(i)
    if (!isMarkedText(node)) break
    from -= node.nodeSize
  }
  for (let i = index; i < parent.childCount; i += 1) {
    const node = parent.child(i)
    if (!isMarkedText(node)) break
    to += node.nodeSize
  }
  return to > from ? { from, to } : null
}

/**
 * 自绘插入符的 DOM。
 *
 * ⚠️ 必须是**模块级同一份引用**（与 `stopMathBoxEvents` 同一个理由）：`WidgetType.eq` 在
 * `spec.key` 不同的时候要求 `toDOM` **引用相等**才复用 DOM；现造闭包会让 PM 每次重绘都拆掉
 * 重插，而它正好在光标位置上 —— 拆插会让插入符闪一下（甚至闪烁成两个）。
 */
function caretDom(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'md-math-caret'
  el.setAttribute('data-md-math-caret', 'true')
  el.setAttribute('contenteditable', 'false')
  return el
}

/**
 * 自绘插入符要不要画（**视图级开关**，不进插件 state）。
 *
 * 三个条件（用户口径：失焦/窗口不活跃时隐藏、组字期间让原生接管）：
 *   * 编辑器有焦点（`view.hasFocus()`）；
 *   * 不在输入法组字中（`view.composing`）；
 *   * 没有开着的编辑会话（编辑态时焦点在源码框里，正文里不该冒插入符）。
 * 由 `MathPreviewView` 在 focus / blur / compositionstart / compositionend 时更新并触发一次重绘。
 */
interface CaretVisibility {
  focused: boolean
  composing: boolean
}

/**
 * `pos` 是否**严格落在**某段行内公式内部（`run.from < pos < run.to`）。
 *
 * ⚠️ 判据不能用位置的 `nodeBefore/nodeAfter`：位置落在**同一个文本节点内部**时两者都是
 * `null`（而公式原文恰恰是**一个**文本节点）—— 那样写等于永远返回 null（实测：方向键
 * 完全不接管）。这里改成在光标所在块里把相邻的 `mdMath` 文本节点并成区间，再判 `pos` 在不在内部。
 *
 * 与 `inlineMathRunAt` 的分工：后者把左右**边界**也算命中（画插入符要用它 —— 边界处原生
 * 插入符高度是 0）；这里只认内部，因为只有内部才是那个**看不见又打得进去**的陷阱位置
 * （见 `crossInlineMathOnArrow`）。
 */
function inlineMathRunAround(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(clamp(pos, doc))
  if (!$pos.parent.isTextblock) return null
  const blockStart = $pos.start()
  const isMarkedText = (node: PMNode): boolean =>
    node.isText && !!node.marks.some((m) => m.type.name === 'mdMath')
  let run: { from: number; to: number } | null = null
  $pos.parent.forEach((child, offset) => {
    if (run) return
    const from = blockStart + offset
    const to = from + child.nodeSize
    if (isMarkedText(child) && from < pos && pos < to) run = { from, to }
  })
  return run
}

/**
 * ← / → **不许停在行内公式内部**（第三十五轮报障 B：「点击左右键无法在行内公式前后移动」）。
 *
 * 实测事实（见报告）：方向键的**模型**位置本来就一步步走得通（`11→10→…→1`，能到公式之前），
 * 坏的是另外两件事：
 *   ① 那些位置**画在同一处**（公式右边缘 —— 折叠原文在 DOM 里排在渲染 widget 之后，
 *      见 `caretDecorations`）⇒ 用户看到的是"插入符钉在公式右边一动不动"；
 *   ② 停在折叠原文内部时，接着敲的字会**落进公式源码**（那段文本 `font-size: 0`，
 *      用户看不见自己在改什么）。
 *
 * 所以这里把"跨过公式"做成**一步**：候选位置（`sel.from + dir`）若落在某段公式**内部**
 * （`inlineMathRunAround`），就按方向跳到那段公式的起点之前 / 终点之后
 * （← 落 `run.from`、→ 落 `run.to`）。于是"公式之后按 ←"一次就到公式之前、
 * "公式之前按 →"一次就到公式之后 —— 与用户预期一致，也彻底消掉"停在隐藏原文里打字"的陷阱。
 *
 * 放行条件（一条都不许少）：只认 **ArrowLeft / ArrowRight**、空 `TextSelection`、无
 * Shift/Ctrl/Cmd/Alt（扩选与按词/按行跳转照旧）、非组字态。
 * 点公式进编辑态那条路不受影响：源码框的事件被 `stopEvent` 挡在 PM 之外，进不到这里。
 *
 * @returns 是否已接管这次按键（true = 调用方要 `preventDefault`）
 */
function crossInlineMathOnArrow(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
  if (event.isComposing || view.composing) return false
  const sel = view.state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return false
  const dir = event.key === 'ArrowLeft' ? -1 : 1
  const run = inlineMathRunAround(view.state.doc, sel.from + dir)
  if (!run) return false
  const dest = dir < 0 ? run.from : run.to
  const $dest = view.state.doc.resolve(clamp(dest, view.state.doc))
  const near = TextSelection.near($dest, dir) ?? TextSelection.near($dest, -dir)
  if (!near) return false
  if (!view.state.selection.eq(near)) {
    view.dispatch(view.state.tr.setSelection(near).scrollIntoView())
  }
  event.preventDefault()
  return true
}

/**
 * 需要自绘插入符时给出那一条装饰，否则 `null`。
 *
 * 拆成独立函数是为了让"要不要画"这件事一眼可读，也方便和 `CaretVisibility` 的注释对照。
 *
 * ⚠️ 第三十五轮（用户复报「无法在行内公式的前后移动光标」）修的是**画在哪一侧**：
 * 折叠后的原文（`.md-math-source`，`font-size: 0`）在 DOM 里排在**渲染 widget 之后**
 * （`buildMathDecorations` 把 widget 挂在 `hit.from`），于是 `run.from … run.to-1` 这些位置
 * 的原生/自绘插入符**全都画在公式右边缘**（实测：行首公式 pos=1..10 的 caretRect 都是
 * `[393,195,1,17]`，而公式左缘是 320）。后果是"按 ← 从公式之后往回走"时插入符**看着一动不动**
 * 地钉在右边缘，用户报的"没法在公式前面落光标 / 没法前后移动"就是它。
 *
 * 修法：**按位置选边**，而不是按 DOM 顺序 ——
 *   * `pos >= run.to`（公式之后）⇒ 排在渲染 widget **之后**（`side: 1`，落在公式右边缘）；
 *   * 其余（公式之前 + 折叠原文内部）⇒ 排在渲染 widget **之前**（`side: -2`；
 *     渲染 widget 自己是 `side: -1`，PM 的 `iterDeco` 对同位置 widget 按 `side` 升序排，
 *     所以 -2 会插到它前面）⇒ 落在公式**左边缘**。
 */
function caretDecorations(
  state: EditorState,
  active: MathSession | null,
  box: MathEditorBase | null,
  caret: CaretVisibility
): Decoration[] | null {
  if (!caret.focused || caret.composing) return null
  // 编辑态开着时焦点在源码框里（`stopEvent` 把正文事件挡住），正文里不该冒插入符
  if (active && box) return null
  const sel = state.selection
  if (!sel.empty) return null
  const run = inlineMathRunAt(state.doc, sel.from)
  if (!run) return null
  const past = sel.from >= run.to
  return [
    Decoration.widget(past ? run.to : run.from, caretDom, {
      side: past ? 1 : -2,
      key: `md-math-caret:${past ? 'end' : 'head'}:${sel.from}`
    })
  ]
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
  /** 「Esc」提示（只在行内浮层上给） */
  esc: string
  /** 空公式的占位文案（`< Empty Math Block >`；**只画在视图上，不进文档**） */
  empty: string
}

/**
 * 兜底文案：**故意留空**。
 *
 * 界面上的值一律由 `buildEditorExtensions` 从语言包注入（每一段都是 `t('editor.math*')`），
 * 所以这里的默认值永远不会出现在用户面前。留成空串而不是写一份中文兜底，是为了让
 * `tests/i18nHardcoded.test.mjs`（界面文案不许绕过语言包）对**所有**可能显示出来的
 * 字符串都有约束 —— 一份"反正不会用到"的中文兜底，恰恰是那种以后会真的显示出来的东西。
 */
const DEFAULT_LABELS: MathLabels = { label: '', aria: '', esc: '', empty: '' }

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
 * 造一套编辑区零件：
 * `[bar: 公式 ✓] [source: $$/field(hl+textarea)/$$] [preview]`。
 *
 * 与 Typora 截图对齐的三件事：
 *   1. `$$` 定界符**分列源码上下两行**（不是挤在一行）—— 所以源码区是一个列；
 *   2. 右上角「公式」+ **✓ 按钮**（真 `<button>`：可聚焦、有可访问名；点它 = 收起编辑态）；
 *   3. 源码区在上、渲染区在下（浅灰/白底与分隔线交给 CSS）。
 *
 * **源码区 = 两层**（第三十一轮起）：`field` 里叠一个装饰层 `<div data-md-math-editor-hl>`
 * 与一个输入层 `<textarea data-md-math-editor-src>`。输入层的文字是透明的（`caret-color` 单独
 * 救回插入符），装饰层负责上色 —— 两层的盒模型必须逐像素一致，口径在 overlays.css。
 * textarea 是**唯一**的输入面：光标、选区、输入法全都走浏览器原生实现，装饰层
 * `pointer-events:none` + `aria-hidden`，一个事件都不接。
 *
 * ⚠️ 装饰层用 `div` 而不是 `pre`：源码区在 `.md-preview` 里面，正文样式里的
 * `.md-preview pre { padding: 14px 16px }` 会盖掉共享盒模型（实测两层错位 13px）。
 * 换行规则自己显式写 `white-space: pre`，语义一样。
 *
 * @param delimiters 是否显示上下 `$$` 行 —— **只有块级给**。行内浮层很窄，
 *   多两行会把"紧凑"这件事毁掉（用户明确要求行内不要占一整行）。
 * @param showHint 是否生成「Esc」提示 —— **只有行内给**，而且是**只给读屏器**的
 *   （`aria-describedby` 指向它）：行内浮层要"大气简约"，可见的那点地方留给源码与 ✓。
 */
function buildEditorParts(
  labels: MathLabels,
  opts: { delimiters: boolean; showHint: boolean }
): {
  box: HTMLElement
  ta: HTMLTextAreaElement
  hl: HTMLElement
  field: HTMLElement
  preview: HTMLElement
} {
  const box = document.createElement('div')
  box.className = 'md-math-editor'
  box.setAttribute('data-md-math-editor', '')
  box.setAttribute('contenteditable', 'false')

  const bar = document.createElement('div')
  bar.className = 'md-math-editor__bar'
  /**
   * 顶行只留**可见标签**（「公式」）。
   *
   * ⚠️ 第三十三轮**删掉了原来的 ✓ 确认按钮**（用户口径③「取消后面要按的对号 `√`」）：
   * 收起编辑态现在只有两条出口 —— **失焦立刻收起**（`onBlur`）与 **Esc**，
   * 不再需要一个点按目标。连它的 `mousedown` handler、`MathLabels.check` 字段与三语
   * `editor.mathCheck` 键一并删掉，**不留死代码**。
   * `data-md-math-editor-label` 这个锚点保留（套件与样式都在用）。
   */
  const label = document.createElement('span')
  label.className = 'md-math-editor__label'
  label.setAttribute('data-md-math-editor-label', '')
  label.textContent = labels.label
  bar.append(label)

  const source = document.createElement('div')
  source.className = 'md-math-editor__source'

  // ── 源码区：装饰层（高亮）+ 输入层（透明文字）叠在一起 ──
  const field = document.createElement('div')
  field.className = 'md-math-editor__field'
  field.setAttribute('data-md-math-editor-field', '')
  const hl = document.createElement('div')
  hl.className = 'md-math-editor__hl'
  hl.setAttribute('data-md-math-editor-hl', '')
  // 装饰层不参与交互、也不进无障碍树（它的文本与输入层逐字相同，读屏读两遍是噪音）
  hl.setAttribute('aria-hidden', 'true')

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
  if (opts.showHint) {
    // 「Esc 收起」只给读屏器（见函数头）：可见的提示会占掉行内浮层本就紧张的地方
    hintSeq += 1
    const hint = document.createElement('span')
    hint.className = 'md-math-editor__hint'
    hint.setAttribute('data-md-math-editor-hint', '')
    hint.id = `md-math-hint-${hintSeq}`
    hint.textContent = labels.esc
    ta.setAttribute('aria-describedby', hint.id)
    field.append(hint)
  }
  field.append(hl, ta)

  if (opts.delimiters) {
    const open = document.createElement('div')
    open.className = 'md-math-editor__delim'
    open.setAttribute('data-md-math-editor-delim', 'open')
    open.textContent = '$$'
    const close = document.createElement('div')
    close.className = 'md-math-editor__delim'
    close.setAttribute('data-md-math-editor-delim', 'close')
    close.textContent = '$$'
    source.append(open, field, close)
  } else {
    source.append(field)
  }

  const preview = document.createElement('div')
  preview.className = 'md-math-editor__preview'
  preview.setAttribute('data-md-math-editor-preview', '')
  preview.setAttribute('contenteditable', 'false')

  // ⚠️ 顺序：`bar` **放在最后**。块级形态里它要绝对定位贴在容器右上角，而它前面那条
  // `.md-math-editor__source`（里面还有 `position: relative` 的 textarea）会**盖住**它 ——
  // 两者都是定位元素且 z-index 都是 auto，谁在后谁在上。放到最后就不必写 `z-index`
  //（分片 CSS 里不许出现数字 z-index，见 tests/zIndexStack.test.mjs）。
  // 行内形态靠 flex 的 `order` 排布（见 overlays.css），与 DOM 顺序无关。
  box.append(source, preview, bar)
  return { box, ta, hl, field, preview }
}

/** 行内浮层里那个"只给读屏器"的 Esc 提示的 id 序号（`aria-describedby` 要唯一 id） */
let hintSeq = 0

/**
 * 把 KaTeX 产物画进渲染区，并同步错误态。
 *
 * 空源码（`tex` 只有空白）走**占位**：框架保留、画 `< Empty Math Block >`
 * （`emptyMathDom`，只存在于视图，序列化里一个字都不加）。
 */
function renderEditorPreview(
  box: HTMLElement,
  preview: HTMLElement,
  tex: string,
  display: boolean,
  emptyLabel: string
): void {
  if (!tex.trim()) {
    preview.replaceChildren(emptyMathDom(emptyLabel))
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
  /**
   * 稳定的 `Decoration.widget` 的 `toDOM`（**每个实例一份、永不重建**）。
   *
   * 为什么要固定引用：`WidgetType.eq` 在 spec.key 不同的时候会要求 `toDOM` **引用相等**
   * 才肯复用那段 DOM；每次重绘现造闭包等于告诉 PM"这是新 widget"，于是 textarea 被
   * 拆掉重插（焦点/选区随之丢失）。挂成实例字段后"同一个会话 ⇒ 同一个 toDOM"成为事实。
   */
  readonly toDOM: () => HTMLElement
  /**
   * 这个会话**唯一一份** widget 规格（`key` 里带会话 id）。
   *
   * `WidgetType.eq` 的第一条判据就是 `spec.key` 相等 ⇒ 同一个会话里无论装饰重算多少次，
   * PM 都判定"还是那个 widget"，**不重建 DOM** —— textarea 因此不丢焦点、不丢插入符。
   * `key` 带会话 id 是必要的：换会话（哪怕落在同一个位置）必须换 key，
   * 否则 PM 会复用一个已经 `destroy()` 掉的旧容器 DOM（新编辑框永远不出现）。
   */
  readonly widgetSpec: MathWidgetShape & { key: string }
  protected readonly view: EditorView
  protected readonly labels: MathLabels
  protected readonly ta: HTMLTextAreaElement
  /** 高亮装饰层（`<pre>`，与 textarea 逐像素对齐；见 mathHighlight.ts 的模块头） */
  protected readonly hl: HTMLElement
  protected readonly preview: HTMLElement
  /** 正在由本对象回写文档：避免 `input → dispatch → pull` 的自激 */
  private writing = false
  /** 输入法组合中：组合期间不回写（会把中文输入打断成一个个字母） */
  private composing = false
  /** 已销毁：挂起的 rAF 回调（失焦判定）不能再碰这个对象 */
  private destroyed = false

  constructor(
    view: EditorView,
    id: number,
    labels: MathLabels,
    delimiters: boolean,
    showHint: boolean,
    shape: MathWidgetShape
  ) {
    this.view = view
    this.id = id
    this.labels = labels
    const parts = buildEditorParts(labels, { delimiters, showHint })
    this.dom = parts.box
    this.ta = parts.ta
    this.hl = parts.hl
    this.preview = parts.preview
    this.toDOM = () => this.dom
    this.widgetSpec = { ...shape, key: `md-math-box:${id}` }

    this.ta.addEventListener('input', this.onInput)
    this.ta.addEventListener('keydown', this.onKeyDown)
    this.ta.addEventListener('scroll', this.onScroll)
    this.ta.addEventListener('blur', this.onBlur)
    this.ta.addEventListener('compositionstart', this.onCompositionStart)
    this.ta.addEventListener('compositionend', this.onCompositionEnd)
    // ✓ 按钮：`mousedown` 阻止默认，逐字写回**不受影响**（内容早已进文档）；
    // 用 `mousedown` 而不是 `click` 是因为 textarea 的 blur 已经会收起编辑态 ——
    // 让收起只发生一次，语义更清楚（内容无论如何都已经写回去了）
    // ── 源码区**任何**位置都不许把编辑态点没（第三十一轮，用户口径）──
    //
    // 旧实现只靠"失焦即收起"，而源码区里除了 textarea 还有 `$$` 行、内边距空白、
    // 顶行 —— 点它们会让 textarea 失焦 ⇒ 编辑态当场消失。这里改成：
    // 点在**非文本框**的容器区域时 `preventDefault()`（浏览器的焦点转移被取消，
    // textarea **根本没失焦**），顺手把焦点与插入符留在源码框里。
    // 点在 textarea 自己身上则不拦（拖动选择文本、点哪儿把光标放哪儿都是原生行为）。
    this.dom.addEventListener('mousedown', this.onBoxMouseDown)
    // 编辑区里的鼠标动作**不要**冒泡到编辑区根节点（PM 会据此改选区/触发点击语义）
    this.dom.addEventListener('mousedown', (e) => e.stopPropagation())
    this.dom.addEventListener('click', (e) => e.stopPropagation())
  }

  /** 子类：DOM 摆放 / 尺寸（块级什么都不用做，行内要算坐标） */
  abstract place(): void

  /** 子类：更新渲染区（块级一直画；行内只在出错时画） */
  protected abstract paintPreview(tex: string): void

  /**
   * **文档里的原文 ⇒ 编辑框里显示的文字**（第三十三轮，用户口径①「显示公式的标识符 `$`」）。
   *
   * 两者不一定相等：行内公式在文档里是 `$E=mc^2$`，而编辑框里要**把两个 `$` 也显示出来
   * 并且允许编辑** ⇒ 行内把整段原文（含定界符）显示出来；块级的定界符由装饰层那两行
   * `$$` 画，textarea 里仍是纯内容。
   * `pull()` / `commit()` 走这一对转换，不会出现"显示的与提交的不是一份"。
   */
  protected toEditorText(baseTex: string): string {
    return baseTex
  }

  /**
   * **编辑框里的文字 ⇒ 文档里要写的公式内容**。
   *
   * @returns `degradable: true` 表示"用户把定界符改坏了"（行内 `$…$` 不再配平）⇒
   *   由 `applySource` 走**退化**：把用户**原样输入**的文本留在正文里、只摘掉公式 mark
   *   （**绝不静默丢弃输入**）。
   */
  protected toDocumentTex(editorText: string): { tex: string; degradable: boolean } {
    return { tex: editorText, degradable: false }
  }

  /**
   * 与文档对齐（源码值 + 高亮 + 渲染区 + 错误态）—— 子类提供"当前文档里的原文"。
   *
   * 三种人会走到"值确实变了"这一支：**撤销/重做**（PM 的历史改回文档）、输入法组合结束、
   * 以及外部程序化改文档。此时要**尽量保住插入符**：直接赋值会把光标甩到末尾，
   * 连按 Ctrl+Z 时观感就是"光标乱跳"。
   */
  pull(tex: string): void {
    const shown = this.toEditorText(tex)
    if (!this.writing && this.ta.value !== shown) {
      const start = this.ta.selectionStart
      const end = this.ta.selectionEnd
      this.ta.value = shown
      const n = shown.length
      this.ta.setSelectionRange(Math.min(start, n), Math.min(end, n))
    }
    this.paintHighlight()
    this.paintPreview(tex)
    this.autosize()
  }

  focus(): void {
    this.ta.focus({ preventScroll: true })
    const at = this.caretOnFocus(this.ta.value)
    this.ta.setSelectionRange(at, at)
  }

  /**
   * 聚焦时插入符落在哪（默认：末尾）。
   *
   * ⚠️ 行内必须覆盖它（第三十三轮修的那条坑）：行内框里显示的是 `$…$`，
   * 插入符落在**末尾**就等于"落在收尾 `$` 之后" —— 用户点开公式接着打字，第一下就把
   * 定界符弄成不配平（`$E=mc^2$` + `z` = `$E=mc^2$z`），于是走**退化**、公式当场变成普通文本、
   * 编辑框跟着收起（实测：打开行内公式敲任何一个字符，框就消失、字符留在公式外面）。
   * 行内把插入符放到**收尾 `$` 之前**，正合"点开就是为了接着写内容"的意图。
   */
  protected caretOnFocus(value: string): number {
    return value.length
  }

  /** 摘掉监听（DOM 归调用方处理） */
  detach(): void {
    this.ta.removeEventListener('input', this.onInput)
    this.ta.removeEventListener('keydown', this.onKeyDown)
    this.ta.removeEventListener('scroll', this.onScroll)
    this.ta.removeEventListener('blur', this.onBlur)
    this.ta.removeEventListener('compositionstart', this.onCompositionStart)
    this.ta.removeEventListener('compositionend', this.onCompositionEnd)
    this.dom.removeEventListener('mousedown', this.onBoxMouseDown)
  }

  /** 销毁：摘监听 + 清自己的 DOM */
  destroy(): void {
    this.destroyed = true
    this.detach()
    this.dom.remove()
  }

  /** textarea 自动高（长公式要能看全；`rows=1` 只是下限） */
  protected autosize(): void {
    this.ta.style.height = 'auto'
    this.ta.style.height = Math.min(this.ta.scrollHeight, 12 * 24) + 'px'
    this.syncMirrorScroll()
  }

  /**
   * 把当前源码画进装饰层（**只改装饰层**：textarea 的 value 与文档一个字符都不动）。
   * 输入法组字期间也照画 —— 组字期间装饰层是隐藏的（见 onCompositionStart），
   * 但提前画好，`compositionend` 一撤掉属性就能立刻看到高亮，不会先闪一下无色文本。
   */
  protected paintHighlight(): void {
    fillHighlight(this.hl, this.ta.value)
    this.syncMirrorScroll()
  }

  /**
   * 横向/纵向滚动同步：装饰层要跟着输入层滚，否则长公式一横向滚动两层就错位
   * （装饰层自己 `overflow: hidden`，但**隐藏的滚动容器照样能被 JS 设 scrollLeft**）。
   */
  private syncMirrorScroll(): void {
    this.hl.scrollTop = this.ta.scrollTop
    this.hl.scrollLeft = this.ta.scrollLeft
  }

  private onScroll = (): void => {
    this.syncMirrorScroll()
  }

  /** 编辑区 → 文档（逐键）。文档一变 ⇒ 视图跟着重算 ⇒ 公式原地重画 */
  protected commit(): void {
    const { tex, degradable } = this.toDocumentTex(this.ta.value)
    this.writing = true
    try {
      /**
       * `caret` = 源码框里的插入符下标（**只在 `degradable` 那一支用得上**）。
       *
       * 退化（用户把 `$…$` 改得不配平）时要把用户**原样输入**的文本留在正文里；
       * 而那一段在文档里是"一段原来的公式原文"，光标此刻通常还停在开会话之前的位置
       * （`handleClick` 认领了那次点击 ⇒ PM 没按落点写过选区）。不显式落光标的话，
       * 用户删掉收尾 `$` 之后光标会跳回**公式最前面**（= 前一个 `$` 之前）——
       * 正是报障②的现场。这里把源码框里的插入符位置一起传下去，
       * 由 `applySource` 映射成文档位置（`degradable` 时 `tex` 与框内文本逐字相同，下标可直接平移）。
       */
      applySource(this.view, tex, this.id, degradable, this.ta.selectionStart)
    } finally {
      this.writing = false
    }
    const live = locateSessionHit(this.view, this.id)
    if (live) this.pull(live.tex)
    this.place()
  }

  private onInput = (): void => {
    // 装饰层**永远**跟着 value 走（连组字期间也画）：少画一次就会看到"两层文本不一致"
    this.paintHighlight()
    if (this.writing || this.composing) return
    this.commit()
  }

  private onCompositionStart = (): void => {
    this.composing = true
    // 组字期间**让位给浏览器原生渲染**：输入法候选串由浏览器画在 textarea 上，
    // 而它的 value 在部分输入法/平台上**不含**组字串 —— 那时镜像层会少一段，
    // 文字就"看不见了"。所以组字期间把输入层改回正常颜色、把装饰层藏起来，
    // 组字结束立刻切回高亮（`data-md-math-composing` 由 CSS 消费）。
    this.dom.setAttribute('data-md-math-composing', '')
  }

  private onCompositionEnd = (): void => {
    this.composing = false
    this.dom.removeAttribute('data-md-math-composing')
    this.paintHighlight()
    this.commit()
  }

  /**
   * Esc = 收起（**不改内容**）；Tab = 缩进（`\begin{align}` 要能排版）；
   * Ctrl/Cmd+Z、Ctrl/Cmd+Y（含 Ctrl+Shift+Z）= 编辑器的全局撤销/重做。
   *
   * 为什么撤销要在这里显式派给 PM 的 history：源码区的事件被 `stopEvent` 挡在 PM 之外
   * （不挡的话按键会被 keypress 的 `insertText` 拿去改文档，见文件头 ①），PM 的历史 keymap
   * 因此收不到 `Mod-z`。口径与 `CodeBlockView.onCmHistoryKey` 完全一致：
   * **按键由源码区吃掉，动作交给 PM 的全局历史**，撤完由 `pull()` 把源码框同步回来。
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    // 输入法组字中的按键（Esc 取消组字、方向键选候选…）一律交还给输入法
    if (e.isComposing) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (k === 'z' || k === 'y') {
        e.preventDefault()
        e.stopPropagation()
        // Ctrl+Y / Ctrl+Shift+Z = 重做（Windows 与 macOS 两种口径都收）
        this.runHistory(k === 'y' || e.shiftKey)
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // 第十四轮：Esc 之后要能在**公式下方**接着敲字（改前选区是公式块的 NodeSelection，
      // 接着敲一个字会把整块替换掉 —— 实测的数据丢失）
      closeSessionAndContinue(this.view)
      return
    }
    /**
     * **空公式块的出路**（第十轮用户口径）：源码框为空时按退格/Delete = 删掉整条公式。
     *
     * 为什么非要在这一层接：源码框是一个空 `<textarea>`，浏览器对它按退格什么都不做；
     * 而它的事件又被 widget 的 `stopEvent` 挡在 ProseMirror 之外（那正是让打字能进去的
     * 原因）—— 于是"空块 + 退格"在两端都没有处理者，表现就是**静默无响应**（实测）。
     *
     * ⚠️ 判据是**按下的那一刻 `ta.value` 为空**，不是"按完之后为空"：
     * `Ctrl+A` 再按退格时 value 里全是选中的源码（非空），那是普通的"删掉选中字符"，
     * **块要留着**（第九轮刚验收的"保留框架"；套件里有对照项）。
     * 输入法组字中的按键在函数开头已经放行（`e.isComposing`）—— 那不是删除意图。
     */
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.ta.value === '') {
      e.preventDefault()
      e.stopPropagation()
      deleteMathNode(this.view, this.id)
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

  /**
   * 一步撤销/重做（PM 的全局历史）。**动作完成后源码框由 `pull()` 同步**；
   * 历史空（`undo` 返回 false）时什么都不做 —— textarea 的焦点与内容都不动。
   */
  private runHistory(wantRedo: boolean): void {
    if (this.destroyed) return
    const command = wantRedo ? redo : undo
    command(this.view.state, this.view.dispatch)
  }

  /**
   * 点在容器（不是文本框）上的 mousedown：取消默认的焦点转移。
   *
   * 这是"点源码区任何位置都不收起"的**主**修法：焦点压根没离开 textarea，
   * 也就不存在 blur，收起逻辑连判定机会都没有。
   */
  private onBoxMouseDown = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null
    if (!target || typeof target.closest !== 'function') return
    // 文本框（含它内部的滚动条区域）：走原生行为（拖动选文本、点哪放哪）
    if (target.closest('[data-md-math-editor-src]')) return
    e.preventDefault()
    this.ta.focus({ preventScroll: true })
  }

  /**
   * **失焦立刻收起**（第三十三轮，用户口径④：「当焦点不聚焦在此编辑框中，此编辑框应该立马消失」）。
   *
   * 改前这里 `requestAnimationFrame` **延后一帧**再判定（当时是为了兜住"点 `$$` 行 /
   * 点源码区空白也会先触发一次 blur"）—— 用户实测的观感就是"点了别处编辑框还赖着不走"。
   * 现在**同步**收起，靠两条保证不误伤：
   *   1. 源码区里**非文本框**的 mousedown 已经被 `onBoxMouseDown` 拦掉（焦点压根没离开
   *      textarea，不会有 blur）——这是主路径，不再需要"下一帧再判"这道兜底；
   *   2. 收起之后光标交回正文（`closeSessionAndContinue`）——否则 `activeElement` 停在 body
   *      上，用户接着敲字一个字都进不去（用户报过的"公式下方无法再输入文字"）。
   *
   * 内容**保留**：每个字符早就实时写进文档了（`pull`/`commit`），收起动作本身不改内容。
   */
  private onBlur = (): void => {
    /**
     * 判定放在**一个微任务**之后（不是下一帧、更不是定时器）。
     *
     * 为什么需要这一点点延迟：逐键写回会让 PM 重算装饰，编辑容器的 DOM 可能被搬动/重插
     * 一次，旧 textarea 就在那一刻失焦（实测栈：`rm$2` → `HTMLTextAreaElement.onBlur`），
     * 而补焦点发生在同一次视图更新里稍后一点点。**同步**判定会看到 `activeElement === body`
     * 而误判成"用户点了外面"（实测：敲一个字符编辑框就消失）。
     *
     * 一个微任务足够让那次补焦点生效，**且仍在同一个任务内**：套件实测
     * `blur → 容器从 DOM 消失` 是**个位数毫秒**，远低于口径给的 ≤1 帧（≈16ms），
     * 用户观感就是"立马消失"。刻意**不用** `setTimeout` / `requestAnimationFrame`：
     * 那才是真的"延迟收起"——老实现正是 rAF，实测观感就是"点了别处它还赖着不走"。
     */
    queueMicrotask(() => {
      if (this.destroyed) return
      // 会话已经换人/已经收起：不要拿旧容器的失焦去关新会话
      if (mathPreviewKey.getState(this.view.state)?.box !== this) return
      // 焦点还在本容器里（例如从 textarea 移到容器内的其它可聚焦元素）：不算"离开编辑框"
      const active = document.activeElement
      if (active && this.dom.contains(active)) return
      closeSessionAndContinue(this.view)
    })
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
    // 块级：给 `$$` 分列上下；`Esc` 提示不给（`aria-describedby` 那份留给行内，
    // 块级的 bar 已经够挤，且 ✓ 是可见出口）；事件对 PM 屏蔽（见 blockBoxShape）
    super(view, id, labels, true, false, blockBoxShape)
    this.dom.classList.add('md-math-editor--block')
    this.dom.setAttribute('data-md-math-editor-shape', 'block')
    // 位置锚：套件用它断言"编辑的确实是那一条公式"，不靠坐标猜
    this.dom.setAttribute('data-md-math-editor-pos', String(pos))
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
    renderEditorPreview(this.dom, this.preview, tex, true, this.labels.empty)
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
    super(view, session.id, labels, false, true, inlineBoxShape)
    this.hit = session.active
    this.dom.classList.add('md-math-editor--inline')
    this.dom.setAttribute('data-md-math-editor-shape', 'inline')
  }

  /**
   * 行内：**把 `$…$` 整段显示出来**（用户口径①：「显示公式的标识符 `$`，可以对标识符进行编辑」）。
   *
   * `baseTex` 是公式**内容**（`E=mc^2`，不含定界符），这里补上两侧 `$`；
   * 已经是完整形态时原样返回（**幂等**：`pull()` 每次按键都会走一遍，不幂等就会越加越多）。
   */
  protected toEditorText(baseTex: string): string {
    if (baseTex.length >= 2 && baseTex.startsWith('$') && baseTex.endsWith('$')) return baseTex
    return `$${baseTex}$`
  }

  /**
   * 行内：编辑框里的文字 ⇒ 文档里的公式内容。
   *
   * * **两侧 `$` 都在**：去掉它们当内容（`$E=mc^2$` → `E=mc^2`）；
   * * **只有一侧（或一个都没有）**：`degradable: true` ⇒ 交给 `applySource` 走**退化**
   *   （原样留在正文、摘掉公式 mark）。这与 `mathMarkers.ts` 的既有归一化同口径：
   *   行内公式必须一对配平的 `$…$`，不配平就退回普通文本。
   */
  protected toDocumentTex(editorText: string): { tex: string; degradable: boolean } {
    const balanced =
      editorText.length >= 2 && editorText.startsWith('$') && editorText.endsWith('$')
    return { tex: balanced ? editorText.slice(1, -1) : editorText, degradable: !balanced }
  }

  /**
   * 行内：聚焦时插入符落在**收尾 `$` 之前**（见基类 `caretOnFocus` 的说明）。
   * 不配平（用户已经把定界符改坏）时才退回末尾，让用户自己看着改。
   */
  protected caretOnFocus(value: string): number {
    const balanced = value.length >= 2 && value.startsWith('$') && value.endsWith('$')
    return balanced ? value.length - 1 : value.length
  }

  /**
   * 行内的渲染区**只在出错时**显示：语法正确时框外那条公式就是它的渲染结果，
   * 再画一份只是噪音（错误信息则是唯一能说清"错在哪"的东西）。
   *
   * ⚠️ 行内**空**公式这里**不画占位**（用户口径：行内空公式的处置单独说明）：
   * 行内公式的"清理"语义是**删掉整条**（见 `applySource`）—— 一个零宽的行内公式在句子中间
   * 没有"框架"可留，画 `< Empty Math Block >` 反而会把句子撑开、还与"删掉"语义打架。
   * 块级的空公式才保留框架并画占位（Typora 的形态）。
   */
  protected paintPreview(tex: string): void {
    const { html, error } = mathRenderInfo(tex, false)
    const preview = this.preview
    if (!tex.trim()) {
      preview.replaceChildren()
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
 *
 * 源码为空（`''`）的语义**按形态分**（第九轮用户口径「空的式子保留框架」）：
 *   * **块级**：**不删节点**，只把 `source` 置空 ⇒ 容器/框架还在、可以继续输入，
 *     渲染区显示 `< Empty Math Block >`；序列化照旧是 `$$\n\n$$`（占位**不进文档**）。
 *     与 Typora 一致：空公式块是一个"待填"的块，不是"删掉"。
 *   * **行内**：仍然**删掉整条**（连两侧 `$` 定界符一起）—— 行内公式没有可留的"框架"，
 *     一个零宽公式留在句子中间既看不见也点不着；用户口径里也写明这条单独判断。
 *
 * @param id 发起写入的编辑区 id：会话已经被别人接管时**直接忽略**（防止过期写入）
 * @param degradable 用户把定界符改坏了（行内 `$…$` 不再配平）⇒ 走**退化**：
 *   把用户**原样输入的文本**留在正文里、只摘掉公式 mark，**绝不静默丢弃**任何一个字符。
 *   与 `mathMarkers.ts` 的既有归一化同一口径（行内公式必须一对配平的 `$…$`，不配平退回普通文本）。
 * @param caret 源码框里的插入符下标（`degradable` 时才有意义，见 `MathEditorBase.commit`）。
 *   退化之后把文档光标落在 `live.from + caret`（夹在退化区间的两端之内）并聚焦编辑器 ——
 *   这是报障②「删掉收尾 `$` 之后光标该落在内容末尾」的唯一落点来源。
 * @returns 是否真的改动了文档
 */
export function applySource(
  view: EditorView,
  tex: string,
  id?: number,
  degradable = false,
  caret?: number
): boolean {
  const session = mathPreviewKey.getState(view.state)?.active
  if (!session) return false
  if (id !== undefined && session.id !== id) return false
  const live = locateLive(view, session)
  if (!live) return false
  const kind = session.kind
  const { state } = view
  if (tex === '' && kind === 'inline') {
    // 行内：清空 = **删掉整条公式**（连两侧 `$` 定界符一起，见 deleteMathNode 的口径）
    return deleteMathNode(view, id)
  }
  if (kind === 'inline') {
    if (degradable) {
      /**
       * **改坏即退化**（用户口径①）：文本原样留着，只把 `mdMath` mark 摘掉。
       *
       * 为什么是"摘 mark"而不是"删掉"或"补回 `$`"：
       *   * 删掉 ⇒ 用户删了一个 `$` 却整条公式没了，等于**静默丢弃输入**（用户明确禁止）；
       *   * 补回 `$` ⇒ 用户按不动删除键，输入被吞（同样是丢弃）。
       * 摘 mark 之后这段就是普通文本，与 markdown 里"`$\frac{1}{2}`（不配平）"的解析结果一致，
       * 所以**保存后再打开**与屏幕上看到的是同一个东西（往返一致）。
       * 用**整段区间**（`live.from..live.to`，含两侧 `$`）替换：一个事务完成，`Ctrl+Z` 可回退。
       */
      const tr = state.tr.replaceWith(live.from, live.to, state.schema.text(tex))
      /**
       * **退化之后光标落在哪**（报障②）。
       *
       * 不显式落光标的话，文档光标停在开会话之前的位置（`handleClick` 认领了那次点击，
       * PM 没按落点写过选区）—— 实测：`$E = mc^2$` 里删掉收尾 `$` 之后
       * `selection.from = 1`（公式**最前面**），而用户期望的是 `10`（`2` 的后面）。
       *
       * 口径：源码框里的插入符下标**原样平移**到文档（`degradable` 时 `tex` 就是框内文本，
       * `toDocumentTex` 没有做任何裁剪），夹在退化区间 `[live.from, live.from + tex.length]` 之内。
       * 两条出口都保住：
       *   * 末尾退格删 `$` ⇒ 框内插入符在末尾 ⇒ 文档光标紧跟内容末尾（正是报障②要的"落在 `2` 后面"）；
       *   * 中间改坏某个 `$` ⇒ 光标跟着停在用户改的那个字符处（不跳位）。
       * 源码框没给下标（程序化调用）时保持 PM 的映射结果，不抢。
       */
      if (typeof caret === 'number' && Number.isFinite(caret)) {
        const at = Math.max(
          live.from,
          Math.min(live.from + Math.trunc(caret), live.from + tex.length)
        )
        const $at = tr.doc.resolve(at)
        const near = TextSelection.near($at, 1) ?? TextSelection.near($at, -1)
        if (near) tr.setSelection(near)
      }
      view.dispatch(tr)
      /**
       * 焦点交回编辑器：退化会让这条公式的 mark 消失 ⇒ 会话在同一个事务里被摘掉
       * （`MathPreviewView.sync` → `drop`），编辑容器（含 textarea）随之下线，焦点此刻落在
       * `body` 上 —— 不补这一下，用户接着敲字一个字都进不去（实测 `activeElement = BODY`）。
       */
      if (typeof caret === 'number' && Number.isFinite(caret)) view.focus()
      return true
    }
    if (tex === currentTex(state, live, kind)) return false
    // 行内：替换**内容区间**（两侧 `$` 定界符与 `mdMath` mark 都留着）
    const text = state.schema.text(tex, liveMarks(state, live))
    view.dispatch(state.tr.replaceWith(live.innerFrom, live.innerTo, text))
    return true
  }
  if (tex === currentTex(state, live, kind)) return false
  // 块级：原文在**节点属性** `source` 里（节点本身没有文本内容，`textBetween` 恒为空串）。
  // ⚠️ 这里千万不能 `replaceWith(...)` —— 那会把整个 `mathBlock`（原子节点）换成一段文字，
  // 于是公式退化成一个普通段落（实测过：`$$…$$` 被吃掉、`\frac{1}{` 变成正文）。
  // 正确做法是给节点打一个新属性，NodeView 的 `update` 会据此重画。
  const node = state.doc.nodeAt(live.from)
  if (!node || node.type.name !== 'mathBlock') return false
  view.dispatch(state.tr.setNodeMarkup(live.from, undefined, { ...node.attrs, source: tex }))
  return true
}

/**
 * **删掉整条公式** —— 这是"空公式块"唯一的出路（第十轮用户口径）。
 *
 * 用户报障：空公式块（上一轮起"保留框架"，渲染区显示 `< Empty Math Block >`）里按退格
 * 「现在没任何的行为」。真实原因不是"删除被谁拦了"，而是**根本没人接这个按键**：
 * 源码框是一个空 `<textarea>`，浏览器对它按退格什么都不做；而它的事件又被 widget 的
 * `stopEvent` 挡在 ProseMirror 之外（那正是让打字能进去的原因）——
 * 于是"空块 + 退格"在两端都没有处理者，表现为静默无响应。
 *
 * 语义（写死在这里，套件按它断言）：
 *   * **一个事务** ⇒ `Ctrl+Z` 一次就回来；
 *   * 块级删掉整个 `mathBlock`；行内**连两侧 `$` 定界符一起删**（与文件头
 *     "源码清空 = 删除这条公式"同一口径；改前只删内容区间、会把 `$$` 留在正文里）；
 *   * 文档因此**一个块都不剩**时补一个空段落 —— PM 的 `doc` 必须至少有一个 block，
 *     直接删空会让事务非法（`ReplaceStep` 抛 "Invalid content for node doc"）；
 *   * 删完光标落在原来的位置上（夹在文档范围内）并**把焦点交回编辑器**，用户可以接着打字；
 *   * 会话在同一个事务里收起（`MathPreviewView` 会把编辑容器摘掉）。
 *
 * @param id 发起删除的编辑区 id：会话已被别人接管时忽略（防止过期操作）
 * @returns 是否真的删了
 */
export function deleteMathNode(view: EditorView, id?: number): boolean {
  const session = mathPreviewKey.getState(view.state)?.active
  if (!session) return false
  if (id !== undefined && session.id !== id) return false
  const live = locateLive(view, session)
  if (!live) return false
  const { state } = view
  const tr = state.tr
  const onlyBlock = session.kind === 'block' && state.doc.childCount === 1 && live.from === 0
  if (onlyBlock) {
    // 只剩这一块：换成空段落（否则 doc 会是空的，事务非法）
    tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create())
  } else {
    tr.delete(live.from, live.to)
  }
  tr.setMeta(mathPreviewKey, { session: { kind: 'close' } } satisfies MathSessionMeta)
  /**
   * 光标放到"原位置最近的**可写**处"。
   *
   * ⚠️ 不能直接 `TextSelection.create(doc, live.from)`：删掉一整块之后，那个位置常常正好落在
   * **块之间的边界**上（`depth === 0`，父节点是 `doc`），而 `TextSelection` 的端点必须落在
   * 有行内内容的节点里 —— PM 会警告 "TextSelection endpoint not pointing into a node with
   * inline content (doc)"，并且这种非法选区会让随后的 `selectionToDOM` 把渲染进程搞崩
   *（实测：套件跑到这里整个实例都没了）。`TextSelection.near` 会就近找到真正可写的位置
   *（优先往后，即被删公式**后面**那一段的行首），空文档时返回 null 就保持事务映射的选区。
   */
  const $caret = tr.doc.resolve(Math.max(0, Math.min(live.from, tr.doc.content.size)))
  const near = TextSelection.near($caret, 1) ?? TextSelection.near($caret, -1)
  if (near) tr.setSelection(near)
  view.dispatch(tr)
  // 焦点交回编辑器：编辑容器在同一事务里被摘掉，焦点此刻落在 body 上
  view.focus()
  return true
}

// ─── 插件 ────────────────────────────────────────────────────────────────────

/**
 * 空段落里敲下 `$$` 再按回车 → **插入一个空公式块并直接进入编辑态**（第九轮用户口径）。
 *
 * 判据（为什么这样定）：
 *   * 只认**段落**（`paragraph`）：标题/列表项/引用里 `$$`+⏎ 是它们自己的语义（换行、新项），
 *     不该被公式抢走；代码块更不会走到这里 —— 它根本不是段落，而且代码块内部的按键被
 *     `codeBlock.ts` 的 `stopEvent` 挡在 PM 之外（双保险）；
 *   * 认的是**整段文本恰好等于 `$$`**（`parent.textContent === '$$'`）：`abc $$` 这种
 *     "行中间/行尾还有别的内容"的情况因此**不会**误触发；
 *   * 选区必须是**折叠**的（`empty`），有选区时回车交给 PM 的默认语义（删选区/换行）。
 *
 * 插入走的就是 `mathBlock` 这个节点本身（它的 markdown 序列化固定写 `$$\n…\n$$`），
 * 一个事务完成 ⇒ **一步撤销**；随后用既有的 `openMathEditor` 开会话
 * （`MathPreviewView` 会在下一帧把焦点放进源码框，用户不用再点一次）。
 *
 * @returns 是否已经处理（true = 吃掉这个回车）
 */
function insertEmptyMathBlock(view: EditorView): boolean {
  const { state } = view
  const { $from, empty } = state.selection
  if (!empty) return false
  const parent = $from.parent
  if (parent.type.name !== 'paragraph' || parent.textContent !== '$$') return false
  const nodeType = state.schema.nodes.mathBlock
  if (!nodeType) return false
  const start = $from.before()
  const end = $from.after()
  const node = nodeType.create({ source: '' })
  /**
   * 末尾这一格要**显式补一个空段落**（第十四轮）：公式块是原子块级节点，光标需要一个
   * 能落下的文本块。实测（报告 §2）：装载路径与代码块那条路径上，末尾确实会有尾随段落，
   * 但"`$$`+回车 插在文档最后"这条路径**不该依赖**那个来源不明的补段 —— 这里自己保证：
   * 被替换掉的 `$$` 段落本来就是文档最后一个孩子时，连同空段落一起插。
   *
   * 为什么补空段落不会污染 Markdown：实测（探针 v14b）末尾的空段落**不写出**任何多余空行
   *（`第一段：正文。\n\n$$\n\n$$\n`，Markdown 文件末尾本来就有一个换行）。
   * 一个事务 ⇒ 撤销一步到位，与"只插公式块"在用户看来没有多一步。
   */
  const isLast = $from.depth === 1 && $from.index(0) === state.doc.childCount - 1
  const pType = state.schema.nodes.paragraph
  const insert = isLast && pType ? Fragment.fromArray([node, pType.create()]) : node
  view.dispatch(state.tr.replaceWith(start, end, insert))
  // 插入是**上一个事务**；这里只是"把编辑态开在那条新公式上"（只改视图，不改文档）
  openMathEditor(view, {
    kind: 'block',
    from: start,
    to: start + node.nodeSize,
    innerFrom: start,
    innerTo: start + node.nodeSize,
    tex: ''
  })
  return true
}

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
  // 视图已经销毁（切文件 / 切模式把编辑器拆了）：再 dispatch 会打到空的 docView 上。
  // 失焦判定被**延后了一帧**（见 MathEditorBase.onBlur），这个窗口比以前宽，所以显式挡一道。
  if (view.isDestroyed) return
  if (!mathPreviewKey.getState(view.state)?.active) return
  view.dispatch(
    view.state.tr.setMeta(mathPreviewKey, { session: { kind: 'close' } } satisfies MathSessionMeta)
  )
}

/**
 * "收起并继续在正文里写字"（Esc / ✓ 按钮两条**显式**路径用；失焦那条不用，见下）。
 *
 * 第十四轮实测（报告 §2）——`$$`+回车 在文档末尾开编辑态时，PM 选区是落在刚插入的
 * 公式块上的 **块级 `NodeSelection`**（`insertEmptyMathBlock` 的 replacement 语义）。
 * 收起时如果原样留着这个选区：
 *   * **Esc** 那条会 `view.focus()`，于是**接着敲的任何一个字都被 PM 拿去替换整块** ——
 *     实测公式块直接消失、变成那个字符（数据丢失）；
 *   * **✓ 按钮**那条连焦点都没收回来（`document.activeElement === BODY`）⇒ 敲什么都不进文档，
 *     正是用户报的"公式下方无法再输入文字 / 点不出光标"。
 * 所以显式收起时，如果选区正好是这条公式块的 NodeSelection，就把它挪到**块之后**的正文位置
 * （末尾有尾随空段落时就是它；没有就退到块前，反正必须是文本块），再聚焦编辑器。
 *
 * ⚠️ **失焦那条路不走这里**：那是"用户点了别处"，PM 自己会把光标放到点击处；
 * 这里再 setSelection 会跟那次点击抢（`onBlur` 是下一帧才判的）。
 */
export function closeSessionAndContinue(view: EditorView): void {
  if (view.isDestroyed) return
  const st = mathPreviewKey.getState(view.state)
  const hit = st?.active?.active
  if (!st?.active || !hit) return
  const sel = view.state.selection
  const move =
    hit.kind === 'block' &&
    sel instanceof NodeSelection &&
    sel.from === hit.from &&
    sel.to === hit.to
  closeSession(view)
  if (move) {
    const pos = Math.min(hit.to, view.state.doc.content.size)
    const $pos = view.state.doc.resolve(pos)
    const near = TextSelection.near($pos, 1) ?? TextSelection.near($pos, -1)
    if (near) view.dispatch(view.state.tr.setSelection(near).scrollIntoView())
  }
  view.focus()
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
    /**
     * 自绘插入符的可见性开关（focus / 组字），由 `MathPreviewView` 维护。
     * 放闭包里而不是插件 state：它只影响**这一次重绘要不要挂插入符装饰**，
     * 不需要参与事务、也不该进历史（focus/blur 不是文档变化）。
     */
    const caret: CaretVisibility = { focused: false, composing: false }
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
            /**
             * 自绘插入符（第十二轮）：**只在原生插入符画不出来的那些位置**补一个 1px 的元素。
             *
             * 判据（缺一不可）：
             *   * 编辑器有焦点、不在组字、也没有开着的编辑会话（见 `CaretVisibility`）；
             *   * 选区为空（有选区时走原生高亮，别画插入符）；
             *   * 光标位置落在某段行内公式的 marked 文本区间里（`inlineMathRunAt`）——
             *     那里的原生插入符高度实测为 0。
             *
             * 位置/方向：落在公式**右边界**（`pos === run.to`）时把 widget 排在折叠原文之后
             *（`side: 1`）⇒ 插入符正好画在公式右边缘；其余位置排在之前（`side: -1`），
             * 也就是公式左边缘 —— 折叠原文宽 0，这两种就是"公式外面那一格"。
             */
            const merged = caretDecorations(state, active, box, caret)
            if (!active || !box) return merged ? st.decos.add(state.doc, merged) : st.decos
            const pos = clamp(active.active.from, state.doc)
            if (active.kind === 'block') {
              // 块级：容器**随正文流**顶替公式原来的位置，同时把那个节点收起来
              //（`.md-math-editing` → `display:none`，见 overlays.css）。
              // `side:-2` = 排在这个节点**之前**（widget 默认会排在节点内容之后）。
              // ⚠️ 这里交给 PM 的必须是 `box.toDOM` 与 `box.widgetSpec`（**同一份引用**）：
              // 现造闭包会让 `WidgetType.eq` 判假 ⇒ PM 拆掉容器重插 ⇒ textarea 丢焦点。
              return st.decos.add(state.doc, [
                Decoration.widget(pos, box.toDOM, box.widgetSpec),
                Decoration.node(pos, active.active.to, { class: 'md-math-editing' })
              ])
            }
            // 行内：**保留**这条公式的渲染 widget（公式照常显示在浮层下面），
            // 只是额外追加一个浮层。绝不把常驻装饰去掉 —— 去掉就成"公式消失"了。
            const withBox = st.decos.add(state.doc, [
              Decoration.widget(pos, box.toDOM, box.widgetSpec)
            ])
            return merged ? withBox.add(state.doc, merged) : withBox
          },
          handleClick(view, pos, event) {
            const el = event.target as HTMLElement | null
            // 点编辑区自己（✓/textarea）不算"点公式"
            if (el?.closest?.('[data-md-math-editor]')) return false
            const found = el?.closest?.('[data-md-math-rendered],[data-md-math-block]')
            if (!(found instanceof HTMLElement)) return false
            const hit = locate(view.state.doc, pos, found)
            if (!hit) return false
            /**
             * 行内公式的**左半边**：按"原子行内元素"的浏览器惯例，落点取**公式起点**
             * （= 公式之前）并交出焦点，**不**打开源码编辑态（第三十五轮报障 A）。
             *
             * 为什么必须有这一条：`view.posAtCoords` 对这个 widget 的**任何** x 都返回
             * `hit.from`（实测 x=321…391 全给 `{pos:1,inside:0}`）—— 也就是说"点公式"这件事，
             * PM 自己的答案**本来就是"落在公式之前"**；是我们这个 `handleClick` 无条件把它覆盖成
             * "打开编辑态"，于是行首公式连"正文列左缘/左缘内 1px"这一点都只能开出编辑框、
             * 落不到公式之前。现在把左半边让回 PM 的语义。
             *
             * 取舍（写在这里免得以后当成 bug）：**只有左侧 1/4** 让回 PM 的语义，其余
             * （含正中）**仍然打开编辑态** —— "点公式看源码"是前几轮的用户口径，不能丢；
             * 而"我要在它前面写字"的人，落点基本都在最左边那一小条里。
             * 用 1/4 而不是浏览器对原子行内元素的 1/2 惯例，是为了**不误伤**
             * "点公式（正中）⇒ 开编辑态"那条既有口径：套件一律 `centerOf` 点正中，
             * 而 1/2 判据在 `Math.round(left + width / 2)` 往下取整时会误吞正中那一击。
             * 判据用 widget 自己的盒子（`(clientX - left) * 4 < width`），不是硬编码像素；
             * 宽度为 0（还没上屏）时不接管。
             */
            if (hit.kind === 'inline' && event instanceof MouseEvent) {
              const rect = found.getBoundingClientRect()
              if (rect.width > 0 && (event.clientX - rect.left) * 4 < rect.width) {
                const $at = view.state.doc.resolve(clamp(hit.from, view.state.doc))
                const near = TextSelection.near($at, -1) ?? TextSelection.near($at, 1)
                event.preventDefault()
                if (near && !view.state.selection.eq(near)) {
                  view.dispatch(view.state.tr.setSelection(near))
                }
                view.focus()
                return true
              }
            }
            openMathEditor(view, hit)
            return true // 已处理：别再让 PM 按落点写一次选区
          },
          /**
           * 回车：只认"空段落里恰好是 `$$`"那一种（见 `insertEmptyMathBlock`）。
           *
           * 输入法组字中的回车**必须放行** —— 那是"确认候选词"，不是"回车"（用户口径
           * 里点名的边界）。组字态在 PM 上是 `view.composing`，在事件上是 `isComposing`。
           *
           * 方向键那条见 `crossInlineMathOnArrow`。
           */
          handleKeyDown(view, event) {
            if (crossInlineMathOnArrow(view, event)) return true
            if (event.key !== 'Enter' || event.shiftKey) return false
            if (event.isComposing || view.composing) return false
            if (!insertEmptyMathBlock(view)) return false
            event.preventDefault()
            return true
          }
        },
        view: (view) => new MathPreviewView(view, labels, caret)
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
  /** 自绘插入符的可见性开关（与插件的 `props.decorations` 共享同一个对象） */
  private caret: CaretVisibility
  /** 本实例装上的那份清理函数（destroy 时只在"注册表里还是我"的情况下卸；见 destroy 的说明） */
  private uninstallViewport: (() => void) | null = null

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

  /**
   * **点别处立刻收起**（第三十四轮报障①：「点击公式出现编辑态之后，点其他任何地方，
   * 公式编辑的区域应该就消失」）。
   *
   * 为什么不能只靠源码框的 `blur`：`blur` 成立的前提是**焦点离开了源码框**，而"按下"
   * 并不总会移动焦点 —— 两条路都会漏：
   *   * **合成 / 程序化事件**（`el.dispatchEvent(new MouseEvent('mousedown'))`）根本不参与
   *     浏览器的默认焦点转移，textarea 一直是 `activeElement`；
   *   * 界面上有一批控件在自己的 `mousedown` 里 `preventDefault()`（工具栏那排按钮的
   *     `@mousedown.prevent` 就是"别把编辑器的焦点抢走"写的），焦点同样不动。
   * 两种情况下 `blur` 永远不会来 ⇒ 编辑框**赖着不走**。改前实测（合成 mousedown 打在
   * 正文段落 / 空白区上）：350ms 后 `[data-md-math-editor]` 仍在、`goneMs = null`。
   *
   * 所以在**捕获阶段**监听整个窗口的 `mousedown`：按下点只要不落在编辑容器内部，就立刻
   * 收起。出口与失焦那条完全一致（`closeSessionAndContinue`：先把光标交回正文再聚焦编辑器），
   * 所以"点别处之后接着打字"这条既有口径不变；容器内部的按下（源码框 / `$$` 行 / 内边距）
   * 一律放行 —— 那是第三十一轮"点源码区任何位置都不收起"的口径。
   *
   * 用**捕获**而不是冒泡：要在任何 `preventDefault()` 之前就决定，且不受
   * `e.stopPropagation()`（编辑容器自己就 stop 了 mousedown/click）影响。
   */
  private onDocMouseDown = (event: MouseEvent): void => {
    // 只认主键（右键/中键不改变编辑态；与 `onBoxMouseDown` 的口径一致）
    if (event.button !== 0) return
    if (this.view.isDestroyed) return
    const st = mathPreviewKey.getState(this.view.state)
    if (!st?.active || !st.box) return
    const target = event.target as Element | null
    if (target && typeof target.closest === 'function' && target.closest('[data-md-math-editor]')) {
      return
    }
    closeSessionAndContinue(this.view)
  }

  constructor(view: EditorView, labels: MathLabels, caret: CaretVisibility) {
    this.view = view
    this.labels = labels
    this.caret = caret
    // 初始值：视图刚建起来时的焦点/组字态（插件 state 的 init 拿不到 view，所以在这里补）
    this.caret.focused = view.hasFocus()
    this.caret.composing = view.composing
    this.sync()
    this.installViewport()
  }

  /**
   * **幂等安装**视口/焦点监听（第五十五轮）。
   *
   * 这批监听装在 `window` 与 `view.dom` 上 —— 两者都比本实例活得久，而闭包是每次构造新造的。
   * dev(HMR) 下模块被热替换、视图被复用时会**再挂一份**，`destroy()` 却只卸得掉最后那一份
   * （旧实例的 `destroy` 再也不会被调用）⇒ 滚动一次多份 rAF 回调、`onCaretFlags` 叠着跑。
   * 所以：按 `view` 记清理函数，装之前先把上一次的卸掉（`installOnce`），任何时刻只有一份。
   * `dataset.mdMathViewportHandlers` 是给套件看的可断言载体（1 = 已装、0 = 已卸）。
   */
  private installViewport(): void {
    const view = this.view
    this.uninstallViewport = installOnce(mathViewportUninstall, view, () => {
      window.addEventListener('scroll', this.onViewport, true)
      window.addEventListener('resize', this.onViewport)
      /**
       * 自绘插入符的可见性：焦点 / 组字变化时更新开关并**逼一次重绘**。
       *
       * 为什么是这四个 DOM 事件而不是 PM 的事务钩子：focus/blur/组字都不是文档或选区变化，
       * 不会有事务经过插件 ⇒ 不主动重绘的话，插入符会留在屏幕上（失焦了还闪）或在组字时
       * 与原生插入符叠成两条。
       */
      for (const type of CARET_FLAG_EVENTS) view.dom.addEventListener(type, this.onCaretFlags)
      window.addEventListener('mousedown', this.onDocMouseDown, true)
      view.dom.dataset.mdMathViewportHandlers = '1'
      return () => {
        window.removeEventListener('scroll', this.onViewport, true)
        window.removeEventListener('resize', this.onViewport)
        for (const type of CARET_FLAG_EVENTS) view.dom.removeEventListener(type, this.onCaretFlags)
        window.removeEventListener('mousedown', this.onDocMouseDown, true)
        view.dom.dataset.mdMathViewportHandlers = '0'
      }
    })
    // 测试钩子（只为"幂等性"这条断言服务）：让套件能再装一次并观察监听仍是 1 份。
    ;(view.dom as unknown as Record<string, unknown>).__mdMathViewportInstall = (): void =>
      this.installViewport()
  }

  /**
   * 焦点/组字变化 → 更新开关 + 重绘一次。
   *
   * 用**空事务**逼 PM 重算装饰：`docChanged` / `selectionSet` 都是假 ⇒ prosemirror-history
   * 不会记步（撤销栈不受影响），也不会触发任何内容回调。
   */
  private onCaretFlags = (): void => {
    if (this.view.isDestroyed) return
    const focused = this.view.hasFocus()
    const composing = this.view.composing
    if (focused === this.caret.focused && composing === this.caret.composing) return
    this.caret.focused = focused
    this.caret.composing = composing
    /**
     * ⚠️ **编辑态开着时绝不重绘**。
     *
     * 源码框是 `view.dom` 的后代，点公式开会话时 `view.dom` 会收到一次 `blur`
     *（焦点交给了 textarea）—— 此时如果 dispatch 一个空事务逼 PM 重算装饰，PM 会在
     * "编辑容器刚挂上"的这一刻重排 widget，实测把刚建好的容器 DOM 拆掉重插：
     * 表现就是**源码框一出现就没了 / 元素变 STALE**（L1 段就是这么红的）。
     * 而编辑态下正文里本来就不画插入符（`caretDecorations` 会返回 null），
     * 所以这里直接跳过，装饰集压根不需要变。
     */
    const st = mathPreviewKey.getState(this.view.state)
    if (st?.active || st?.box) return
    this.view.dispatch(this.view.state.tr)
  }

  update(): void {
    this.sync()
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    /**
     * 只有当注册表里**还是我这一份**时才卸。
     * HMR / 插件视图重建的顺序是「新实例先装（顺带卸掉旧的）、旧实例的 destroy 后跑」——
     * 若旧实例无条件调用注册表里的清理函数，卸掉的会是**新实例**刚装上的那份监听，
     * 于是数学浮层不再跟随滚动/焦点（实测：`_verify-math-edit.js` 一连串 math/粘贴用例变红）。
     */
    if (mathViewportUninstall.get(this.view) === this.uninstallViewport) {
      this.uninstallViewport?.()
      mathViewportUninstall.delete(this.view)
    }
    this.uninstallViewport = null
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
    /**
     * 两种形态都是**装饰 widget**（`props.decorations` 里那一条），所以这里都要**主动重绘一次**：
     * 开会话的事务 `docChanged` 为假，PM 不会自己重算装饰 ⇒ 少了这一下新实例的 DOM
     * 要等下一次事务才上屏（点击后"什么都没发生"就是这么来的）。
     *
     * ⚠️ 第九轮删掉了行内那条"手动 `appendChild` 到 `view.dom.parentElement`"：
     * 那等于**同一份 DOM 挂两处** —— 装饰随后会把它搬进段落里（实测 `parentElement` 是 `P`），
     * 搬动过程中被聚焦的 textarea 会被移出/移回文档（丢焦点），而且行内框因此进了 `view.dom`、
     * 按键被 PM 接管（`Ctrl+A` → `AllSelection` → 下一个键被 `insertText` 吃掉，见 blockBoxShape）。
     */
    this.view.dispatch(this.view.state.tr)
    // 上屏之后再算坐标（行内浮层要量高度；块级的 `place()` 是空实现）
    box.place()
    /**
     * 焦点：**先同步给一次**，再在下一帧补一次。
     *
     * 为什么不是只留 rAF（第九轮就是那样）：窗口被别的窗口挡住时 Chromium 会**暂停出帧**
     *（仓库里 `harness.framesAlive()` 就是为这件事写的），rAF 里的 `focus()` 于是永远不跑 ——
     * 表现是"点开公式后按键没进源码框"（实测：套件在后台窗口跑时 `activeElement` 仍是 body，
     * `Ctrl+A` 被 PM 的 `selectAll` 接走、整篇文档被下一个退格清掉）。
     *
     * 放在这里同步聚焦是安全的：装饰 widget 的 DOM 在 `dispatch` 里就已经建好并插进文档，
     * `focus()` 不依赖布局。rAF 那一次保留 —— 视图重建/被搬动之后（`place()` 改过位置）再兜一次。
     */
    box.focus()
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
      this.view.dispatch(this.view.state.tr)
    }
    this.sessionId = 0
    this.sessionKind = null
  }
}

export type { MathHit }
