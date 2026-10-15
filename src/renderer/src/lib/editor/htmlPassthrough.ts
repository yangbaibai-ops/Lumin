// ─── 行内 / 块级 HTML 原样保留（Wave 1 缺口：html-inline.md）─────────────────
//
// 问题：Markdown 允许直接嵌 HTML（`<kbd>Ctrl</kbd>`、`<br>`、`<!-- 注释 -->`、
// `<details>`…），而 ProseMirror 的 DOMParser **只认识 schema 里有的节点** ——
// 未知标签一律被剥掉，只剩文字。于是 `<kbd>Ctrl</kbd>` 往返后变成 `Ctrl`，
// 注释整条消失，`<br>` 还被写成 `\`（语义从「HTML 换行」变成「Markdown 硬换行」）。
//
// 解法与反斜杠转义（MdEscape）、front matter 同一套：**在 markdown-it 那一层就认领，
// 让原文以「原样输出」的形态进文档**。
//   1. `parse.setup` 里覆盖 markdown-it 的 `html_inline` / `html_block` 渲染规则：
//      行内的包成 `<span data-md-html>原文</span>`，块级的包成 `<pre data-md-htmlblock>原文</pre>`；
//   2. 行内 → `MdHtml` mark（open/close 为空 + escape:false）→ 序列化**逐字写回**；
//      块级 → `HtmlBlock` 原子节点（原文放在节点属性/文本里）→ 序列化原样写回；
//   3. 两者都不参与行内标记派生（在 toAtoms 里当不透明内容看待），所以 `*`/`_` 这类
//      字符不会被当成 Markdown 语法再解释一遍。
//
// 取舍（写在这里免得以后当成 bug）：
//   * WYSIWYG 里**按源码显示**（`<kbd>Ctrl</kbd>` 就是这几个字符，等宽字体 + 淡色）。
//     把任意 HTML 真渲染出来是另一个功能（要沙箱、要样式隔离），不是保真缺口；
//     而「把标签吃掉」是**静默丢内容**，两害相权取保真。
//   * 块级 HTML 是原子节点：不能在 WYSIWYG 里就地编辑（改它走源码模式），
//     与 front matter 节点同一套语义。
import { Extension, Mark, Node } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
// 显式 .ts：本模块要被 tests/markdownRulePatches.test.mjs 直接加载（Node 的 ESM 不做扩展名补全）
import { escapeHtml } from '../utils/html.ts'
// 显式 `.ts` 同上：Node 的 ESM 不做扩展名补全，`markdownRulePatches.test.mjs` 直接加载本模块
import { deferAfterPmEvent } from './defer.ts'

/** markdown-it 实例（只用到 renderer.rules） */
interface MdHtmlInstance {
  __luminHtmlRules?: boolean
  renderer?: { rules: Record<string, unknown> }
}

/**
 * 任务列表的复选框是 `markdown-it-task-lists` 插件**生成**的 `html_inline` token
 * （`<input class="task-list-item-checkbox" …>`），不是用户源码里写的 HTML ——
 * 它由 tiptap-markdown 的 TaskItem `updateDOM` 钩子认领后删掉、换成节点的 `checked` 属性。
 * 若把它也当「用户写的行内 HTML」原样保留，任务列表就会变成一堆标签文本（实测踩到：
 * `task-lists.md` 从 exact 掉到 lossy）。所以这类 token 放它原样通过。
 * 判据用插件生成时写死的 class 名，用户手写的 `<input>` 不会被误伤。
 */
const TASK_CHECKBOX_RE = /^<input\b[^>]*class="task-list-item-checkbox"/

/** 覆盖 html_inline / html_block 的渲染规则（幂等：每次 parse 前都会拿到同一个实例） */
function patchHtmlRules(md: unknown): void {
  const m = md as MdHtmlInstance
  if (!m?.renderer?.rules || m.__luminHtmlRules) return
  m.__luminHtmlRules = true
  // 行内 HTML：进文档后是一段带 MdHtml mark 的文本，序列化逐字写回
  m.renderer.rules.html_inline = (tokens: { content: string }[], idx: number): string => {
    const raw = tokens[idx].content
    if (TASK_CHECKBOX_RE.test(raw)) return raw
    return `<span data-md-html>${escapeHtml(raw)}</span>`
  }
  // 块级 HTML：整段原文交给 HtmlBlock 节点（含缩进与换行，逐字保留）
  m.renderer.rules.html_block = (tokens: { content: string }[], idx: number): string =>
    `<pre data-md-htmlblock>${escapeHtml(tokens[idx].content)}</pre>\n`
}

