// ─── 公式粘贴（第十三轮）：把富文本剪贴板里的数学**取回原文** ──────────────────────
//
// 用户报障：在主流编辑器里**连公式带正文一起复制**粘进来，公式不是公式 ——
// 实时渲染区是一段字面文本，而"源码区"里是
//   `$$`
//   `\`                      ← 行尾多一个反斜杠
//   `x = \\frac{-b \\pm …}`  ← 反斜杠被加倍
//   `\`
//   `$$`
//
// 实测真因（第十三轮探针原始数据，见报告 §1）：
//   * 剪贴板里**同时有** `text/html` 与 `text/plain` 时，ProseMirror 走的是 HTML 那条
//     （`parseFromClipboard` 优先 `text/html`）—— 所以"单独复制公式能行、连正文一起复制就不行"
//     并不是随机的：单独复制时主流编辑器给的多半是纯文本，走的是我们已修好的 markdown 文本通道；
//   * 主流编辑器的 HTML 里公式是 **KaTeX 的 DOM**（`.katex` / `.katex-display`，里面还同时有
//     MathML 的 `<mi>`、`<annotation encoding="application/x-tex">` 与视觉层 `.katex-html`），
//     而我们的 schema 只认自己那两种形态（`div[data-md-math-block][data-source]` /
//     `span[data-md-math]`）⇒ KaTeX 的 DOM 被"通用 HTML→PM 解析"当普通元素**拆成了纯文本**，
//     连三段文字（MathML 符号 + TeX 原文 + 视觉字形）都会拼在一起（实测 `xx = \frac{…}x=2a−b…`）；
//   * 一旦成了纯文本，用户看到的 `\\frac` 与行尾 `\` 全是**下游症状**：
//     普通文本里的 `\` 会被写出器按 CommonMark 转义成 `\\`，行内硬换行按仓库既有约定
//     写成行尾 `\`（见 extensions.ts 里 `breaks: false` 那段注释）。
//
// 所以这一层只做一件事：**粘贴前把剪贴板 HTML 里的数学换成我们自己的节点形态**，
// 其余 DOM 原样保留、交给 PM 的常规 HTML 解析 —— **没有数学就直接不接管**（普通富文本粘贴
// 一个字节都不受影响）。
//
//   取原文的顺序：`annotation[encoding="application/x-tex"]`（KaTeX 与 MathJax 都输出它）
//     → `data-md-math-rendered` / `data-source` / `data-math` / `data-latex`（我们自己的复制、
//     以及主流编辑器之类可能带的属性）
//   行内 / 块级：`.katex-display`、`mjx-container[display="true"]`、`[data-md-math-block]`、
//     或"父块里只有它一个内容"⇒ 块级；其余 ⇒ 行内
//   产出形态：块级 `div[data-md-math-block][data-source]`、行内 `span[data-md-math]` 里放
//     `$…$` 字面量 —— 这两种正是 `MathBlock.parseHTML` / `MdMath.parseHTML` 认的形态，
//     序列化出去也就自然是规范的 `$$\n…\n$$` 与 `$…$`。

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser, Slice } from '@tiptap/pm/model'
import type { EditorProps } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Slice as PMSlice } from '@tiptap/pm/model'
// 显式 `.ts`：这个模块要被 tests/mathScan.test.mjs 直接加载，而 Node 的 ESM 不做扩展名补全
//（与 mathMarkers.ts 里那两行同一口径）
import { matchBlockMath } from '../mathScan.ts'

/** 认得出"这是数学"的元素（只认最外层：`.katex` 往往嵌在 `.katex-display` 里） */
const MATH_SELECTOR = [
  '.katex-display',
  '.katex',
  'mjx-container',
  '[data-md-math-block]',
  '[data-md-math-rendered]',
  '[data-math]',
  '[data-latex]'
].join(', ')

/** 直接带原文的属性（按可信度排序） */
const TEX_ATTRS = ['data-md-math-rendered', 'data-source', 'data-math', 'data-latex', 'data-tex']

/** 从元素（含其后代）里取回 TeX 原文；取不到返回 null */
function texOf(el: Element): string | null {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]')
  if (ann?.textContent) return ann.textContent
  for (const attr of TEX_ATTRS) {
    const value = el.getAttribute(attr)
    if (value) return value
  }
  // 自己复制出去的块级 NodeView：`data-source` 在外层 div 上（上面已覆盖）
  return null
}

/** 这个数学元素是不是**独占一块**（决定插成 mathBlock 还是行内 `$…$`） */
function isDisplayMath(el: Element): boolean {
  if (el.matches('.katex-display, [data-md-math-block], mjx-container[display="true"]')) return true
  const parent = el.parentElement
  if (!parent) return false
  if (parent.tagName !== 'P' && parent.tagName !== 'DIV') return false
  // 父块里"只有它一个内容"（忽略空白文本）⇒ 按块级处理
  let others = 0
  parent.childNodes.forEach((node) => {
    if (node === el) return
    if (node.nodeType === 3 && !(node.textContent ?? '').trim()) return
    others += 1
  })
  return others === 0
}

/**
 * 把 HTML 里的数学换成我们自己的节点形态。
 * @returns 重写后的 HTML（`math` 为 0 时调用方**不该**接管这次粘贴）
 */
