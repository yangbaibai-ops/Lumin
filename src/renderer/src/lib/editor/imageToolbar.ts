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
  if (sel.from >= img.from && sel.to <= img.to) {
    const exactlyFull = !sel.empty && sel.from === img.from && sel.to === img.to
    return exactlyFull ? 'hide' : 'show'
  }
  const contains = !sel.empty && sel.from <= img.from && sel.to >= img.to
  if (contains) return 'hide'
  const cutsIn =
    (sel.from > img.from && sel.from < img.to) || (sel.to > img.from && sel.to < img.to)
  return cutsIn ? 'show' : 'hide'
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

const KEY = new PluginKey<{ from: number | null; editing?: boolean }>('luminImageSource')

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
  const parent = state.doc.resolve(img.from).parent
  let others = 0
  parent.forEach((child) => {
    if (child.type.name === 'image' || child.type.name === 'htmlBlock') return
    if (child.isText) {
      const t = (child.text ?? '').trim()
      if (!t || isRawImgHtml(t)) return
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
      new Plugin<{ from: number | null }>({
        key: KEY,
        state: {
          /** `editing`：点开图片时是"选中态"（浅灰底）；光标落进标识符开始编辑 ⇒ true（无底） */
          init: () => ({ from: null, editing: false }),
          apply(tr, value, _old, next) {
            const meta = tr.getMeta(KEY) as { from: number | null; editing?: boolean } | undefined
            if (meta) return { from: meta.from, editing: !!meta.editing }
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
            const pick =
              keep && revealDecision(selLike, keep) === 'show'
                ? keep
                : (imgs.find((i) => revealDecision(selLike, i) === 'show') ?? null)
            if (!pick) return { from: null, editing: false }
            // 光标**严格落进**标识符文本 ⇒ 正在编辑（底色撤掉；Typora 同观感）
            const caretInside = sel.empty && sel.from > pick.from && sel.from < pick.to
            return { from: pick.from, editing: caretInside }
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
                if (imgs.some((i) => i.kind === 'raw' && i.from === from)) {
                  decos.push(Decoration.node(from, to, { class: 'img-block-center' }))
                }
                return
              }
              const inside = imgs.filter((i) => i.from > from && i.to < to)
              if (inside.length !== 1) return
              let others = 0
              block.forEach((child) => {
                if (child.type.name === 'image' || child.type.name === 'htmlBlock') return
                if (child.isText && !(child.text ?? '').trim()) return
                others += 1
              })
              if (others === 0) decos.push(Decoration.node(from, to, { class: 'img-block-center' }))
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
                    class: openEditing
                      ? 'img-src-revealed img-src-revealed--editing'
                      : 'img-src-revealed',
                    'data-img-revealed': '',
                    'data-img-kind': 'raw',
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
            mousedown(view, event) {
              const target = event.target as HTMLElement | null
              const widget = target?.closest?.('[data-img-widget]') as HTMLElement | null
              if (!widget) return false
              const from = Number(widget.getAttribute('data-img-from'))
              if (!Number.isFinite(from)) return false
              /**
               * 点图片 = "选中这张图"（Typora 的选中态）：只把 `from` 记进插件状态，
               * 给标识符上浅灰底；**不**把光标塞进标识符文本 —— 那样会立刻算成"正在编辑"、
               * 底色一闪就没。用户真正点进文本（光标落进那段）时才转编辑态。
               */
              const img = collectImgSources(view.state).find((i) => i.from === from)
              if (!img) return false
              view.dispatch(view.state.tr.setMeta(KEY, { from: img.from, editing: false }))
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
          /** 图片节点 ⇒ 原文文本（markdown 逐字节不变：`![alt](src)`，只是从节点变成文本） */
          const nodeToText = (from: number): boolean => {
            const st = editorView.state
            const node = st.doc.nodeAt(from)
            if (!node || node.type.name !== 'image') return false
            const alt = String(node.attrs.alt ?? '')
            const src = String(node.attrs.src ?? '')
            const mdMark = st.schema.marks.mdHtml
            const text = st.schema.text(
              alt ? `![${alt}](${src})` : `![](${src})`,
              mdMark ? [mdMark.create()] : undefined
            )
            const tr = st.tr.replaceWith(from, from + node.nodeSize, text)
            tr.setSelection(
              TextSelection.create(tr.doc, Math.min(from + text.nodeSize, tr.doc.content.size))
            )
            tr.setMeta(KEY, { from, editing: false })
            editorView.dispatch(tr)
            return true
          }
          let converting = false
          const sync = (): void => {
            const open = KEY.getState(editorView.state)?.from ?? null
            const imgs = collectImgSources(editorView.state)
            const img = open == null ? null : (imgs.find((i) => i.from === open) ?? null)
            if (!img) {
              hideBar()
              return
            }
            // 节点形态的"标识符"在文档里还不存在（它就是图片节点本身）⇒ 这一刻把它转成原文文本，
            // 之后它就能像文字一样被点开、被编辑（markdown 不变：还是 `![alt](src)`）。
            if (img.kind === 'node') {
              hideBar()
              if (converting) return
              converting = true
              queueMicrotask(() => {
                converting = false
                try {
                  nodeToText(KEY.getState(editorView.state)?.from ?? img.from)
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
