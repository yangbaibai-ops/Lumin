// ─── 图片：源码标记 + 悬浮工具栏 + 缩放持久化（第五十三轮）──────────────────────
//
// 用户口径（原话要点）：图片**居中**；**点击图片在它上方显示源码**（`![](…)` 或 `<img …>`），
// 这份源码对图片就相当于 `**` 对加粗字 —— 是**标记字符**，显隐沿用行内标记那套判据；
// 右上角出现**悬浮工具栏**（100/75/50/25，当前档有选中态）且**不遮挡源码行**；
// 点档位**把缩放写进源码**：`![ ](https://…jpg)` 点 50% ⇒
// `<img src="https://…jpg" style="zoom:50%;" />`（**持久化进文档**），已是 HTML 形式则**原地更新**
// `style` 里的 `zoom`（不许出现第二个 `<img>`）。
//
// ── 为什么"原始 HTML 图片"不改文档结构 ────────────────────────────────────────
// 裸 `<img …>` 走 `htmlPassthrough.ts`：markdown-it 的 `html_inline` 把它包成
// `<span data-md-html>`，进文档是**一段带 `MdHtml` mark 的文本**（`escape:false` 逐字写回）。
// 如果为了"渲染成图片"把它换成 Image 节点，往返就不是逐字节不变了（属性顺序、引号、
// 自闭合写法都可能被重排）。所以这里**不动文档**：文本仍然是那段原文（保存/导出逐字节不变），
// 我们只在**视图层**做两件事 ——
//   * 把这段原文隐藏（`display:none` 的装饰）并在同一位置画一个**真正的图片**（widget 装饰）；
//   * 点开时在图片**上方**再画一行源码（widget 装饰，只读 + 可复制）。
// 于是"源码 = 标记字符"这件事是字面成立的：**文档里存的就是源码本身**。
//
// `![alt](src)`（真 Image 节点）那一半：源码行内容由节点算出来（`![alt](src)`）；
// 一旦点了档位，就把它**替换成上面那种原文**（`<img … style="zoom:50%;" />`）——
// 这正是用户要的"缩放持久化进源码"。之后所有档位都在同一段原文上原地改 style，
// 因此永远不会出现第二个 `<img>`。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import i18n from '../../i18n'

/** 图片的一段"源码标记"：节点形式（`![alt](src)`）或原文形式（`<img …>`） */
export interface ImgSource {
  /** 'node' = Tiptap 的 Image 节点；'raw' = 文档里那段 `<img …>` 原文 */
  kind: 'node' | 'raw'
  from: number
  to: number
  src: string
  alt: string
  /** 节点形式：null（还没写过 zoom）；原文形式：从 style 里读出来 */
  zoom: number | null
  /** 视图层要显示的源码文本（标记字符本体） */
  markdown: string
}

const RAW_IMG_RE = /^<img\b[^>]*\/?>$/i
/** `![alt](url)` 形态的**原文**（第五十九轮：节点转成原文文本后用的就是这一形） */
const MD_IMG_RE = /^!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/

/** 这段文本是不是"整段就是一个 `<img …>`" */
export function isRawImgHtml(text: string): boolean {
  return RAW_IMG_RE.test(text.trim())
}

/** 这段文本是不是"整段就是一个 markdown 图片语法"（`![alt](url)`） */
export function isMdImgSource(text: string): boolean {
  return MD_IMG_RE.test(text.trim())
}

/** 两种原文形态都认：`<img …>` 与 `![alt](url)` */
export function isImgSourceText(text: string): boolean {
  return isRawImgHtml(text) || isMdImgSource(text)
}

/**
 * 解析一段"图片源码文本"（两种形态）。
 * 解析不出来 ⇒ `null`：调用方**不许**把它当图片渲染（第五十九轮用户口径：
 * 语法一旦不完整，就不再显示图片，那段文本按普通正文显示）。
 */
export function parseImgSourceText(
  raw: string
): { src: string; alt: string; zoom: number | null } | null {
  const t = raw.trim()
  if (isRawImgHtml(t)) {
    const src = rawHtmlAttr(t, 'src')
    if (!src) return null
    return { src, alt: rawHtmlAttr(t, 'alt') ?? '', zoom: zoomOfStyle(rawHtmlAttr(t, 'style')) }
  }
  const m = MD_IMG_RE.exec(t)
  if (m) return { src: m[2], alt: m[1], zoom: null }
  return null
}

/** 取 HTML 属性（单双引号与裸值都认） */
export function rawHtmlAttr(raw: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? ''
}

/** 从 `style="…"` 里读 `zoom`（百分数；读不到 → null） */
export function zoomOfStyle(style: string | null): number | null {
  if (!style) return null
  const m = /zoom\s*:\s*([\d.]+)\s*%?/i.exec(style)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * 用户给的确切形状：`<img src="URL" style="zoom:50%;" />`。
 * 有 alt 时插在 src 前（`<img alt="x" src="URL" style="zoom:50%;" />`）—— 验收判据用的是无 alt 的图，
 * 逐字节等于用户给的形状。
 */
export function zoomedImgHtml(src: string, alt: string, zoom: number): string {
  const a = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : ''
  return `<img${a} src="${src}" style="zoom:${zoom}%;" />`
}

/**
 * 已是 HTML 形式：**原地**更新 `style` 里的 `zoom`（没有 `style` 就补一个），
 * 保留其余属性与自闭合写法 ⇒ 文档里永远只有一个 `<img>`。
 */
export function withZoomInRaw(raw: string, zoom: number): string {
  const decl = `zoom:${zoom}%;`
  const styleRe = /style\s*=\s*("([^"]*)"|'([^']*)')/i
  const m = styleRe.exec(raw)
  if (m) {
    const quote = m[1][0]
    const body = (m[2] ?? m[3] ?? '').trim()
    let next: string
    if (/zoom\s*:/i.test(body)) next = body.replace(/zoom\s*:\s*[^;]+;?/i, decl)
    else if (body === '' || body.endsWith(';')) next = `${body}${decl}`
    else next = `${body};${decl}`
    return raw.replace(styleRe, `style=${quote}${next}${quote}`)
  }
  return `${raw.replace(/\s*\/?>$/, '')} style="${decl}" />`
}