export function rewriteMathHtml(html: string): { html: string; math: number } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  let math = 0
  // 先收集、再处理：处理过程中会改 DOM，边遍历边改会让 `querySelectorAll` 的结果失真
  const candidates = Array.from(doc.body.querySelectorAll(MATH_SELECTOR))
  for (const el of candidates) {
    if (el.closest(MATH_SELECTOR) !== el) continue // 只认最外层（`.katex` 在 `.katex-display` 里）
    const tex = texOf(el)
    if (tex === null || !tex.trim()) continue
    const display = isDisplayMath(el)
    const replacement = doc.createElement(display ? 'div' : 'span')
    if (display) {
      replacement.setAttribute('data-md-math-block', '')
      replacement.setAttribute('data-source', tex)
    } else {
      replacement.setAttribute('data-md-math', '')
      replacement.textContent = `$${tex}$`
    }
    /**
     * 我们自己复制出去的 HTML 里，行内公式是「渲染 widget + 折叠原文」两个节点
     *（`span.md-math-rendered` 后面紧跟 `span.md-math-source`，里面是字面 `$…$`）。
     * 换掉 widget 之后必须**把折叠原文一起丢掉**，否则粘出来会多一份 `$…$` 字面文本。
     */
    const next = el.nextElementSibling
    const folded = next && next.classList.contains('md-math-source') ? next : null
    el.replaceWith(replacement)
    folded?.remove()
    math += 1
  }
  return { html: doc.body.innerHTML, math }
}

/**
 * 纯文本里有没有**块级**公式（`$$…$$`）。
 *
 * 只认块级：这样"HTML 里没有数学、但纯文本里有 `$$…$$`"时才会改走 markdown 文本通道，
 * 而"富文本正文里恰好有个 `$x$`"不会把整段富文本降级成纯文本（保守取舍）。
 */
export function hasBlockMathText(text: string): boolean {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (matchBlockMath(lines, i)) return true
  }
  return false
}

/** `$$…$$` 与普通段落混在一起时，也要整块成公式 —— 这里直接复用 markdown 解析那条通道 */
function markdownSlice(
  view: EditorView,
  text: string,
  parser: { parse(t: string): string } | undefined
): PMSlice | null {
  if (!parser) return null
  const html = parser.parse(text)
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  const slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom, {
    preserveWhitespace: true,
    context: view.state.selection.$from
  } as unknown as Parameters<PMDOMParser['parseSlice']>[1])
  return closeBlockSlice(slice)
}

/**
 * 块级粘贴显式闭合开放边缘 —— 与 `markdownPaste.ts` 的 `transformPasted` 同一条口径：
 * 不闭合的话 `replaceSelection` 会把首个块并进当前段落（粘进来的标题/公式块就"没了"）。
 * ⚠️ 我们自己 dispatch 的 slice **不经过** `transformPasted`（那是 PM 粘贴处理的钩子），
 * 所以这里必须自己来一遍。
 */
function closeBlockSlice(slice: PMSlice): PMSlice {
  const first = slice.content.firstChild
  if (!slice.openStart || !first) return slice
  const closable =
    first.isTextblock ||
    first.type.name === 'blockquote' ||
    first.type.name === 'bulletList' ||
    first.type.name === 'orderedList' ||
    first.type.name === 'taskList'
  return closable ? new Slice(slice.content, 0, 0) : slice
}

/** 解析重写后的 HTML 为 Slice（块级闭合规则同上） */
function htmlSlice(view: EditorView, html: string): PMSlice {
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  const slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom, {
    preserveWhitespace: true,
    context: view.state.selection.$from
  } as unknown as Parameters<PMDOMParser['parseSlice']>[1])
  return closeBlockSlice(slice)
}

/** 用一次事务插入（**一个可撤销的步**） */
function insertSlice(view: EditorView, slice: PMSlice): boolean {
  if (!slice.content.size) return false
  const tr = view.state.tr.replaceSelection(slice)
  view.dispatch(tr.scrollIntoView())
  return true
}

export const MathPaste = Extension.create({
  name: 'mathPaste',
  addProseMirrorPlugins() {
    /**
     * markdown 解析器由 `Markdown` 扩展装进 `editor.storage`（与 `markdownPaste.ts` 同一取法）。
     * 纯文本通道要用它把 `$$…$$` 整块解析成 `mathBlock` 节点。
     */
    const parser = (
      this.editor.storage as {
        markdown?: { parser?: { parse(text: string): string } }
      }
    ).markdown?.parser
    return [
      new Plugin({
        key: new PluginKey('mathPaste'),
        props: {
          handlePaste(view: EditorView, event: ClipboardEvent): boolean {
            const dt = event.clipboardData
            if (!dt) return false
            // 图片粘贴交给 ImagePaste（它排在前面，这里只是兜底不抢）
            if (dt.files && dt.files.length) return false
            const html = dt.getData('text/html')
            const text = dt.getData('text/plain')
            if (html) {
              const rewritten = rewriteMathHtml(html)
              if (rewritten.math > 0) return insertSlice(view, htmlSlice(view, rewritten.html))
            }
            // HTML 里没有数学，但纯文本里有 `$$…$$`：走 markdown 文本通道
            //（单独复制公式时主流编辑器给的就是纯文本，这条路实测本来就正确）
            if (text && hasBlockMathText(text)) {
              const slice = markdownSlice(view, text, parser)
              if (slice) return insertSlice(view, slice)
            }
            return false
          }
        } as unknown as EditorProps
      })
    ]
  }
})