/** 行内 HTML 原文的 mark：内容就是 `<kbd>` 这样的原文，序列化原样输出 */
export const MdHtml = Mark.create({
  name: 'mdHtml',
  renderHTML() {
    return ['span', { 'data-md-html': 'true', class: 'md-html' }, 0]
  },
  parseHTML() {
    return [{ tag: 'span[data-md-html]', priority: 60 }]
  },
  addStorage() {
    return {
      markdown: { serialize: { open: () => '', close: () => '', escape: false } }
    }
  }
})

/** 块级 HTML：整段原文（可能多行）放节点里，序列化原样写回 */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      /** 原始 HTML 片段（含缩进与换行） */
      source: { default: '' }
    }
  },
  parseHTML() {
    return [
      {
        tag: 'pre[data-md-htmlblock]',
        priority: 60,
        getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },
  renderHTML({ node }) {
    return ['pre', { 'data-md-htmlblock': 'true', class: 'md-htmlblock' }, node.attrs.source]
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(t: string): void; closeBlock(n: unknown): void },
          node: { attrs: { source: string } }
        ): void {
          // 原文里可能没有收尾换行：markdown-it 的 html_block 内容一般带，逐字写回即可
          state.write(node.attrs.source.replace(/\n$/, ''))
          state.closeBlock(node)
        },
        // 解析钩子挂在节点上（tiptap-markdown 只会遍历节点/mark 的 markdown storage）
        parse: { setup: (md: unknown) => patchHtmlRules(md) }
      }
    }
  }
})

export { patchHtmlRules }

// ─── 未闭合的标签片段 ⇒ 逐字写回（第三十四轮报障④）────────────────────────────
//
// 报障原话：`<img … /><img … /`（**第二个标签不完整**）时"第一张图不显示"，
// 而且"后面不完整的图片源码影响"了整行。
//
// 实测（同一份夹具、逐字节对比 `getMarkdown()`）：
//   输入 `<img src="…" style="zoom:25%;" /><img src="…" style="zoom:25%;" /`
//   输出 `<img src="…" style="zoom:25%;" />&lt;img src="<https://…jpg_wh860.jpg>" style="zoom:25%;" /`
// 两处变形：
//   * 第一个标签之后的残片（`<img src="` + URL + `" style="…" /`）是**普通文本**，
//     `prosemirror-markdown` 的 `esc()` 把 `<` 转义成 `&lt;`；
//   * 残片里的裸 URL 被 markdown-it 的 linkify 认成链接 ⇒ 序列化写成 `<URL>` 自动链接形态。
// （第一个标签本身走 `html_inline` → `MdHtml`（`escape:false`）⇒ 它是逐字写回的，没问题。）
//
// 成因是 CommonMark 的口径：`<img … />` 是**完整的**行内 HTML，而 `<img … /` 不是 ——
// 它不是 `html_inline`、也不是 `html_block`（类型 7 要求整行只有一个完整开标签），
// 于是落到"普通文本"这一档，逐字写回的通道就断了。
//
// 修法沿用仓库既有的逐字写回通道（不新造机制）：**已经含行内 HTML 的块**里，
// 从"未闭合标签"的 `<` 起、到块尾，整段挂 `MdHtml`（`open/close` 为空 + `escape:false`）
// 并摘掉其中的 `link` mark。判据刻意收得很窄：
//   * 只认 `<` **紧跟字母**（真标签名）且**其后没有任何 `>`** 的起点 —— `a < b`、`x <y` 不命中；
//   * 只处理**已经含 `MdHtml`** 的块（= 这一段本来就在按源码显示 HTML）——
//     普通正文一个字节都不动，`tests/md-fidelity` 那批夹具因此不受影响；
//   * 与 `MdHtml` 的其它用法（第一个完整标签）合流，序列化当然是逐字写回。
// 幂等：`[from, to)` 里的文本已经全带 `MdHtml`、且不含 `link` ⇒ 返回 `null`（归一化收敛）。