/**
 * 显隐判据（与行内标记同一套口径，见 typoraInlineMarks 的说明）：
 *   * 选区落在构造**内部**（含恰好等于两端 = 点图片/点源码行）⇒ **显示**；
 *   * 非空选区**完全包住**构造 ⇒ **不显示**；
 *   * 选区边界**严格切进**构造内部 ⇒ **显示**；
 *   * 其余（光标在别处、点别处）⇒ **不显示**。
 * 纯函数：套件直接按它断言四态。
 */
export function revealDecision(
  sel: { from: number; to: number; empty: boolean; nodeSel: boolean },
  img: { from: number; to: number }
): 'show' | 'hide' {
  // 点图片（NodeSelection 正好盖住它）⇒ 显示
  if (sel.nodeSel && sel.from === img.from) return 'show'
  /**
   * 第七十二轮（用户报障）：标识符**已经是正文**（可点入/可拖选/可复制）⇒ 它与选区的判据
   * 也按正文来：**只要有交集就保持可见**（选中全部字符、甚至完全包住它，也不许消失）；
   * 只有选区**完全离开**它时才隐藏。
   * 旧实现里"完全包住 ⇒ hide / 恰好等长 ⇒ hide"是行内标记（`**`）那套"标记字符"语义
   * （见 typoraInlineMarks.ts，本函数不参与那条线），对图片标识符不再适用。
   */
  const intersects = sel.from <= img.to && sel.to >= img.from
  return intersects ? 'show' : 'hide'
}

/** 文档里所有"图片源码"（节点形式 + 原文形式），按位置排序 */
export function collectImgSources(state: EditorState): ImgSource[] {
  const out: ImgSource[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      const alt = String(node.attrs.alt ?? '')
      const src = String(node.attrs.src ?? '')
      out.push({
        kind: 'node',
        from: pos,
        to: pos + node.nodeSize,
        src,
        alt,
        zoom: null,
        markdown: alt ? `![${alt}](${src})` : `![](${src})`
      })
      return false
    }
    // ⚠️ 独立成行的 `<img …>` 会被 markdown-it 判成 **html_block**（不是行内文本），
    //    于是进文档的是 `HtmlBlock` 原子节点（`source` 属性里是原文）——
    //    这是"一段就是一张 HTML 图片"的最常见形态，必须一起认。
    if (node.type.name === 'htmlBlock') {
      const source = String(node.attrs.source ?? '').trim()
      const parsed = parseImgSourceText(source)
      if (!parsed) return false
      out.push({
        kind: 'raw',
        from: pos,
        to: pos + node.nodeSize,
        src: parsed.src,
        alt: parsed.alt,
        zoom: parsed.zoom,
        markdown: source
      })
      return false
    }
    if (node.isText && isImgSourceText(node.text ?? '')) {
      const raw = (node.text ?? '').trim()
      const parsed = parseImgSourceText(raw)
      if (!parsed) return false
      out.push({
        kind: 'raw',
        from: pos,
        to: pos + node.nodeSize,
        src: parsed.src,
        alt: parsed.alt,
        zoom: parsed.zoom,
        markdown: raw
      })
      return false
    }
    return true
  })
  return out.sort((a, b) => a.from - b.from)
}

const KEY = new PluginKey<{ from: number | null; editing?: boolean; openedAt?: number }>(
  'luminImageSource'
)

/** 悬浮工具栏的 DOM id（每篇文档一个；重建时旧节点会被删掉） */
const TOOLBAR_CLASS = 'img-zoom-bar'
const ZOOM_STEPS = [100, 75, 50, 25]

/** 把一段源码文本换成新的（保留 MdHtml mark 的"逐字写回"语义） */
function replaceRaw(view: EditorView, img: ImgSource, nextText: string): void {
  const { state } = view
  const mark = state.schema.marks.mdHtml
  const marks = mark ? mark.create() : undefined
  const text = state.schema.text(nextText, marks ? [marks] : undefined)
  view.dispatch(state.tr.replaceWith(img.from, img.to, text))
}

/** 节点形式 → 原文形式（`![alt](src)` ⇒ `<img … style="zoom:X%;" />`） */
function nodeToRaw(view: EditorView, img: ImgSource, zoom: number): void {
  const { state } = view
  const mark = state.schema.marks.mdHtml
  const text = state.schema.text(
    zoomedImgHtml(img.src, img.alt, zoom),
    mark ? [mark.create()] : undefined
  )
  view.dispatch(state.tr.replaceWith(img.from, img.to, text))
}

/** 点档位：节点/`![alt](url)` 原文 → 换成用户要的 `<img … style="zoom:X%;" />`；已是 `<img …>` → **原地**改 style 里的 zoom */
export function applyZoom(view: EditorView, img: ImgSource, zoom: number, open: boolean): void {
  if (img.kind === 'raw') {
    const at = view.state.doc.nodeAt(img.from)
    const raw = at?.isText ? (at.text ?? '') : String(at?.attrs.source ?? '')
    // `![alt](url)` 形态（节点刚转成的原文）⇒ 直接换成用户给的确切形状（一个 `<img>`）；
    // `<img …>` 形态 ⇒ 原地只改 style 里的 zoom（绝不新增第二个标签）。
    const next = isRawImgHtml(raw)
      ? withZoomInRaw(raw.trim(), zoom)
      : zoomedImgHtml(img.src, img.alt, zoom)
    if (at?.type.name === 'htmlBlock') {
      view.dispatch(view.state.tr.setNodeMarkup(img.from, undefined, { ...at.attrs, source: next }))
    } else {
      replaceRaw(view, img, next)
    }
  } else {
    nodeToRaw(view, img, zoom)
  }
  // 换完之后把"打开"状态挪到新的范围上（长度可能变了），否则工具栏会立刻消失
  requestAnimationFrame(() => {
    const next = collectImgSources(view.state).find((i) => i.src === img.src)
    if (next)
      view.dispatch(view.state.tr.setMeta(KEY, { from: open ? next.from : null, editing: false }))
  })
}

/**
 * 把源码行的文本解析成"要写进文档的形态"（第五十五轮：源码行可编辑）。
 *   * `![alt](url)`            → `{ kind: 'md', alt, src }`
 *   * `<img src=… style=… />`  → `{ kind: 'html', src, alt, zoom, raw }`
 *   * 其它一律 `null` —— **解析不出来就绝不动文档**（宁可给用户一次红边反馈）。
 */
export function parseImgSourceInput(
  text: string
):
  | { kind: 'md'; alt: string; src: string }
  | { kind: 'html'; src: string; alt: string; zoom: number | null; raw: string }
  | null {
  const t = text.trim()
  if (!t) return null
  const md = /^!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/.exec(t)
  if (md) return { kind: 'md', alt: md[1], src: md[2] }
  if (isRawImgHtml(t)) {
    const src = rawHtmlAttr(t, 'src')
    if (!src) return null
    return {
      kind: 'html',
      src,
      alt: rawHtmlAttr(t, 'alt') ?? '',
      zoom: zoomOfStyle(rawHtmlAttr(t, 'style')),
      raw: t
    }
  }
  return null
}

/** 一次"源码行提交"的落点：`null` = 内容非法（调用方不许动文档） */
export function commitImgSource(view: EditorView, img: ImgSource, text: string): boolean {
  const parsed = parseImgSourceInput(text)
  if (!parsed) return false
  const { state } = view
  const isBlock = state.doc.nodeAt(img.from)?.type.name === 'htmlBlock'
  if (parsed.kind === 'md') {
    if (img.kind === 'node') {
      const node = state.doc.nodeAt(img.from)
      view.dispatch(
        state.tr.setNodeMarkup(img.from, undefined, {
          ...node?.attrs,
          alt: parsed.alt,
          src: parsed.src
        })
      )
    } else {
      // 原文形态 → 换回真图片节点（**一个**节点，不会留下第二个标签）
      const image = state.schema.nodes.image.create({ alt: parsed.alt, src: parsed.src })
      view.dispatch(state.tr.replaceWith(img.from, img.to, image))
    }
    return true
  }
  // HTML 形态
  if (img.kind === 'node') {
    // 节点 → 原文形态（与点档位同一条路：`zoomedImgHtml` 是唯一的产出形状）
    nodeToRaw(view, img, parsed.zoom ?? 100)
    return true
  }
  if (isBlock) {
    const node = state.doc.nodeAt(img.from)
    view.dispatch(
      state.tr.setNodeMarkup(img.from, undefined, { ...node?.attrs, source: parsed.raw })
    )
  } else {
    replaceRaw(view, img, parsed.raw)
  }
  return true
}

/**
 * 这张图是不是"行内"的（第五十八轮：标记要不要**贴行顶**就靠它）。
 *
 * 判据与 widget 的分支**同一个**：块级 `HtmlBlock`（独占一行）恒为块级；
 * 其余看它所在的块里还有没有别的**非空**内容（文本 / 其它节点）——有就是行内混排，
 * 没有就是"这一段只有这张图"（按块级居中）。
 */
export function imgIsInline(state: EditorState, img: ImgSource): boolean {
  if (state.doc.nodeAt(img.from)?.type.name === 'htmlBlock') return false
  const $pos = state.doc.resolve(img.from)
  const parent = $pos.parent
  const base = $pos.start()
  let others = 0
  parent.forEach((child, offset) => {
    const childFrom = base + offset
    const childTo = childFrom + child.nodeSize
    // 跳过"这张图自己"；同一段里**别的**图片算"别的内容"（第六十五轮：两张相邻 ⇒ 按行内并排处理）
    if (childFrom <= img.from && img.to <= childTo) return
    if (child.isText) {
      const t = (child.text ?? '').trim()
      // ⚠️ 图片**自己的**那段源码文本不算"别的内容"（第六十二轮：`![alt](url)` 形态也要认，
      //    否则节点转文本之后会被判成"行内混排"，图片就从居中变居左 —— 用户报的跳跃）
      if (!t || isImgSourceText(t)) return
    }
    others += 1
  })
  return others > 0
}