/** HTML 标签名起头（`<` + 字母）—— `a < b` 不在此列 */
const TAG_START_RE = /[A-Za-z]/

/**
 * 文本里**第一个未闭合标签**的起点下标：`<` + 字母，且从它往后**没有任何 `>`**。
 * @returns 下标；没有未闭合标签时 `-1`
 */
export function unclosedTagStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '<') continue
    const next = text[i + 1]
    if (!next || !TAG_START_RE.test(next)) continue
    if (text.indexOf('>', i + 1) === -1) return i
  }
  return -1
}

/**
 * 文档级归一化：把每个"含行内 HTML 的块"里未闭合标签之后的残片交给逐字写回。
 * @returns 真有改动时的事务；否则 `null`（调用方不该 dispatch）
 */
export function literalizeUnclosedHtmlTr(state: EditorState): Transaction | null {
  const mdHtml = state.schema.marks.mdHtml
  if (!mdHtml) return null
  const link = state.schema.marks.link
  const tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textContent
    if (!text.includes('<')) return true
    // 这一段本来就在按源码显示 HTML 吗？（没有就完全不管 —— 见文件末的判据说明）
    let hasHtml = false
    node.descendants((child) => {
      if (child.isText && child.marks.some((m) => m.type.name === 'mdHtml')) {
        hasHtml = true
        return false
      }
      return true
    })
    if (!hasHtml) return true
    const start = unclosedTagStart(text)
    if (start < 0) return true
    // 文本下标 → 文档位置：只累加**文本节点**的长度；起点必须落在某个文本节点里
    let offset = 0
    let from = -1
    node.forEach((child, childOffset) => {
      if (from >= 0 || !child.isText) return
      const len = child.text?.length ?? 0
      if (start >= offset && start < offset + len) from = pos + 1 + childOffset + (start - offset)
      offset += len
    })
    if (from < 0) return true
    const to = pos + 1 + node.content.size
    // 幂等：这一段已经全带 MdHtml、也没有夹着 link ⇒ 不动（否则 appendTransaction 不收敛）
    let need = false
    state.doc.nodesBetween(from, to, (child) => {
      if (!child.isText) return true
      const names = child.marks.map((m) => m.type.name)
      if (!names.includes('mdHtml') || names.includes('link')) need = true
      return true
    })
    if (!need) return true
    // 表示层归一化：不进撤销栈（`Ctrl+Z` 不该撤出"源码被转义"这种中间态）
    tr.setMeta('addToHistory', false)
    tr.addMark(from, to, mdHtml.create())
    if (link) tr.removeMark(from, to, link)
    changed = true
    return true
  })
  return changed ? tr : null
}

/** 归一化入口（视图版）：真改了才 dispatch */
export function literalizeUnclosedHtml(view: EditorView): boolean {
  if (view.isDestroyed) return false
  const tr = literalizeUnclosedHtmlTr(view.state)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

export const htmlTailLiteralKey = new PluginKey('htmlTailLiteral')

/**
 * 未闭合 HTML 标签残片的逐字写回。
 *
 * 两个入口缺一不可：
 *   * `view()` 里**延后一拍**跑一次 —— 打开文件 / 切模式是"整装创建"（`createDocument`），
 *     没有事务经过插件 ⇒ 只靠 `appendTransaction` 的话，刚打开的文档不会被归一化
 *     （与 `normalizeMdMarkers` 的 `onCreate` 入口同一个道理）；
 *   * `appendTransaction`（有文档变更时）—— 用户边打字边改坏标签时跟上。
 */
export const HtmlTailLiteral = Extension.create({
  name: 'htmlTailLiteral',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: htmlTailLiteralKey,
        view: (view) => {
          deferAfterPmEvent(() => literalizeUnclosedHtml(view))
          return {}
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null
          return literalizeUnclosedHtmlTr(newState)
        }
      })
    ]
  }
})