/** 悬浮工具栏：定位在**图片矩形上方**（与"标识符"文本不相交），右对齐 */
function placeToolbar(bar: HTMLElement, anchor: HTMLElement | DOMRect): void {
  const r = anchor instanceof DOMRect ? anchor : anchor.getBoundingClientRect()
  if (!r.width && !r.height) return
  const parent = bar.offsetParent as HTMLElement | null
  const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
  const w = bar.offsetWidth || 170
  const h = bar.offsetHeight || 26
  const top = Math.max(2, r.top - base.top - h - 6)
  // 右侧留 6px 内缩：标记浮层可能很窄（1px 宽的图片），圆整误差会让两者"贴边相交"
  const left = Math.max(2, r.right - base.left - w - 6)
  bar.style.top = `${Math.round(top)}px`
  bar.style.left = `${Math.round(left)}px`
}

export const ImageSourceUi = Extension.create({
  name: 'luminImageSourceUi',

  addProseMirrorPlugins() {
    let bar: HTMLElement | null = null
    /** 这一次按下的落点（第六十五轮：激活挪到 mouseup，按下时什么都不做） */
    let pendingClick: { kind: 'raw' | 'node'; from: number } | null = null

    const ensureBar = (view: EditorView): HTMLElement => {
      if (bar && bar.isConnected) return bar
      bar = document.createElement('div')
      bar.className = TOOLBAR_CLASS
      bar.setAttribute('data-img-zoom-bar', '')
      bar.contentEditable = 'false'
      for (const pct of ZOOM_STEPS) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'img-zoom-bar__btn'
        b.setAttribute('data-img-zoom', String(pct))
        b.textContent = `${pct}%`
        bar.appendChild(b)
      }
      // 事件用**捕获**挂在工具栏自己身上：不碰文档，也不参与 ProseMirror 的输入
      bar.addEventListener('mousedown', (e) => e.stopPropagation(), true)
      bar.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement | null)?.closest?.('[data-img-zoom]')
        if (!btn) return
        e.preventDefault()
        e.stopPropagation()
        const pct = Number(btn.getAttribute('data-img-zoom'))
        const st = view.state
        const open = KEY.getState(st)?.from ?? null
        const img = open == null ? null : collectImgSources(st).find((i) => i.from === open)
        if (!img || !Number.isFinite(pct)) return
        applyZoom(view, img, pct, true)
      })
      const host = view.dom.parentElement ?? document.body
      host.appendChild(bar)
      return bar
    }

    const hideBar = (): void => {
      if (bar) bar.remove()
      bar = null
    }

    /**
     * 源码行浮层：一个挂在 `view.dom.parentElement` 上的绝对定位元素（内含可编辑 textarea）。
     * 它**不在 `view.dom` 里** ⇒ ProseMirror 的 DOM 观察者完全看不到它（编辑不丢字、不重绘），
     * 也不会进入 Markdown（导出/复制/往返都不带它）。
     */

    return [
      new Plugin<{ from: number | null; editing?: boolean; openedAt?: number }>({
        key: KEY,
        /**
         * ─── 规范形态：**同一份 Markdown ⇒ 同一份文档模型**（第六十三轮，核心）──────────
         *
         * markdown-it 把**独立成行**的 `<img …>` 判成 `html_block`（`HtmlBlock` 原子），
         * 行内的判成 `html_inline`（`MdHtml` mark 文本）—— 于是"解析既有文件"与
         * "打字/回车"两条入口会落成**两种模型**，同一份源码渲染不同（用户实测）。
         *
         * 这里在**归一化阶段**钉死规范形态：`HtmlBlock` 里"整段就是一个 `<img …>`"的，
         * 一律换成**普通段落 + 行内原文文本**（与打字路径一致），渲染交给既有装饰
         * （独占一行 ⇒ 居中；段里还有字 ⇒ 行内随文）。
         *   * 幂等：换完就没有 `htmlBlock` 形态的图片了，再跑一次是 no-op；
         *   * 逐字节不变：内容只 `trimEnd()`（markdown-it 的 html_block 会带结尾换行，
         *     而两个相邻段落的序列化本来就补一个空行 ⇒ 输出字节相同）；
         *   * 不进 undo 栈（`addToHistory: false`）：它只是"同一份源码的另一种表示"。
         */
        appendTransaction(trs, _old, next) {
          if (!trs.some((t) => t.docChanged)) return null
          const hits: number[] = []
          next.doc.descendants((node, pos) => {
            if (node.type.name !== 'htmlBlock') return true
            const src = String(node.attrs.source ?? '').trim()
            if (!isRawImgHtml(src)) return true
            hits.push(pos)
            return false
          })
          // 相邻的两个 `<img …>` 会被 PM 合并进**同一个文本节点**（同 mark 的相邻文本自动合并）
          // ⇒ "整段就是一个 `<img …>`"的识别会失配（⑭c/⑭d 实测：只命中 `img-src-incomplete`）。
          // 这里把"含 ≥2 个 `<img …>` 标签"的文本节点按**标签边界**拆成多个文本节点；
          // 拼起来与原串逐字节相同（序列化顺序不变）⇒ 逐字节不变；拆完每个节点 ≤1 个标签 ⇒ 幂等。
          const splits: { pos: number; to: number; segs: string[] }[] = []
          next.doc.descendants((node, pos) => {
            if (!node.isText) return true
            const raw = node.text ?? ''
            const tags = raw.match(/<img\b[^>]*\/?>/gi)
            if (!tags || tags.length < 2) return true
            const segs: string[] = []
            let last = 0
            for (const m of raw.matchAll(/<img\b[^>]*\/?>/gi)) {
              const at = m.index ?? 0
              if (at > last) segs.push(raw.slice(last, at))
              segs.push(m[0])
              last = at + m[0].length
            }
            if (last < raw.length) segs.push(raw.slice(last))
            splits.push({ pos, to: pos + node.nodeSize, segs })
            return true
          })
          if (!hits.length && !splits.length) return null
          const mdMark = next.schema.marks.mdHtml
          const para = next.schema.nodes.paragraph
          const tr = next.tr
          // 从后往前替换：前面的位置不受影响
          for (const pos of hits.reverse()) {
            const node = next.doc.nodeAt(pos)
            if (!node || node.type.name !== 'htmlBlock') continue
            const src = String(node.attrs.source ?? '').trim()
            const text = next.schema.text(src, mdMark ? [mdMark.create()] : undefined)
            tr.replaceWith(pos, pos + node.nodeSize, para.create(null, text))
          }
          // 拆分（同样从后往前；每段沿用同一个 MdHtml mark ⇒ 序列化逐字节不变）
          for (const sp of splits.reverse()) {
            tr.replaceWith(
              sp.pos,
              sp.to,
              sp.segs.map((s) => next.schema.text(s, mdMark ? [mdMark.create()] : undefined))
            )
          }
          if (!tr.docChanged) return null
          tr.setMeta('addToHistory', false)
          return tr
        },
        state: {
          /** `editing`：点开图片时是"选中态"（浅灰底）；光标落进标识符开始编辑 ⇒ true（无底） */
          init: () => ({ from: null, editing: false, openedAt: 0 }),
          apply(tr, value, _old, next) {
            // 第六十五轮：按住鼠标期间**不许**因选区变化而打开（用户口径："松开鼠标后才出现"）
            if (pendingClick && !tr.getMeta(KEY)) return value
            const meta = tr.getMeta(KEY) as { from: number | null; editing?: boolean } | undefined
            if (meta) {
              const sameOpen = meta.from != null && meta.from === value.from
              return {
                from: meta.from,
                editing: !!meta.editing,
                openedAt: sameOpen ? value.openedAt : Date.now()
              }
            }
            // 文档变了（例如点了档位）：位置可能失效 → 重新按选区判一次
            const imgs = collectImgSources(next)
            const sel = next.selection
            const selLike = {
              from: sel.from,
              to: sel.to,
              empty: sel.empty,
              nodeSel: sel.constructor.name === 'NodeSelection'
            }
            const keep =
              value.from == null ? null : (imgs.find((i) => i.from === value.from) ?? null)
            // ⚠️ 图片**节点**（原子）只认 NodeSelection：光标恰好停在它的边界上**不算"点开"** ——
            //    否则 `setContent` 之后的一次选区落点就会把它自动转成文本（⑭a 实测：并排的
            //    第二张图被自动转成原文、于是掉到下一行；⑬b 的"按下即现"也是同一根因）。
            const showable = (i: ImgSource): boolean =>
              revealDecision(selLike, i) === 'show' && (i.kind !== 'node' || selLike.nodeSel)
            const pick = keep && showable(keep) ? keep : (imgs.find((i) => showable(i)) ?? null)
            if (!pick) return { from: null, editing: false, openedAt: value.openedAt }
            /**
             * 光标**严格落进**标识符文本 ⇒ 正在编辑（底色撤掉；Typora 同观感）。
             * ⚠️ 第六十四轮：刚点开的那一下，浏览器/PM 会顺手把光标落到标识符里（那是这一击的
             * 收尾，不是"用户要点进文本来编辑"）⇒ 开点后 400ms 内忽略这种选区同步，
             * 底色才不会被"先加后撤"地闪一下。
             */
            const justOpened = Date.now() - (value.openedAt || 0) < 400
            const caretInside =
              sel.empty && sel.from > pick.from && sel.from < pick.to && !justOpened
            return {
              from: pick.from,
              editing: caretInside,
              openedAt: value.from === pick.from ? value.openedAt : Date.now()
            }
          }
        },
        props: {
          decorations(state) {
            const open = KEY.getState(state)?.from ?? null
            const openEditing = KEY.getState(state)?.editing === true
            const imgs = collectImgSources(state)
            const decos: Decoration[] = []
            // ① 图片**居中**：给"只有一张图"的块挂一个类（比 CSS `:only-child` 稳 ——
            //    行内图片旁边可能还有被隐藏的标记文本、或我们自己的 widget 装饰）
            state.doc.forEach((block, offset) => {
              if (!block.isBlock) return
              const from = offset
              const to = offset + block.nodeSize
              if (block.type.name === 'htmlBlock') {
                // 激活中**也要**保持居中（第六十二轮：否则"居中→居左"就是用户看到的跳跃）
                if (imgs.some((i) => i.kind === 'raw' && i.from === from)) {
                  decos.push(Decoration.node(from, to, { class: 'img-block-center' }))
                }
                return
              }
              const inside = imgs.filter((i) => i.from > from && i.to < to)
              if (inside.length !== 1) return
              // "这一段只有这一张图" ⇔ 它不是行内混排（同一判据，避免两处逻辑漂移）
              if (!imgIsInline(state, inside[0])) {
                decos.push(Decoration.node(from, to, { class: 'img-block-center' }))
              } else {
                /**
                 * 第七十轮（首帧对齐 bug）：**行内**图片所在的段落要显式打一个类。
                 * 原因：`p > img:only-child` 只看**元素**子节点 —— 段里若是
                 * `前文 ![]() 后文`（文字是文本节点、图片是唯一元素子节点）它**会命中**，
                 * 于是图片被设成 `display:block; margin:auto`（独占一行、文字跑到图片上方）
                 * ⇒ 用户看到"首次打开时文字与图片最上方齐平"。点一下图片后它变成 widget
                 * （段落里多了 `<span>` 元素）⇒ `:only-child` 不再命中 ⇒ 才恢复正常。
                 * 这里在**首帧的装饰阶段**就把类带上（不依赖任何后续 update/dispatch）。
                 */
                decos.push(Decoration.node(from, to, { class: 'img-inline-mode' }))
              }
            })
            for (const img of imgs) {
              if (img.kind === 'raw') {
                /**
                 * 第五十九轮口径：**标识符就是文档里那段文本本身**。
                 *   * 未激活 ⇒ 隐藏这段文本（内容仍在文档里，保存逐字节不变）+ 在原位画真图；
                 *   * 激活（点图片/边界切进）⇒ **原位显示这段文本**（它就是正文的一部分，
                 *     可以直接退格/输入改），图片**继续显示**；语法一旦被改坏，
                 *     `collectImgSources` 就不再认它 ⇒ 图片随之消失、只剩正文（用户第 2 条）。
                 * 行内上下文里保持行内（`文字 <img> 文字` 不拆行）。
                 */
                const isBlock = state.doc.nodeAt(img.from)?.type.name === 'htmlBlock'
                const active = img.from === open
                if (!active) {
                  decos.push(
                    isBlock
                      ? Decoration.node(img.from, img.to, { class: 'img-src-marker-hidden' })
                      : Decoration.inline(img.from, img.to, { class: 'img-src-marker-hidden' })
                  )
                } else {
                  /**
                   * 原位显形（Typora 观感）：
                   *   * 排版完全跟正文一致（不改 font/color）；
                   *   * 点开图片时给**浅灰底**（`--code-bg`，既有令牌）；光标落进文本开始编辑 ⇒ 去掉底；
                   *   * `vertical-align: top`：与图片同行时贴该行顶部；
                   *   * 关掉拼写检查的波浪线。
                   */
                  const attrs = {
                    // 块级图片（独占一行、靠 `img-block-center`/`margin-inline:auto` 居中）时的标识符
                    // **也走块级**：它自己占一行、不去挤图片那一行的行内流 —— 否则"块级 widget 前面
                    // 多了一段行内文本"会把图片从居中的位置挤走（第六十二轮实测 left 784→673）。
                    class: [
                      'img-src-revealed',
                      isBlock || !imgIsInline(state, img) ? 'img-src-revealed--block' : '',
                      openEditing ? 'img-src-revealed--editing' : ''
                    ]
                      .filter(Boolean)
                      .join(' '),
                    'data-img-revealed': '',
                    'data-img-kind': 'raw',
                    'data-img-from': String(img.from),
                    'data-img-editing': openEditing ? 'true' : 'false',
                    spellcheck: 'false',
                    autocorrect: 'off',
                    autocapitalize: 'off'
                  }
                  decos.push(
                    isBlock
                      ? Decoration.node(img.from, img.to, attrs)
                      : Decoration.inline(img.from, img.to, attrs)
                  )
                }
                // ⚠️ 第六十二轮：**不许因为激活而改变图片的布局**（用户报障："居中变成居左"）。
                //    行内/块级判据与未激活时**完全一致**；块级的继续吃 `img-block-center` 的
                //    居中对齐 ⇒ 图片水平不动，标识符只占掉它上面一行（图片只向下让位）。
                const inline = imgIsInline(state, img)
                decos.push(
                  Decoration.widget(
                    // ⚠️ 挂在**构造的末尾**（`img.to`）：标识符文本在图片**左边**（Typora 观感）。
                    //    挂 `img.from` 时无论 side 正负，DOM 里图片都会排在文本前面。
                    img.to,
                    () => {
                      const span = document.createElement('span')
                      span.className = inline ? 'img-widget img-widget--inline' : 'img-widget'
                      span.setAttribute('data-img-widget', '')
                      span.setAttribute('data-img-from', String(img.from))
                      span.setAttribute('data-img-inline', inline ? 'true' : 'false')
                      const im = document.createElement('img')
                      im.src = img.src
                      if (img.alt) im.alt = img.alt
                      if (img.zoom) im.style.zoom = `${img.zoom}%`
                      im.loading = 'lazy'
                      span.appendChild(im)
                      return span
                    },
                    { side: 1 }
                  )
                )
              }
            }
            /**
             * 语法被改坏的"图片源码"（例如退格删掉了结尾 `>`）：它已经不是图片了，
             * 但仍然是正文 —— 只额外关掉拼写检查的波浪线（用户截图里那排红线）。
             */
            state.doc.descendants((node, pos) => {
              if (!node.isText) return true
              const t = node.text ?? ''
              if (!t || isImgSourceText(t)) return true
              if (!/^\s*!?\[?\s*(<img|!\[)/i.test(t)) return true
              decos.push(
                Decoration.inline(pos, pos + node.nodeSize, {
                  class: 'img-src-incomplete',
                  spellcheck: 'false',
                  autocorrect: 'off'
                })
              )
              return true
            })
            return DecorationSet.create(state.doc, decos)
          },
          handleClickOn(_view, _pos, node) {
            if (node.type.name === 'image') return false
            return false
          },
          handleDOMEvents: {
            /**
             * 第六十五轮用户口径：「点击图片**松开鼠标后**才会出现标识符」。
             * 所以按下时**什么都不做**（只记下"这一击落在哪张图上"并阻止浏览器抢光标），
             * 真正的激活（打开 + 需要时"节点 → 原文文本"）挪到 `mouseup` 的**同一事务**里，
             * 于是既满足"松开才出现"，又保持上一轮的"一次单击 = 一次可见状态跃迁"。
             */
            mousedown(view, event) {
              pendingClick = null
              /**
               * 第七十一轮（用户报障：标识符"根本无法编辑和选中"）：**已经显示出来的标识符文本**
               * 必须走原生文本行为（放光标、拖选、输入）。此前这里对"按在图片源码范围内"的按下
               * **一律** `preventDefault` + `return true` ⇒ 标识符文本上的拖选也被吞掉
               * （实测：在标识符内部拖动 ⇒ `from==to`、`empty:true`，选区根本没起来）。
               * 现收窄为：**按在标识符文本上一律放行**（返回 false，交给 PM/浏览器），
               * 其余仍走"坐标 → 落在图片源码范围内 ⇒ 记 pendingClick"的老判据。
               */
              const target = event.target as HTMLElement | null
              if (target?.closest?.('[data-img-revealed]')) return false
              /**
               * 第六十八轮：不再靠 DOM 身份（`nodeDOM(pos) === imgEl` / `posAtDOM`）判断
               * "点到的是不是某张图" —— PM 会重建 DOM，身份比较不稳（上一轮 ⑬b 就是栽在这）。
               * 改成**坐标 → 文档位置 → 落在哪个图片源的范围里**：两种形态（图片节点 / 原文文本）
               * 共用同一条判据，命中才记 `pendingClick`（激活留给 mouseup，一次事务）。
               */
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (!at) return false
              const sources = collectImgSources(view.state)
              const hit = sources.find((s) => at.pos >= s.from - 1 && at.pos <= s.to + 1)
              if (!hit) return false
              pendingClick = { kind: hit.kind, from: hit.from }
              event.preventDefault()
              return true
            },
            mouseup(view, event) {
              const pending = pendingClick
              pendingClick = null
              if (!pending) return false
              const st = view.state
              if (pending.kind === 'raw') {
                const img = collectImgSources(st).find((i) => i.from === pending.from)
                if (!img) return false
                // 松开才"选中"（浅灰底）；光标按在标识符**之前** ⇒ 不会被判成"正在编辑"
                const tr = st.tr
                  .setSelection(TextSelection.create(st.doc, img.from))
                  .setMeta(KEY, { from: img.from, editing: false })
                view.dispatch(tr)
              } else {
                // 节点：同一事务里"转文本 + 落选区 + 打开"
                const node = st.doc.nodeAt(pending.from)
                if (!node || node.type.name !== 'image') return false
                const alt = String(node.attrs.alt ?? '')
                const src = String(node.attrs.src ?? '')
                const mdMark = st.schema.marks.mdHtml
                const text = st.schema.text(
                  alt ? `![${alt}](${src})` : `![](${src})`,
                  mdMark ? [mdMark.create()] : undefined
                )
                const tr = st.tr.replaceWith(pending.from, pending.from + node.nodeSize, text)
                tr.setSelection(TextSelection.create(tr.doc, pending.from))
                tr.setMeta(KEY, { from: pending.from, editing: false })
                view.dispatch(tr)
              }
              event.preventDefault()
              return true
            },
            blur() {
              return false
            },
            keydown(view, event) {
              if (event.key !== 'Escape') return false
              const from = KEY.getState(view.state)?.from ?? null
              if (from == null) return false
              view.dispatch(view.state.tr.setMeta(KEY, { from: null }))
              return true
            }
          }
        },
        view(editorView) {
          /**
           * ─── 第五十九轮：**没有浮层了** ─────────────────────────────────────────
           *
           * 用户原话：「现在这样完全是在图片顶部出了个悬浮窗而已，一点也不实用」。
           * 标识符就是**文档里那段文本本身**（`<img … />` 原文，或由图片节点转成的 `![alt](url)`）：
           *   * 未激活 ⇒ 装饰把它隐藏、在原位画真图（保存逐字节不变）；
           *   * 激活 ⇒ 装饰**不再隐藏**它 ⇒ 它作为正文原位出现、可直接编辑；
           *     语法被改坏 ⇒ 它不再是图片（图片随之消失），但文本仍在正文里。
           * 因此这套插件视图现在只做一件事：**摆缩放工具栏**（锚点 = 图片矩形）。
           */
          const imgRectOf = (img: ImgSource): DOMRect | null => {
            if (img.kind === 'node') {
              const dom = editorView.nodeDOM(img.from) as HTMLElement | null
              return dom && typeof dom.getBoundingClientRect === 'function'
                ? dom.getBoundingClientRect()
                : null
            }
            const w = editorView.dom.querySelector(
              `[data-img-widget][data-img-from="${img.from}"]`
            ) as HTMLElement | null
            if (w) return w.getBoundingClientRect()
            const el = editorView.dom.querySelector('[data-img-revealed]') as HTMLElement | null
            return el ? el.getBoundingClientRect() : null
          }
          /**
           * 工具栏锚点：**标识符文本显形时以它为准**（取整段的 union 矩形 ⇒ 工具栏落在
           * 那段文本的上方，"不遮挡源码"这条老口径在"源码折行 + 图片跟在末尾"时也成立），
           * 否则退回图片自身的矩形。
           */
          const anchorRectOf = (img: ImgSource): DOMRect | null => {
            const el = editorView.dom.querySelector('[data-img-revealed]') as HTMLElement | null
            if (el) return el.getBoundingClientRect()
            return imgRectOf(img)
          }
          /**
           * 把"还不是正文文本"的标识符**归一到行内原文文本**（两条路径产出一致的 DOM）：
           *   * `image` 节点 ⇒ `![alt](src)` 文本（markdown 逐字节不变）；
           *   * `htmlBlock` 原子（独立成行的 `<img …>` 会被 markdown-it 判成 html_block，
           *     DOM 是 `<pre data-md-htmlblock class="md-htmlblock">`，会被 `.md-preview pre`
           *     的**代码块样式**命中 ⇒ 就是用户说的"直接粘贴 `<img>` 的标识符还有旧样式"）
           *     ⇒ 换成一个**段落里的行内文本**（内容仍是那段原文，序列化逐字不变），
           *     这样它才可能与图片同一行、并共用同一组 class/CSS。
           */
          const normalizeToInlineText = (from: number): boolean => {
            const st = editorView.state
            const node = st.doc.nodeAt(from)
            if (!node) return false
            const mdMark = st.schema.marks.mdHtml
            const marks = mdMark ? [mdMark.create()] : undefined
            if (node.type.name === 'image') {
              const alt = String(node.attrs.alt ?? '')
              const src = String(node.attrs.src ?? '')
              const text = st.schema.text(alt ? `![${alt}](${src})` : `![](${src})`, marks)
              const tr = st.tr.replaceWith(from, from + node.nodeSize, text)
              tr.setSelection(
                TextSelection.create(tr.doc, Math.min(from + text.nodeSize, tr.doc.content.size))
              )
              tr.setMeta(KEY, { from, editing: false })
              editorView.dispatch(tr)
              return true
            }
            if (node.type.name === 'htmlBlock') {
              const source = String(node.attrs.source ?? '')
              const para = st.schema.nodes.paragraph.create(null, st.schema.text(source, marks))
              const tr = st.tr.replaceWith(from, from + node.nodeSize, para)
              // 标识符在新段落里的起点 = from + 1（段落边界各占 1）
              tr.setSelection(
                TextSelection.create(
                  tr.doc,
                  Math.min(from + 1 + source.length, tr.doc.content.size)
                )
              )
              tr.setMeta(KEY, { from: from + 1, editing: false })
              editorView.dispatch(tr)
              return true
            }
            return false
          }
          let converting = false
          const sync = (): void => {
            const open = KEY.getState(editorView.state)?.from ?? null
            const openEditingNow = KEY.getState(editorView.state)?.editing === true
            const imgs = collectImgSources(editorView.state)
            const img = open == null ? null : (imgs.find((i) => i.from === open) ?? null)
            if (!img) {
              hideBar()
              editorView.dom.setAttribute('data-img-open', 'null:e')
              return
            }
            // 节点形态（图片节点 / htmlBlock 原子）的标识符在正文里还不存在 ⇒ 这一刻归一成行内文本，
            // 之后它就能像文字一样被点开、被编辑（markdown 不变）。
            const at = editorView.state.doc.nodeAt(img.from)
            if ((img.kind === 'node' || at?.type.name === 'htmlBlock') && !pendingClick) {
              hideBar()
              if (converting) return
              converting = true
              queueMicrotask(() => {
                converting = false
                try {
                  normalizeToInlineText(KEY.getState(editorView.state)?.from ?? img.from)
                } catch {
                  /* 转不过去也不影响编辑 */
                }
              })
              return
            }
            const rect = anchorRectOf(img)
            if (!rect) {
              hideBar()
              return
            }
            const el = ensureBar(editorView)
            placeToolbar(el, rect)
            // 诊断锚（套件用）：把"当前打开谁 + 是否编辑态"写在编辑器根上，
            // 这样即使 PM 重建了 DOM，也能量到**装饰状态本身的序列**（是不是真的来回跳）
            editorView.dom.setAttribute(
              'data-img-open',
              (KEY.getState(editorView.state)?.from ?? 'null') + (openEditingNow ? ':E' : ':e')
            )
            const active = img.zoom ?? 100
            for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-img-zoom]'))) {
              const pct = Number(b.getAttribute('data-img-zoom'))
              b.classList.toggle('is-active', pct === active)
              b.setAttribute('aria-pressed', pct === active ? 'true' : 'false')
              b.title = i18n.global.t('editor.imageZoom', { pct })
            }
          }
          const ro = new ResizeObserver(() => sync())
          ro.observe(editorView.dom)
          const onScroll = (): void => sync()
          editorView.dom.addEventListener('scroll', onScroll, true)
          return {
            update: () => {
              try {
                sync()
              } catch {
                /* 定位失败不该影响编辑：下一次 update 会再算一遍 */
              }
            },
            destroy: () => {
              ro.disconnect()
              editorView.dom.removeEventListener('scroll', onScroll, true)
              hideBar()
            }
          }
        }
      })
    ]
  }
})
