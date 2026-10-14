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
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import i18n from '../../i18n'
// 纯判据（显隐契约 + 登记到期）单独成文件，可被 `tests/imageReveal.test.mjs` 直接钉住
import {
  PENDING_TTL,
  isPendingExpired,
  revealDecision,
  selectionIntersectsSource
} from './imageReveal'
export { revealDecision } from './imageReveal'
export type { RevealSel, RevealRange } from './imageReveal'

/**
 * 「这张图片算被选中」的观感类名 —— **全仓唯一出处**：装饰（`Decoration.node` / widget）与
 * 第一百一十三轮的**拖动期即时绘制**（P1，只画不改）都用它，CSS 也只有一份
 *（`markdown.css` 的 `.md-preview .img-selected`：`--sel` 铺底 + `--accent` 描边）。
 */
const IMG_SELECTED_CLASS = 'img-selected'

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

/**
 * 第八十二轮：这段原文 HTML 是不是**只由 `<img …>` 标签组成**（标签之间允许空白，≥1 个）。
 * 为什么需要它：`<img A /><img B />` 紧邻时，markdown-it 会给出**一个** `htmlBlock`（独立成行）
 * 或**一个**文本节点（行内），PM 还会把相邻同 mark 的文本合并 ⇒ "整段就是一个 `<img …>`"
 * （单标签）的判据**失配**，于是整段只命中 `img-src-incomplete`（只显示源码、不渲染图）。
 * 归一化阶段用它把这种段落认下来（→ 段落 + 原文文本），再由 `collectImgSources`
 * **按标签逐个**产出图片源。
 */
export function isImgOnlyRawHtml(text: string): boolean {
  const t = text.trim()
  if (!t || !/<img\b/i.test(t)) return false
  return t.replace(/<img\b[^>]*\/?>/gi, '').trim() === ''
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
/**
 * ⚠️ 第七十五轮（用户口径）起，判据本体搬到 `imageReveal.ts` 的 `revealDecision`（已 import）；
 * 这里**不再保留第二份** —— 契约见 `docs/image-behavior.md` 第 3 节，单测见
 * `tests/imageReveal.test.mjs`。
 */

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
    if (node.isText) {
      const raw = (node.text ?? '').trim()
      /**
       * 第八十二轮：**多个** `<img …>` 标签挤在同一个文本节点里（PM 把相邻同 mark 的文本合并了）
       * ⇒ 按**标签边界**逐个产出图片源（子范围 = 该标签在文本里的偏移），
       * 于是每个标签各自命中"整段是一个 `<img …>`"的 widget 渲染 ⇒ 两张并排。
       * 文档**一个字节都不动**（不做拆分、不做替换）⇒ 往返逐字节、天然幂等、不进 undo。
       */
      if (isImgOnlyRawHtml(raw)) {
        const re = /<img\b[^>]*\/?>/gi
        let m: RegExpExecArray | null
        while ((m = re.exec(node.text ?? '')) !== null) {
          const parsed = parseImgSourceText(m[0])
          if (!parsed) continue
          out.push({
            kind: 'raw',
            from: pos + m.index,
            to: pos + m.index + m[0].length,
            src: parsed.src,
            alt: parsed.alt,
            zoom: parsed.zoom,
            markdown: m[0]
          })
        }
        return false
      }
      if (isImgSourceText(raw)) {
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
    const mine = childFrom <= img.from && img.to <= childTo
    if (!child.isText) {
      if (!mine) others += 1
      return
    }
    const t = (child.text ?? '').trim()
    if (!t) return
    if (mine) {
      /**
       * 第八十二轮：**同一个文本节点里挤了多个 `<img …>` 标签**（PM 合并了相邻同 mark 文本）
       * ⇒ 对这个节点来说"还有别的图片"就是**别的内容** ⇒ 两张按**行内并排**处理（不再各自居中）。
       * 图片**自己独占**一个节点时不算（第六十二轮的坑：否则节点转文本后会被判成行内混排、
       * 图片从居中变居左，用户看到跳跃）。
       */
      const tags = t.match(/<img\b[^>]*\/?>/gi)
      if (tags && tags.length >= 2) others += 1
      return
    }
    // 别的文本节点：空的/纯空白不算；**别的图片**（单标签或 `![alt](url)`）算"别的内容"
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

/* ─── 第一百零六轮：行内档底色的**逐行片段覆盖层** ────────────────────────────────
 * 用户口径：「点击后出现的背景颜色……**所有属于图片源码区域的**都要有背景颜色（行的全高），
 * 且背景颜色的覆盖区域和**被拖动连续选中文字时的覆盖区域一致**」。
 *
 * 为什么纯 CSS 到不了（第九十一/一百零五轮已实测）：`box-decoration-break: clone` 下同一元素的
 * **所有片段共用一组背景几何** —— 给不了"处于不同行高的两个片段"各自的高度：普通行行盒 32.30px
 * （底色 32.19 ✓ Δ0.11），被图片撑高的行行盒 **143.25px**（底色仍 32.19 ⇒ Δ111.06），
 * 而**原生选区实画**在那一行上画的正是整条行盒（本机逐像素实测 143.25px，与本模块的目标矩形一致）。
 *
 * 几何口径（全部来自测量，**不写死像素、也没有"行高阈值"启发式**）：
 *   * 元素自身 `getClientRects()` = 逐行片段的 **x 范围**（Chromium 对 inline 元素按行片段返回）；
 *   * 该片段的**行盒上下边** = 同一行盒里所有"参与者"（文字节点的 Range 矩形、行内盒、
 *     替换元素 —— **含嵌在行内 span 内部的图片 widget**）按"竖直重叠即同一行"串成的组，
 *     片段自己也作为种子放进组里，再用**片段的竖直中点**挑出它所在的那一组；
 *   * **只要行盒比片段本身高**（>0.5px 亚像素容差）就补画 —— 覆盖层 = 片段的 x 范围 × 行盒的
 *     y 范围。行盒与片段等高（普通行）时不画：那些行的底色已由 `.img-src-revealed` 自身的
 *     `padding-block` 铺满（Δ0.11px，第九十一轮已验收）。
 *   * 上一轮的两处缺陷（用户实测报障的根因）见 `collectRowRects` 的注释：行内 span 内部的
 *     widget 没被采集、以及 KaTeX 相对定位的 strut 会污染行盒。
 *
 * 覆盖层挂在 `view.dom.parentElement` 上（与悬浮工具栏同一做法）⇒ **不在 `view.dom` 里**：
 * ProseMirror 的 DOM 观察者看不到它、不进 Markdown（往返逐字节不变）、不占布局，
 * 且 `pointer-events: none` ⇒ 不挡鼠标。重算时机见 `scheduleOverlay` 的调用点。
 */
const SRC_OVERLAY_CLASS = 'img-src-overlay'
/** "行盒所属的块"：与 `.img-src-revealed` 的排版上下文一致（段落/列表项/引用/单元格…） */
const ROW_BLOCK_SEL = 'p, li, pre, td, th, blockquote, h1, h2, h3, h4, h5, h6'
/** 替换元素：它们的高就是所在行盒的高（图片撑高行的唯一来源） */
const REPLACED_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED'])

interface RectBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 收集一个块里**参与行盒**的矩形（**排除** `exclude` 自己那一棵子树 —— 它由调用方按"片段"补上）。
 *
 * ⚠️ 第一百零七轮修正的两处（上一轮的红根因）：
 *   1. **行内元素必须继续往下走**：图片 widget（`<span class="img-widget">` 或 `img`）会**嵌在**
 *      源码文本的外层 `<span class="md-html">` 里（widget 挂在源码的结束位置 ⇒ PM 把它插进那层
 *      span 内部）。上一轮遇到 `display: inline` 的元素就 `continue`，于是"与片段同一行的图片矩形"
 *      根本没进集合 ⇒ 行盒看起来只有文字高（21px）⇒ **该行不补画**（用户实测：源码与高图同行、
 *      位于行顶，底色却没铺满）。
 *   2. **跳过"视觉排版孤岛"（KaTeX）**：`.pstrut` 之类是 `display: inline-block; width: 0`
 *      但**绘制高 48.64px、且绘制顶边比所在行盒顶边还高 33px** 的盒子（KaTeX 用 vlist 表格 +
 *      相对位移把它们挪出所在行）。算进来会把普通行误判成"被撑高"，甚至把相邻两行**粘成一行**
 *      （实测：行盒 32.30 + 32.30 被粘成 64.79）。它们只影响绘制位置、不影响行盒
 *      ⇒ 只取 `position: static` 的盒子，并且**整个 `.katex` 子树都不参与**
 *      （公式的行盒由外层文字的行距决定）。
 */
function collectRowRects(parent: Node, exclude: Element, out: RectBox[]): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child === exclude) continue
    if (child.nodeType === 3) {
      const tn = child as Text
      if (!tn.length) continue
      const rg = document.createRange()
      rg.setStart(tn, 0)
      rg.setEnd(tn, tn.length)
      for (const r of Array.from(rg.getClientRects())) {
        if (r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
      continue
    }
    if (child.nodeType !== 1) continue
    const el = child as HTMLElement
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    // KaTeX 子树整体跳过（见上面第 2 条）
    if (el.classList.contains('katex')) continue
    // 块级盒子自己的矩形跨多行（会污染行盒）⇒ 只往下走、不采集它；行内盒与替换元素才采集
    const replaced = REPLACED_TAGS.has(el.tagName)
    if ((replaced || cs.display.startsWith('inline')) && cs.position === 'static') {
      for (const r of Array.from(el.getClientRects())) {
        if (r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
    }
    collectRowRects(el, exclude, out)
  }
}

/**
 * 一段行内档标识符**需要在覆盖层上补画**的逐行矩形。
 *
 * 口径（第一百零七轮定稿，**不再用任何"行高阈值"启发式**）：
 *   1. 行盒 = 该块里所有行盒参与者（文字 Range 矩形、行内盒、替换元素，**含嵌在行内 span 内部的
 *      widget**）按"竖直重叠必然属于同一行盒"串成的组；
 *   2. 片段所在的行盒 = **包含片段竖直中点的那一组**（不依赖"高图与片段本身是否重叠"，也**不把
 *      片段自己放进分组** —— 片段因 `vertical-align: top` + 自身 padding 会比行盒顶边高出 0.59px，
 *      放进分组会把上一行与这一行**粘成一行**，实测粘出 287.08px 的怪框）；
 *   3. **只要行盒比片段本身高**（> 0.5px 亚像素容差）就补画：覆盖层矩形 = 片段的 x 范围 ×
 *      行盒的 y 范围（"整行全高"，与浏览器给选区画的高亮同口径）；行盒与片段等高（普通行）时
 *      不画 —— 那些行的底色已由 `.img-src-revealed` 自身的 `padding-block` 铺满（Δ0.11px）。
 * ⚠️ 只处理行内档（`--block` 的盒子本身就是 n × 行盒高，早铺满了）；
 * 编辑态（`--editing`，底色撤掉）由调用方用选择器排除。
 *
 * 返回的每个矩形都带 `frag`（生成它的那个片段矩形）：第一百零八轮要用它把"整行全高"里
 * **源码盒子之外**的那片空白带切出来（点空白带 ⇒ 不收回 + 按列落光标）。
 */
interface RowBox extends RectBox {
  frag: RectBox
}

function revealedRowBoxes(el: HTMLElement): RowBox[] {
  const block = (el.closest(ROW_BLOCK_SEL) as Element | null) ?? el.parentElement
  if (!block) return []
  const frags: RectBox[] = []
  for (const r of Array.from(el.getClientRects())) {
    if (r.width > 0 && r.height > 0)
      frags.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }
  if (!frags.length) return []
  const parts: RectBox[] = []
  collectRowRects(block, el, parts)
  // 行盒分组：按上边排序，与已有组竖直重叠即并入（同一行盒里的盒子必然互相重叠）
  const rows: { top: number; bottom: number }[] = []
  for (const r of parts.sort((a, b) => a.top - b.top)) {
    const hit = rows.find((g) => r.top < g.bottom - 0.5 && r.bottom > g.top + 0.5)
    if (hit) {
      hit.top = Math.min(hit.top, r.top)
      hit.bottom = Math.max(hit.bottom, r.bottom)
    } else {
      rows.push({ top: r.top, bottom: r.bottom })
    }
  }
  const out: RowBox[] = []
  for (const f of frags) {
    const mid = (f.top + f.bottom) / 2
    const row = rows.find((g) => mid >= g.top - 0.5 && mid <= g.bottom + 0.5)
    if (!row || row.bottom - row.top <= f.bottom - f.top + 0.5) continue
    out.push({ left: f.left, top: row.top, right: f.right, bottom: row.bottom, frag: f })
  }
  return out
}

export const ImageSourceUi = Extension.create({
  name: 'luminImageSourceUi',

  addProseMirrorPlugins() {
    let bar: HTMLElement | null = null
    /**
     * 这一次按下的落点（第六十五轮：激活挪到 mouseup，按下时什么都不做）。
     * 第七十三轮：`pendingClick` 会**滞留** —— 若某次按下被拦截却没等到 `mouseup`
     * （失焦、指针离开、`mouseup` 落在编辑器外、被别的逻辑吞掉…），`apply` 的抑制条件
     * 就会一直生效 ⇒ 之后"选区驱动"的显示被忽略（表现为"有时不灵、得再点一次图片"）。
     * 这里补上**到期 + 失焦/隐藏/按键/指针取消 + 下一次按下重置**四条清理，并挂一个
     * 诊断锚 `data-img-pending`（清理后为空串）。
     */
    let pendingClick: {
      kind: 'raw' | 'node'
      from: number
      at: number
      x: number
      y: number
    } | null = null
    let pendingTimer: number | null = null
    let pendingRaf = 0
    let pendingDom: HTMLElement | null = null
    /**
     * 第一百零四轮（**DOM 身份快照**，不碰坐标）：
     *   * `dragActive`：指针是否正按住拖动；
     *   * `dragInsideFrom`：**这次拖动的起点落在哪个源码文本里**（`mousedown` 时用
     *     `event.target.closest('[data-img-revealed]')` 的 `data-img-from`；正文里按下 ⇒ `null`）。
     * 拖动期间判据按它分流：命中该源 ⇒ 一律 show（能把选区拖满整个源码，松手才隐藏）；
     * 其它 ⇒ 一律 hide（第七十五轮防闪口径）。松手后清空 ⇒ 回到既有口径。
     */
    let dragActive = false
    let dragInsideFrom: number | null = null
    const syncPendingAttr = (): void => {
      if (pendingDom)
        pendingDom.setAttribute('data-img-pending', pendingClick ? pendingClick.kind : '')
    }
    const clearPending = (): void => {
      if (pendingTimer != null) {
        window.clearTimeout(pendingTimer)
        pendingTimer = null
      }
      if (pendingRaf) {
        window.cancelAnimationFrame(pendingRaf)
        pendingRaf = 0
      }
      if (pendingClick) {
        pendingClick = null
        syncPendingAttr()
      }
    }
    /**
     * 第七十九/八十一轮：到期清理**双保险** —— 定时器之外再挂一个 rAF 看门狗。
     * 定时器在重负载/被页面挂起时可能迟到，而"登记滞留"会直接导致
     * 「有时不灵、得再点一次图片」⇒ 这里用**帧循环**兜底（每帧只做一次数值比较，极轻）。
     */
    const watchPendingExpiry = (): void => {
      if (!pendingClick) {
        pendingRaf = 0
        return
      }
      if (isPendingExpired(pendingClick.at)) {
        clearPending()
        pendingRaf = 0
        return
      }
      pendingRaf = window.requestAnimationFrame(watchPendingExpiry)
    }
    const setPending = (kind: 'raw' | 'node', from: number, x: number, y: number): void => {
      // 第九十四轮：连**按下坐标**一起记 —— `mouseup` 用它判断"这一击到底是不是拖动"
      pendingClick = { kind, from, at: Date.now(), x, y }
      syncPendingAttr()
      if (pendingTimer != null) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(() => clearPending(), PENDING_TTL)
      if (!pendingRaf) pendingRaf = window.requestAnimationFrame(watchPendingExpiry)
    }
    /** 读 `pendingClick` 并顺带处理"已过期"（无需等到下一次事务） */
    const livePending = (): { kind: 'raw' | 'node'; from: number; x: number; y: number } | null => {
      if (!pendingClick) return null
      if (isPendingExpired(pendingClick.at)) {
        clearPending()
        return null
      }
      return pendingClick
    }

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

    /* ── 覆盖层（第一百零六轮）：见文件里 `SRC_OVERLAY_CLASS` 那段说明 ────────────── */
    let overlay: HTMLElement | null = null
    let overlayRaf: number | null = null
    /** 连续"量不到可补画的行"的次数：用来把"布局过渡的当帧"与"真的不需要画"分开 */
    let overlayMiss = 0

    const ensureOverlay = (view: EditorView): HTMLElement => {
      if (overlay && overlay.isConnected) return overlay
      overlay = document.createElement('div')
      overlay.className = SRC_OVERLAY_CLASS
      overlay.setAttribute('data-img-src-overlay', '')
      overlay.contentEditable = 'false'
      overlay.setAttribute('aria-hidden', 'true')
      const host = view.dom.parentElement ?? document.body
      host.appendChild(overlay)
      return overlay
    }

    /** 没有要补画的行（未显形 / 编辑态 / 全部是正常行）⇒ 覆盖层整个摘掉，DOM 回到"零痕迹" */
    const dropOverlay = (): void => {
      if (overlay) overlay.remove()
      overlay = null
    }

    /** 覆盖层要伺候的元素：行内档 + 非编辑态（编辑态底色撤掉，覆盖层也不该在） */
    const OVERLAY_TARGET_SEL = `.img-src-revealed:not(.img-src-revealed--block):not(.img-src-revealed--editing)`
    /** 有没有需要覆盖层的显形源码（只看 DOM，不做任何测量 ⇒ 可以在事务里同步调用） */
    const hasOverlayTarget = (view: EditorView): boolean =>
      !!view.dom.querySelector(OVERLAY_TARGET_SEL)

    const syncOverlay = (view: EditorView): void => {
      const els = Array.from(view.dom.querySelectorAll<HTMLElement>(OVERLAY_TARGET_SEL))
      if (!els.length) {
        overlayMiss = 0
        dropOverlay()
        return
      }
      const boxes: RowBox[] = []
      for (const el of els) boxes.push(...revealedRowBoxes(el))
      if (!boxes.length) {
        /**
         * 显形/归位的那几帧里，"被撑高的行"可能还量不到（图片尚未挪到那一行）
         * ⇒ **先留着上一帧的覆盖层、下一帧再量**，避免它"画出来→撤掉→又画出来"地闪；
         * 连续若干帧都量不到才真的撤（切到编辑态、或这段源码所在的行本来就都是正常行）。
         * ⚠️ 第一百零九轮：预算由 1 帧放宽到 5 帧 —— 显形后图片回流 + 段落重排可能跨好几帧，
         * 旧预算会在回流没结束时就把层撤掉，而此后若没有别的触发（RO/滚动/resize）就**一直空着**
         * （逐帧实测：偶发 `ovEl=true / ov=0` 且不再恢复）。多量几帧的代价只是几次选择器查询 +
         * 矩形读取；画不出来时终态仍是不画（与旧行为一致）。
         */
        if (overlayMiss++ < 5) scheduleOverlay(view)
        else dropOverlay()
        return
      }
      overlayMiss = 0
      const node = ensureOverlay(view)
      const parent = node.offsetParent as HTMLElement | null
      const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
      const frag = document.createDocumentFragment()
      for (const b of boxes) {
        const d = document.createElement('div')
        d.style.left = `${(b.left - base.left).toFixed(2)}px`
        d.style.top = `${(b.top - base.top).toFixed(2)}px`
        d.style.width = `${Math.max(0, b.right - b.left).toFixed(2)}px`
        d.style.height = `${Math.max(0, b.bottom - b.top).toFixed(2)}px`
        frag.appendChild(d)
      }
      node.replaceChildren(frag)
    }

    /** 重算时机：显形/隐藏、编辑态切换、文档或布局变化、窗口 resize、滚动（逐帧合并一次） */
    const scheduleOverlay = (view: EditorView): void => {
      if (overlayRaf != null) return
      overlayRaf = window.requestAnimationFrame(() => {
        overlayRaf = null
        try {
          syncOverlay(view)
        } catch {
          /* 量不到就不画：下一次 update/RO/resize 会再算一遍 */
        }
      })
    }

    /**
     * ─── 第一百零八轮（用户口径）：整行全高覆盖层里"**源码盒子之外**"的那片空白带 ───────────
     * 用户原话：「源码展示在顶部的源码**下面的区域**（**和图片相同高度但是除了源码以外的空白
     * 区域**）也算作是**图片和图片源码的一部分**，也就是**点击这里图片不收回**，并且**可以通过
     * 点击下方的空白区域将光标放置在同一列上面的源码处**（**和浏览器输入框的逻辑一致**）」。
     *
     * 判据（几何全部来自测量，不新增样式、不参与命中测试）：
     *   * 带 = 覆盖层矩形（片段 x 范围 × 行盒 y 范围）**减去片段自己的盒子** —— 源码字形/内边距
     *     所在区域一律**放行给既有路径**（拖动选择、点字落光标都不受影响）；
     *   * 覆盖层仍是 `pointer-events: none`（`elementFromPoint` 永远拿不到它）⇒ 这里只是**按几何**
     *     判定，不给覆盖层任何命中能力。
     */
    /**
     * 指针是否落在**任何可见文字的字形盒**里（±1px）。点字形一律交回原生：正文、源码都一样。
     * 第一百二十四轮新增：把"行盒空白带"的判据从"片段盒之外"扩到"**整行行盒减去所有字形盒**"
     * 时，必须先把"压在别的文字上"的点排掉，否则会抢走正文的点击。
     */
    const pointOnGlyphs = (block: Element, x: number, y: number): boolean => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let n: Node | null
      while ((n = walker.nextNode())) {
        const t = n as Text
        if (!t.length) continue
        const r = document.createRange()
        r.selectNodeContents(t)
        for (const c of Array.from(r.getClientRects())) {
          if (c.width <= 0.5 && c.height <= 0.5) continue
          if (x >= c.left - 1 && x <= c.right + 1 && y >= c.top - 1 && y <= c.bottom + 1)
            return true
        }
      }
      return false
    }

    const bandAt = (
      view: EditorView,
      x: number,
      y: number
    ): { el: HTMLElement; frag: RectBox } | null => {
      const els = view.dom.querySelectorAll<HTMLElement>(
        '.img-src-revealed:not(.img-src-revealed--block)'
      )
      for (const el of Array.from(els)) {
        // 只处理"裸 `<img …>` 原文"这一档（节点档点开时会先归一成原文，口径统一）
        if (el.getAttribute('data-img-kind') !== 'raw') continue
        const block = (el.closest(ROW_BLOCK_SEL) as HTMLElement | null) ?? el.parentElement
        if (!block) continue
        /**
         * ⚠️ 第一百二十四轮（用户复报：「**在图片源码上**按下并拖动选中文字时，**会选中上面的文字**」）
         * 真因：`revealedRowBoxes` 给的行盒矩形 **x 范围 = 片段自己的 x**（`left/right: f.left/f.right`），
         * 于是"源码字形左边/右边那一段空白"**不在带里** ⇒ `bandAt` 返回 null ⇒ 按下走**原生**
         * `posAtCoords`，而在"被图片撑高的那一行"里，那个 x 上最近的文字往往是**同一行的正文**
         * （实测：按 (342,370) ⇒ 锚点落到正文 `行内公式E=mc²…` 的 119，拖动后模型选区 119-135
         * 正是用户截图里被选中的那行）⇒ 视觉上"选中了上面的文字"。
         * 现在：行盒的 **x 范围取"块的内容盒 ∪ 片段盒"**（用户第一百零八轮口径：整行全高覆盖层里的
         * 空白带都算这一段源码），并用 `pointOnGlyphs` 把"压在任意字形上"的点排掉 ⇒ 点正文/点字形
         * 行为完全不变，只有**真空白**才走按列映射（并 clamp 到该段源码范围）。
         */
        const br = block.getBoundingClientRect()
        for (const b of revealedRowBoxes(el)) {
          const left = Math.min(b.frag.left, br.left)
          const right = Math.max(b.frag.right, br.right)
          if (x < left || x > right || y < b.top || y > b.bottom) continue
          if (pointOnGlyphs(block, x, y)) return null
          return { el, frag: b.frag }
        }
      }
      return null
    }

    /**
     * 「点在**这一段的可见源码区域**上吗」—— 区域 = 覆盖层**行盒**（含空白带）∪ 源码**片段行盒**
     * （字形盒连同上下 padding）。返回该段源码的 `from`，都不命中 ⇒ `null`。
     *
     * ⚠️ 第一百一十二轮：这是"按在这一段上"的**唯一判据**（`onDragDown` 用它给 `dragInsideFrom`
     * 兜底）。此前只有 `bandAt`（行盒 − 片段盒），于是**片段行盒自己的 padding 那几像素**
     * 两边都不算 ⇒ `dragInsideFrom == null` ⇒ 按住期间被防闪口径藏掉一帧再显示
     *（逐帧实测的交界处回摆 #1 帧）。
     */
    const revealedSourceFromAtPoint = (view: EditorView, x: number, y: number): number | null => {
      const els = view.dom.querySelectorAll<HTMLElement>(
        '.img-src-revealed:not(.img-src-revealed--block)'
      )
      for (const el of Array.from(els)) {
        if (el.getAttribute('data-img-kind') !== 'raw') continue
        const from = Number(el.getAttribute('data-img-from'))
        if (!Number.isFinite(from)) continue
        // ① 源码自己的片段行盒（字形 + 行盒 padding）
        for (const r of Array.from(el.getClientRects())) {
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return from
        }
        // ② 该段的覆盖层行盒（空白带所在的整行）
        for (const b of revealedRowBoxes(el)) {
          if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return from
        }
      }
      return null
    }

    /**
     * 按列求文档位置：用浏览器自己的"点 → 光标"映射（`caretRangeFromPoint`）在**该片段的字形行**
     * 上取同一 x 的位置 —— 与"直接点同行字形"完全同一条映射；取不到时退回 `posAtCoords`。
     * 最后 **clamp 到该段源码范围**（左侧越界 ⇒ 片段/源码起点，右侧越界 ⇒ 终点）。
     */
    const caretByColumn = (
      view: EditorView,
      el: HTMLElement,
      frag: RectBox,
      x: number
    ): number | null => {
      const from = Number(el.getAttribute('data-img-from'))
      const img = Number.isFinite(from)
        ? collectImgSources(view.state).find((i) => i.from === from)
        : null
      if (!img) return null
      const midY = (frag.top + frag.bottom) / 2
      let pos: number | null = null
      try {
        const d = document as Document & {
          caretRangeFromPoint?: (px: number, py: number) => Range | null
          caretPositionFromPoint?: (
            px: number,
            py: number
          ) => { offsetNode: Node; offset: number } | null
        }
        const r = d.caretRangeFromPoint?.(x, midY)
        if (r && view.dom.contains(r.startContainer))
          pos = view.posAtDOM(r.startContainer, r.startOffset)
        if (pos == null) {
          const cp = d.caretPositionFromPoint?.(x, midY)
          if (cp && view.dom.contains(cp.offsetNode)) pos = view.posAtDOM(cp.offsetNode, cp.offset)
        }
      } catch {
        pos = null
      }
      if (pos == null) {
        const at = view.posAtCoords({ left: x, top: midY })
        pos = at ? at.pos : null
      }
      if (pos == null) return null
      return Math.min(Math.max(pos, img.from), img.to)
    }

    /**
     * ─── 第一百一十轮（用户口径）：**从空白带按下并拖动 = 在同一列源码字形上按下并拖动** ────────
     * 用户原话：「优化下，**点击源码的空白区域拖动也可以选择文字**，使其**和直接点击在同一列
     * 源码上拖动是一样的效果**」。
     *
     * 做法（同一套映射，不另造第二套）：
     *   * **按下**（带内）⇒ 锚点 = `caretByColumn(该行片段)`（与"单击落光标"同一个函数），
     *     并先把光标落在锚点上（单击=空光标的口径不变）；
     *   * **拖动**⇒ 当前点：指针仍在**空白带**里 ⇒ 同一按列映射（自动 clamp 到该行片段）；
     *     指针落到**文字/字形或别处** ⇒ 交回**原生**映射（`posAtCoords`，与 PM 自己的拖选同一条）；
     *     选区 = `[min(锚点, 当前), max(锚点, 当前)]`；
     *   * **松手**⇒ 只清掉拖动状态（选区原样保留），不加第二套落定/复验。
     * ⚠️ 只在"空白带按下"这一条路上生效：**在字形上按下**照旧放行给原生拖选（`bandAt` 对片段
     * 盒子内的点返回 null）。
     */
    let bandDrag: { el: HTMLElement; anchor: number } | null = null

    /** 指针处的"当前点"：带内按列映射、带外原生映射（都不新增第二套坐标逻辑） */
    const bandDragPosAt = (view: EditorView, x: number, y: number): number | null => {
      const band = bandAt(view, x, y)
      if (band) return caretByColumn(view, band.el, band.frag, x)
      const at = view.posAtCoords({ left: x, top: y })
      return at ? at.pos : null
    }

    const bandDragMove = (view: EditorView, x: number, y: number): void => {
      if (!bandDrag) return
      const cur = bandDragPosAt(view, x, y)
      if (cur == null) return
      const from = Math.min(bandDrag.anchor, cur)
      const to = Math.max(bandDrag.anchor, cur)
      const sel = view.state.selection
      if (sel.from === from && sel.to === to) return
      try {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
      } catch {
        /* 位置非法（文档刚变）⇒ 下一次移动再试 */
      }
    }

    /**
     * ─── 第一百一十一轮（用户报障）：**图片实体**后面往左拖，选不中 ──────────────────────────
     * 用户原话：「还是**无法在显示的图片后面从后往前去连续选中文字**，我指的图片是**图片的实体**，
     * **不是图片的源码**」。
     *
     * 真因（本轮实测复现，与已撤回的 `da310f2` 同一根因）：原文形式的图片是
     * 「`contenteditable=false` 的**实体 widget 盒子** + `display:none` 的**源码文本**」两件东西
     * 叠出来的 ⇒ **整个 215px 盒子对指针是死区**：`posAtCoords` 在盒内任意 x 上恒返回同一位置
     * （实测 613/665/718/772/824 → **恒 254**）。于是"在图片后面按下往左拖"时原生锚点立不住
     * （逐帧 `2-2-E`，一帧选区都建不起来），与公式死区是同一条。
     *
     * 做法（照抄当时已验证的骨架，只把命中集合换成图片这一条线；**不新装监听**）：
     *   * **拖动期一个字节都不落**（拖动中 dispatch 会打断 Chromium 的原生手势 ⇒ 反向拖动被冻死）；
     *   * **`mouseup` 后一帧**按"指针压在盒子哪一半"把 focus 定到**近端/远端**
     *     （行内图看 x 轴、块级图看 y 轴 —— 与公式那条口径一致）；
     *   * PM 的 `DOMObserver.flushSoon`（~20ms 定时器）会把原生选区读回来 ⇒ 落定后**有界复验**
     *     （6 帧，达标即停）；
     *   * 只在**指针确实落在图片盒上**、或**原生锚点确实被死区吃掉**（拖动第一帧选区就是空的）时
     *     才介入；其余（正常文字拖选、拖到盒外松手）一个字节都不碰。
     */
    let boxDrag: {
      /** 按下点的文档位置（坐标现算）：原生锚点被死区吃掉时的**兜底锚点** */
      pressPos: number | null
      anchor: number | null
      focus: number | null
      anchorLost: boolean
      /** 最近一次"试探区间"的**两端**（也就是**画面上那一份**；落定按它对齐，见 `onBandUp`） */
      lastLiveNear: number | null
      lastLiveFar: number | null
      /** 高水位：远端达到过的最远文档位置（只增不减，除非指针真的反向 ≥4px，见 `TAIL_BACK_PX`） */
      hw: number | null
      /** 设置 hw 时的指针"轴向距离"（px） */
      hwPx: number
      /** 按下点屏幕坐标：高水位护栏用它判断"是否真的往回走" */
      press: { x: number; y: number } | null
    } | null = null
    let boxSettleRaf: number | null = null
    /** 本次落定**连续被推翻**的次数（第一百一十六轮：按连续失败计数，成功即归零并收工） */
    let boxSettleFails = 0
    let boxSettleTarget: { from: number; to: number } | null = null
    /**
     * 复验上限 = **连续被推翻**的最大次数（第一百一十六轮收口：不再按固定 40 帧空转）。
     * 6 次的理由：PM `flushSoon` ≈20ms 一次读回，连续 6 次（≈100ms）足以骑过实测的读回串；
     * 一落定成功就立刻停 ⇒ "松手后仍在写 DOM"的窗口从 ~650ms 缩到通常 1–2 帧。
     */
    const BOX_SETTLE_MAX_FAILS = 6
    /**
     * 落定**成功之后**的看门狗帧数（第一百二十六轮）：PM 的 `DOMObserver` 会在我们落定成功之后
     * 把**过期的 DOM 选区**读回来、把整段选购吞掉（逐帧实测：目标 `360-753` → 下一帧模型 `360-360E`）。
     * 12 帧（≈200ms）足以骑过那串读回，同时仍是**有界**的；用户一有 `mousedown/keydown` 立刻收手。
     */
    const BOX_SETTLE_WATCH = 0
    /** 看门狗已跑过的帧数 */
    let boxSettleWatch = 0

    /** 图片实体盒 → 它的源码区间（纯映射：认 `data-img-from` + `collectImgSources`，不比较 DOM 身份） */
    const imgRangeOfWidget = (
      view: EditorView,
      widget: HTMLElement
    ): { from: number; to: number } | null => {
      const raw = widget.getAttribute('data-img-from')
      if (raw == null || raw === '') return null
      const from = Number(raw)
      if (!Number.isFinite(from)) return null
      const img = collectImgSources(view.state).find((i) => i.from === from && i.kind === 'raw')
      return img ? { from: img.from, to: img.to } : null
    }

    /**
     * ─── 第一百二十七轮（用户报障 2：「按下拖动但内容却没有被选中的样式，抬起才有」）────────────
     * **`posAtCoords` 死区**：指针压在某个**原子构件的盒子**上时，`posAtCoords` 在整个盒子内
     * **恒返回同一个位置** ⇒ 原生锚点立不住、原生选区一帧都建不起来，而拖动期 `data-sel-own='all'`
     * 已经把浏览器那份绘制关掉了 ⇒ **整段拖动期一点样式都没有，松手落定才回来**（正是用户那句话）。
     *
     * 逐点实测（本轮 `tmp/ls-dead.js`，块级公式 `div.md-math-block` 盒 x∈[320,1362]、y∈[192.8,245.5]）：
     *   `posAtCoords` 在 x = 320/494/667/841/1015/1188/1362 上**恒为 61**；
     *   在 y = 193/206/219/232/245 上恒为 60/61 —— 与图片实体盒（第一百一十一轮实测"恒 254"）同一条。
     *
     * 做法（沿用图片那条已验证的骨架，**不新装监听**）：指针压在原子盒上时，用**盒的哪一半**把
     * focus 定到**近端/远端**；盒内一律不落子（拖动期零 dispatch），由绘制接管、松手后 `boxDragSettle`
     * 落定 ⇒ "拖动中"与"松手后"是**同一个区间**。
     *
     * 轴的选择按**盒子的形状**（与图片那条同一条判据，零硬编码尺寸）：
     *   * 宽 > 高（行内图、行内公式）：看水平半区；
     *   * 高 ≥ 宽（独占一行的块级图、块级 display 公式）：看垂直半区
     *     —— 块级公式盒是**整行宽**，按水平半区取的话"从公式里往下拖"永远停在近端（实测卡在 61）。
     */
    /**
     * 原子盒的**两端**（+ 命中的盒子）：`near` = 盒的近端（左上那半）、`far` = 远端。
     * 两端一起返回，由调用方按**锚点在哪一端**决定 focus（见 `atomFocusAt`）。
     */
    type AtomEnds = { near: number; far: number; box: HTMLElement }

    const atomEndsAtPoint = (view: EditorView, x: number, y: number): AtomEnds | null => {
      const at = document.elementFromPoint(x, y) as HTMLElement | null
      let range: { from: number; to: number } | null = null
      let box: HTMLElement | null = null
      const widget =
        at && typeof at.closest === 'function' ? at.closest<HTMLElement>('[data-img-widget]') : null
      if (widget) {
        range = imgRangeOfWidget(view, widget)
        box = widget
      } else {
        /**
         * 公式：块级是 `div.md-math-block`（NodeView），行内是 `span.md-math-rendered`（widget）。
         * 结构性判据（不用正则、不硬编码）：**块级盒里必然含行内渲染盒**，行内盒则不在任何块级盒里。
         */
        const hit =
          at && typeof at.closest === 'function'
            ? at.closest<HTMLElement>('[data-md-math-block],[data-md-math-rendered]')
            : null
        if (hit) {
          /** 两者都取**外层那个**当命中盒 */
          const blk = hit.closest<HTMLElement>('[data-md-math-block]')
          const target = blk ?? hit
          const r = widgetRange(view, target)
          if (r) {
            range = { from: r.s, to: r.e }
            box = target
          }
        }
      }
      if (!range || !box) return null
      const r = box.getBoundingClientRect()
      if (!(r.width > 0.5 && r.height > 0.5)) return null
      return { near: range.from, far: range.to, box }
    }

    /**
     * 死区命中的**几何兜底**：`document.elementFromPoint` 只看得见**最上面那一层**，被任何浮层
     * （工具栏/浮条/提示卡）压住时就返回 null ⇒ 死区解析会整个失效（本轮实测就是这么踩到的：
     * 一个残留的模态把 `elementFromPoint` 全吃掉，块级公式盒里的死区一句都没解析出来）。
     * 这里按**构件自己的矩形**做命中测试（纯几何），只在 `atomEdgeAtPoint` 没命中时才走
     * ⇒ 正常路径零额外开销。
     */
    const atomEndsAtBox = (view: EditorView, x: number, y: number): AtomEnds | null => {
      for (const w of Array.from(
        view.dom.querySelectorAll<HTMLElement>('[data-img-widget],[data-md-math-block]')
      )) {
        const r = w.getBoundingClientRect()
        if (!(r.width > 0.5 && r.height > 0.5)) continue
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
        const blk = w.closest<HTMLElement>('[data-md-math-block]')
        const target = blk ?? w
        const range = widgetRange(view, target)
        if (!range) return null
        return { near: range.s, far: range.e, box: target }
      }
      return null
    }

    /**
     * 死区里这一帧的 focus 取哪一端（`anchor` = 本次拖动的锚点）。
     *
     * ⚠️ **只在指针确实落在某个原子盒内时**才给答案（`null` = 指针在盒外 ⇒ 一律交回原生映射）。
     * 为什么必须这么收窄（本轮实测的第二个坑）：先前是"每帧都用 `elementFromPoint` 解一次"，
     * 指针**离开盒子之后**它仍然命中盒子（块级公式盒整行宽、图片实体盒 215px 高）⇒ focus 被
     * **钉在盒子的远端**，原生光标明明已经推进到后面的正文，`boxDragRange` 却取不到
     * ⇒ 试探区间恒为 `[60,61]`、**整段拖动一个像素都不长**（逐帧实测 P1）。
     *
     * 取哪一端：
     *   * 锚点**不在**这个原子区间里（`anchor < near || anchor > far`）⇒ 取**盒内取半**那一端
     *     （鼠标从外侧压上来，自然想压到靠近自己的那一端）；
     *   * 锚点**已经在这个原子区间里**（在块级公式里按下、或在图片实体上按下）⇒ 取**另一半**
     *     —— 否则"盒内取半"恒返回近端、而锚点就在近端 ⇒ 试探区间恒为 `[a,a]`。
     * 轴向按**盒子的形状**（零硬编码尺寸）：
     *   * 宽 > 高（行内图、行内公式）：看水平半区；
     *   * 高 ≥ 宽（独占一行的块级图、块级 display 公式）：看垂直半区
     *     —— 块级公式盒是**整行宽**，按水平半区取的话"从公式里往下拖"永远停在近端。
     */
    const atomFocusAt = (
      view: EditorView,
      x: number,
      y: number,
      anchor: number | null
    ): number | null => {
      const ends = atomEndsAtPoint(view, x, y) ?? atomEndsAtBox(view, x, y)
      if (!ends) return null
      const r = ends.box.getBoundingClientRect()
      /** 盒外一律不介入（见上面那段"第二个坑"） */
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
      const frac = r.width > r.height ? (x - r.left) / r.width : (y - r.top) / r.height
      const side = frac < 0.5 ? ends.near : ends.far
      const inside = anchor != null && anchor >= ends.near && anchor <= ends.far
      if (inside) return side === ends.near ? ends.far : ends.near
      return side
    }

    /**
     * 落定 + **有界复验**（松手后一帧落下，之后每帧只看"是否被读回改掉"）。
     *
     * ⚠️ 第一百一十五轮（真因二）：上限由 **6 帧放宽到 40 帧（≈650ms）**。理由：PM 的
     * `DOMObserver.flushSoon` 是 ~20ms 定时器、且"读回原生选区 → `selectionToDOM`"会**连续**
     * 推翻我落的选区（实测 F 手势 6 帧全被推翻 ⇒ 终态空选区、临时高亮还留在屏幕上）。
     * 40 帧足以骑过一整串读回，同时仍是**有界**的（不会长期改写用户后续操作）。
     * 兜底（无论成功/失败都必走）：
     *   ① 临时绘制**一律清掉**（绝不泄漏到松手之后）；
     *   ② 选区**不得为空** —— 若复验用尽仍不是目标区间，最后再**同步**补一次 dispatch
     *      （`data-img-settle-fallback` 记 1，供套件断言到底走了哪条路）。
     */
    /**
     * 落定 + **有界复验**（松手后一帧落下；之后只在"被读回推翻"时补写）。
     *
     * ⚠️ 第一百一十六轮（收口）：计数**不再按固定帧数**，改成按**连续被推翻次数**
     * （`BOX_SETTLE_MAX_FAILS = 6`，连续 6 次不成立即走兜底）。理由：PM 的 `DOMObserver.flushSoon`
     * 是 ~20ms 定时器，"读回原生选区 → `selectionToDOM`"会**连续**推翻落定；按"连续失败"计数后，
     * **一落定成功就立刻停**（不再空转 40 帧），于是"鼠标松开后仍在写 DOM"的窗口从 ~650ms
     * 缩到"真正需要补写的那些帧"（通常 1–2 帧，最坏 6 帧 ≈100ms）。
     * 兜底（无论成功/失败都必走）：
     *   ① 临时绘制**一律清掉**（绝不泄漏到松手之后）；
     *   ② 选区**不得为空** —— 补写用尽仍不成立时再**同步**落一次，
     *      `data-img-settle-fallback` 记 `late|fail`，供套件断言走了哪条路。
     */
    const boxDragSettle = (view: EditorView): void => {
      /**
       * ⚠️ 上一次落定/看门狗可能还挂着一帧 rAF（用户已经按了新的 mousedown ⇒ `cancelWatch` 只清了
       * `boxSettleTarget`、没清 rAF）—— 旧代码在这里直接 `return`，于是**新的一次落定根本没落**，
       * 选区就停在 DOMObserver 读回来的塌缩值上（逐帧实测：上行跨表格 `target360-753` 全丢）。
       * 现在改成：新落定接管旧 rAF。
       */
      if (boxSettleRaf != null) {
        try {
          window.cancelAnimationFrame(boxSettleRaf)
        } catch {
          /* 忽略 */
        }
        boxSettleRaf = null
      }
      /**
       * 第一百二十六轮（用户报障：跨表格/公式/图片拖动，**松手后丢一部分**）：
       * 落定**成功之后不能立刻收工**。逐帧实测（诊断锚 `data-img-settle-in`）：
       * 上行跨表格拖动 `target360-753` 落定成功，**其后** PM 的 `DOMObserver` 把**过期的 DOM 选区**
       * （上行拖动时它常常还塌缩在起点）读回来 ⇒ 模型变成 `360-360E`，整段选购被吞掉 ——
       * 而我们的复验在"首次成功那一帧"就停了（旧行为）。
       * 现在：成功后再**有界**看 `BOX_SETTLE_WATCH` 帧，**只在选区被改小/改没时**补写；
       * 用户一旦有新的 `mousedown/keydown`（新动作）立刻收手，绝不与用户争。
       */
      const stopWatch = (): void => {
        window.removeEventListener('mousedown', cancelWatch, true)
        window.removeEventListener('keydown', cancelWatch, true)
      }
      const cancelWatch = (): void => {
        boxSettleTarget = null
        if (boxSettleRaf != null) {
          try {
            window.cancelAnimationFrame(boxSettleRaf)
          } catch {
            /* 忽略 */
          }
          boxSettleRaf = null
        }
        boxSettleWatch = 0
        boxSettleFails = 0
        stopWatch()
      }
      /**
       * 落定用的 `TextSelection`：**先按原样建**，只有在 PM 把端点修掉（或干脆抛）时才吸附。
       *
       * ⚠️ 第一百二十七轮（实测踩到）：试探区间 / 原生 DOM 区间的端点可能落在**原子节点内部**
       * （例如块级公式 `$$…$$` 那一行、或表格边界），直接 `TextSelection.create` 会触发
       * PM 的 `TextSelection endpoint not pointing into a node with inline content` 并**把选区
       * 悄悄修掉**（实测 `tmp/ls-suite-block.js`：live `120-188` 落定成了 `188-188E` ⇒ 差集 68）。
       *
       * 吸附必须**拿着已经落成的 `from` 去找 `to`**，否则 `findFrom` 会跑出这个小段、落到外层
       * 容器上，把区间**反向塌缩**（实测 `166-240` 被吸成 `166-166` ⇒ 落定成 `240-240E`）。
       * 两次都按"往区间内收"的方向找：`from` 用 `+1`（往后）、`to` 用 `-1`（往前）。
       */
      const textSelAt = (
        doc: EditorView['state']['doc'],
        a: number,
        b: number
      ): TextSelection | null => {
        const size = doc.content.size
        const clamp = (p: number): number => Math.max(0, Math.min(size, p))
        let raw: TextSelection | null = null
        try {
          raw = TextSelection.create(doc, clamp(a), clamp(b))
        } catch {
          raw = null
        }
        /** 原样就成立（误差 ≤2 位、且非空）⇒ 一点都不动它：吸附越少越好 */
        if (raw && raw.to > raw.from && Math.abs(raw.from - a) <= 2 && Math.abs(raw.to - b) <= 2)
          return raw
        const sp =
          Selection.findFrom(doc.resolve(clamp(a)), 1) ??
          Selection.findFrom(doc.resolve(clamp(a)), -1)
        if (!sp) return raw
        const anchor = Math.max(sp.to, clamp(b))
        const ep =
          Selection.findFrom(doc.resolve(anchor), -1) ?? Selection.findFrom(doc.resolve(anchor), 1)
        if (!ep) return raw
        const s = Math.min(sp.from, ep.from)
        const e = Math.max(sp.to, ep.to)
        if (!(e > s)) return raw
        try {
          return TextSelection.create(doc, s, e)
        } catch {
          return raw
        }
      }
      /**
       * 落定一次：返回**实际落成的区间**（失败给 `null`）。
       * ⚠️ 返回"实际值"而不是布尔（第一百二十七轮）：两端要**吸附**到合法文本位置（见 `textSelAt`），
       * 吸附后可能与目标差 1~2 位；再拿"和目标逐位相等"当成功判据，就会把**已经落成功**的一次
       * 判成失败 ⇒ 连续 6 次"推翻"后走兜底、而兜底又是同一个吸附 ⇒ 白转一圈。
       */
      const setTo = (t: { from: number; to: number }): { from: number; to: number } | null => {
        const sel = view.state.selection
        if (sel.from === t.from && sel.to === t.to) return { from: sel.from, to: sel.to }
        const next = textSelAt(view.state.doc, t.from, t.to)
        if (!next) return null
        try {
          view.dispatch(view.state.tr.setSelection(next))
        } catch {
          return null
        }
        const now = view.state.selection
        return { from: now.from, to: now.to }
      }
      const tryOnce = (): void => {
        boxSettleRaf = null
        const t = boxSettleTarget
        if (!t) {
          stopWatch()
          return
        }
        const got = setTo(t)
        /** 容差 ±2：吸附只允许"往区间内收"，1~2 位内视为落成（第 1 步口径里"松手点并入"也是 ≤2 位） */
        const ok =
          !!got &&
          got.from >= t.from - 2 &&
          got.from <= t.from + 2 &&
          got.to >= t.to - 2 &&
          got.to <= t.to + 2
        if (ok) {
          /**
           * 第一百一十三/一十六轮：落定 dispatch **之后**才撤临时绘制（顺序反了会闪一帧空白）。
           * ⚠️ **首次成功那一帧就清**（旧判据 `boxSettleLeft <= TRIES-1` 恒假、要拖到第二帧）
           * —— 之后不再有任何补写，窗口到此为止。
           */
          window.requestAnimationFrame(() => clearLiveSel(view))
          view.dom.setAttribute('data-img-settle-fallback', 'ok')
          if (boxSettleWatch++ < BOX_SETTLE_WATCH) {
            boxSettleRaf = window.requestAnimationFrame(tryOnce)
            return
          }
          cancelWatch()
          return
        }
        if (++boxSettleFails < BOX_SETTLE_MAX_FAILS) {
          boxSettleRaf = window.requestAnimationFrame(tryOnce)
          return
        }
        // 连续被推翻到上限：兜底 —— 再同步落一次；无论成败都清掉临时绘制，绝不留泄漏
        const finalOk = setTo(t) != null
        view.dom.setAttribute('data-img-settle-fallback', finalOk ? 'late' : 'fail')
        clearLiveSel(view)
        cancelWatch()
      }
      boxSettleWatch = 0
      window.addEventListener('mousedown', cancelWatch, true)
      window.addEventListener('keydown', cancelWatch, true)
      boxSettleRaf = window.requestAnimationFrame(tryOnce)
    }

    /**
     * ─── 第一百一十三轮（拖动期即时观感）＋第一百二十一轮（用户两条口径）：**行盒选中带** ───────
     *
     * 用户两条口径（原话）：
     *   ①「当这一行内有行级公式的话，请把这一行的行级公式的选中样式做成和同一行内其他正文被选中时
     *      **同高度且连续不间断**的样式」；
     *   ②「把**所有元素（正文、图片、公式）**更改成**被选中且鼠标未松开前**和**选中且鼠标松开后**
     *      的选中样式**一致**（按照在**松开鼠标后的样式**做）」。
     *
     * 逐像素实测（`tmp/native-geom2.js` + `tmp/shots-121`，亮色主题、夹具 SHA256 见轮次报告）：
     *   * 浏览器对**正文片段**画的是**行盒**：纯文字行 `32.3px`、被图片撑高的行 `143.25px` ——
     *     与"该行所有内联内容盒的并集"（文字盒按 CSS 半行距模型上下补 `(usedLineHeight−盒高)/2`、
     *     再并上 inline-block/替换盒）逐项 **Δ ≤ 0.3px** ⇒ 行盒**可以自己算出来**；
     *   * 对**行内公式**画的是 KaTeX 内层 inline-block 的盒子 ⇒ 同一行里正文 `143.25px`（或 `32.3px`）
     *     而公式段只有 **15px**、还按字形断开（实测公式列 `t131..b145`、正文列 `t72..b214`）
     *     ⇒ 这**正是**用户第①条。
     *
     * 做法（**只画不改**，拖动期依然零 dispatch —— dispatch 会打断 Chromium 原生手势）：
     *   * **行盒选中带**：`div.sel-band` 下每行一条绝对定位矩形（该行**行盒高** × 被覆盖的 x 范围），
     *     一行一条、同行相邻段并成一条 ⇒ 公式段与正文段**同 top/bottom/height 且无缝**；颜色只用
     *     既有令牌 `--sel`（零硬编码）；容器与 `.img-src-overlay` 同一套定位/层级（落在正文与
     *     原生选区**之下**）；
     *   * **闸门 `data-sel-own`**：**只有这一帧确实画出来了**才置位（`setSelOwn(view, mode)`）——
     *     `math` = 落定态**只接管行内公式那几段**（其余内容照旧由浏览器自己画 ⇒ 回归面最小）；
     *     `all`  = 拖动期整层由我们独占（浏览器那份关掉），于是"拖动中"与"松手后"是**同一份几何**
     *     （用户第②条按构造成立）；画不出来（位置/DOM 不合法、片段超上限、闸门没置位）就**撤层撤闸**
     *     ⇒ 退回浏览器绘制 ⇒ **绝不出现"没有选中样式"**；
     *   * **图片**：沿用既有的 `img-selected`（拖动期与落定态**同一套类与 CSS**，不新增类名）；
     *   * **兜底高亮**：每帧拿**渲染后**的带矩形（`getBoundingClientRect` 回读）与"选区文字盒"比对，
     *     凡未被盖住的片段再补进 CSS Highlight（名字 `lumin-img-drag` 不变、同色 `--sel` ⇒ 不叠深）
     *     ⇒ "不漏画"有逐帧自证（`data-sel-band-miss`；探针再独立比对一份，见 `tmp/selstyle-122.js`）；
     *   * **清理**：落定 dispatch 之后 / 空选区 / 卸载 一律清干净；清 `img-selected` 时只摘
     *     **当前状态并未选中**的那些（避免把装饰自己加的类摘掉）。
     */
    const LIVE_SEL_HIGHLIGHT = 'lumin-img-drag'
    const SEL_BAND_CLASS = 'sel-band'
    const SEL_OWN_ATTR = 'data-sel-own'
    /**
     * 第一百二十五轮：被"不透明底色"盖住、因而**必须交回原生选区绘制**的那些元素
     * （表格 `thead/th`、显形源码 `.img-src-revealed`…）。只在这个属性上重新打开 `::selection`
     * 的底色（见 markdown.css 里同一段说明），闸本身仍保持"整层独占" ⇒ 不会和原生叠成两层。
     */
    const NATIVE_ATTR = 'data-sel-band-native'
    /**
     * "会盖住我们的带"的**结构性不透明块**白名单 —— 与 markdown.css 里那组
     * `[data-sel-band-native] …` 选择器**必须逐字一致**（这里判"该交回原生"，那边负责"重新打开
     * 原生 `::selection`"；两边不同步就会出现"撤了带、原生却没打开"= 又没样式）。
     */
    const NATIVE_KINDS = 'th, thead, .img-src-revealed, pre, code, blockquote'
    /** 带左右各外扩这么多 px：消掉"正文片段右缘 ↔ 公式片段左缘"之间实测 ~1.3px 的缝（≤1px 重叠不可见） */
    const SEL_BAND_PAD_X = 1
    /** 一次最多处理多少文本片段：超了就**不自己画**（撤闸、退回浏览器绘制），避免超长选区卡顿 */
    const SEL_BAND_MAX_FRAGS = 1200
    /** 我们临时加过 `img-selected` 的 widget（清的时候只动这一批） */
    const liveMarked = new Set<HTMLElement>()
    const liveRange = { from: -1, to: -1 }
    let selBand: HTMLElement | null = null
    let selOwn: 'all' | 'math' | null = null
    /** 落定态最近一次的输入（`from/to/doc` 全同就跳过重算：选区事务很多，别每一笔都量布局） */
    let settledKey: { from: number; to: number; doc: unknown } | null = null

    /**
     * 交回原生绘制的"不透明块"标记：本帧**有带被不透明底色盖住**时挂在 **`view.dom` 上** ——
     * 只在这些不透明块（表格 `thead/th`、显形源码 `.img-src-revealed`、代码块…）里重新打开
     * `::selection` 的底色（见 markdown.css 同一段说明），闸本身仍保持"整层独占" ⇒ 不会和原生叠成两层。
     * ⚠️ 必须挂在**根**上：往正文元素上写属性会惊动 PM 的 DOMObserver（实测直接把渲染进程卡死）。
     * 幂等：值不变就不碰 DOM。
     */
    const setSelNative = (view: EditorView | null | undefined, on: boolean): void => {
      const dom = view?.dom
      if (!dom) return
      const v = on ? 'on' : null
      if (dom.getAttribute(NATIVE_ATTR) === v) return
      try {
        if (v) dom.setAttribute(NATIVE_ATTR, v)
        else dom.removeAttribute(NATIVE_ATTR)
      } catch {
        /* 视图已销毁：忽略 */
      }
    }

    // ── 选中带的几何（全部来自测量：行盒自己算，与浏览器实画 Δ ≤ 0.3px）────────────────────

    /** 一个选中片段（**逐可见文本节点**建 Range：跨 `display:none` 的整段 Range 会返回空集，已踩过） */
    type SelFrag = {
      /** 该文字节点与区间 `[from,to]` 的交集 */
      range: Range
      /** 交集的**文字盒**（`getClientRects`） */
      rects: RectBox[]
      /** 行盒用哪个块算（行盒 = 块内该行所有内联内容盒的并集） */
      block: HTMLElement | null
      /**
       * 在**块级**公式里（`[data-md-math-block]`）：这一档**不套外层行盒** —— 片段在 KaTeX 的
       * 行内块里，浏览器画的是**它自己的行高盒**（实测 `23px`，外层行盒模型会算成 `89.25px`）
       * ⇒ 用片段盒按自己的 `line-height` 补半行距。
       */
      blockMath: boolean
      /** 该片段父元素的 used `line-height`（补半行距用） */
      lh: number
    }

    /** 行盒的"块"边界：与 `lineHeightAt` 同一套（标题/列表项/单元格/块级公式都算块） */
    const SEL_BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,pre,div'

    /**
     * 某块内**每一行**的行盒（= 该行所有内联内容盒的并集）。
     * 文本片段按 CSS 半行距模型上下补 `(usedLineHeight − 盒高)/2`；inline-block/替换盒取其边框盒。
     * 对照实测（`tmp/shots-121/nativegeom-*.json`）：行内公式+图片那一行 `143.25`（浏览器实画 `143.25`、
     * Δ `0.25px`）、纯文字行 `32.3`（实画 `32.3`、Δ `0.3px`）。
     */
    const blockLineBoxes = (block: HTMLElement): RectBox[] => {
      /** 文本片段（已按半行距补成"行高盒"） */
      const textItems: RectBox[] = []
      /** 图片/行内块实体盒 */
      const boxItems: RectBox[] = []
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let n: Node | null
      while ((n = walker.nextNode())) {
        const t = n as Text
        if (!t.length) continue
        const pe = t.parentElement
        if (!pe) continue
        const lh = parseFloat(getComputedStyle(pe).lineHeight)
        const r = document.createRange()
        r.selectNodeContents(t)
        for (const cr of Array.from(r.getClientRects())) {
          if (cr.width <= 0.5 && cr.height <= 0.5) continue
          const pad = Number.isFinite(lh) && lh > cr.height ? (lh - cr.height) / 2 : 0
          textItems.push({
            left: cr.left,
            right: cr.right,
            top: cr.top - pad,
            bottom: cr.bottom + pad
          })
        }
      }
      /**
       * 替换元素/行内块：**只并"图片盒"与行内公式构件盒本身**，**不并 KaTeX 内层 span**。
       * 为什么（第一百二十一轮实测）：KaTeX 的 `SPAN.pstrut`（`overflow:hidden` 的 inline-block）会
       * **向上溢出行盒**，把并集抬到 `64.84px`，而浏览器实画的正文带只有 `32.3px`（Δ `32.5px`）⇒
       * 并进来就变成"拖动期比松手后高一截"。而 `.md-math-rendered` 自身的盒是**行内盒**（实测
       * `21px`，不溢出）⇒ 拿它代表这颗行内公式。
       */
      const boxed = block.querySelectorAll<HTMLElement>('img,[data-img-widget]')
      for (const el of Array.from(boxed)) {
        for (const cr of Array.from(el.getClientRects())) {
          if (cr.width <= 0.5 && cr.height <= 0.5) continue
          boxItems.push({ left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom })
        }
      }
      const union = (g: RectBox, b: RectBox): void => {
        g.left = Math.min(g.left, b.left)
        g.right = Math.max(g.right, b.right)
        g.top = Math.min(g.top, b.top)
        g.bottom = Math.max(g.bottom, b.bottom)
      }
      /**
       * ① **文本行**：要求**较强竖直重叠**（≥ 较矮者的一半）才算同一行。
       * ⚠️ 第一百二十三（用户报障：「在图片源码上拖选 ⇒ 灰带把上一行也盖住」）真因一：
       * 旧口径是"**有任何竖直重叠就算同一行**"⇒ 一颗 143px 的行内图会把**它跨到的所有文本行**
       * 串成一串（实测把本段 3 行 + 2 张图粘成 `[354.02, 641.16]`＝**287px** 一个盒子），
       * 于是"按在下面那行源码上拖"的带从 354px 起、把上一行（正文+行内公式，413..436）也盖住。
       */
      const rows: RectBox[] = []
      const strongOverlap = (a: RectBox, b: RectBox, k: number): boolean => {
        const h = Math.min(a.bottom - a.top, b.bottom - b.top)
        return h > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= h * k
      }
      for (const b of textItems.sort((x, y) => x.top - y.top)) {
        const g = rows.find((x) => strongOverlap(x, b, 0.5))
        if (!g) rows.push({ ...b })
        else union(g, b)
      }
      /**
       * ② **图片盒**：它**竖直罩住**哪几行就并进哪几行（一颗高图 = 那一行的行盒，浏览器也是这么画的：
       * 实测该行正文带 `143.25px`）；一行都没罩住就并进"中心最近"的那行；连文本行都没有就自己成一行。
       */
      for (const b of boxItems) {
        if (!rows.length) {
          rows.push({ ...b })
          continue
        }
        const cy = (b.top + b.bottom) / 2
        const hit = rows.filter((r) => cy >= r.top && cy <= r.bottom)
        if (hit.length) for (const r of hit) union(r, b)
        else {
          let best = rows[0]
          let bestD = Infinity
          for (const r of rows) {
            const d = Math.abs((r.top + r.bottom) / 2 - cy)
            if (d < bestD) {
              bestD = d
              best = r
            }
          }
          union(best, b)
        }
      }
      /**
       * ③ 再把**几乎重合**的两行并成一条（同一行里的两条文本片段被①/②各自扩到同一个图盒后会近乎相等），
       * 阈值 0.8：真正的相邻行最多"擦边"重叠几个像素（实测 0.3~0.6px / 143px ⇒ 0.4%），绝不会到 80%。
       */
      const lines: RectBox[] = []
      for (const r of rows.sort((x, y) => x.top - y.top)) {
        const g = lines.find((x) => strongOverlap(x, r, 0.8))
        if (g) union(g, r)
        else lines.push({ ...r })
      }
      return lines
    }

    /** `y` 落在哪一行：优先"包含它的那条"，否则取竖直重叠最大的那条 */
    const pickLine = (lines: RectBox[], cy: number): RectBox | null => {
      let best: RectBox | null = null
      let bestOv = 0
      for (const l of lines) {
        if (cy >= l.top && cy <= l.bottom) return l
        const ov = Math.min(l.bottom, cy + 0.5) - Math.max(l.top, cy - 0.5)
        if (ov > bestOv) {
          bestOv = ov
          best = l
        }
      }
      return best
    }

    /**
     * 同一条**行盒**内水平相邻（间隙 ≤ `gap`）的矩形并成一条连续带 ⇒ 公式段与正文段无缝。
     * ⚠️ 第一百二十三真因二：旧口径是"**竖直有任何重叠**且水平相邻就合并"⇒ 相邻两行的行盒哪怕只
     * 擦边重叠 `0.3~0.6px`（实测：图行 `[354.67,497.92]` 与下一行 `[497.33,641.17]`）也会被粘成
     * 一条横跨两行的带。现在按**行盒身份**分组：只有同一条行盒（同一个对象）内部的矩形才合并，
     * 不同行一律各自成带（`top/bottom` 直接取该行行盒）。
     */
    const mergeBands = (
      pieces: Array<{ rect: RectBox; line: RectBox }>,
      gap: number
    ): RectBox[] => {
      const byLine = new Map<RectBox, RectBox[]>()
      for (const p of pieces) {
        const g = byLine.get(p.line)
        if (g) g.push(p.rect)
        else byLine.set(p.line, [p.rect])
      }
      const out: RectBox[] = []
      for (const [line, rects] of byLine) {
        const sorted = [...rects].sort((a, b) => a.left - b.left)
        let cur: RectBox | null = null
        for (const r of sorted) {
          if (cur && r.left <= cur.right + gap) cur.right = Math.max(cur.right, r.right)
          else {
            if (cur) out.push(cur)
            cur = { left: r.left, right: r.right, top: line.top, bottom: line.bottom }
          }
        }
        if (cur) out.push(cur)
      }
      return out
    }

    /** 区间覆盖到的可见文本片段：逐节点裁到 `[from,to]`，再按 `block` 缓存里取行盒 */
    const visibleFrags = (
      view: EditorView,
      from: number,
      to: number,
      onBlock: (b: HTMLElement) => RectBox[]
    ): SelFrag[] => {
      const out: SelFrag[] = []
      if (!(to > from)) return out
      const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT)
      let n: Node | null
      while ((n = walker.nextNode())) {
        const t = n as Text
        if (!t.length) continue
        /**
         * ⚠️ 第一百二十七轮：**块级公式内部**的文字节点全部跳过。
         * 原因：块级公式是 `div.md-math-block` 的 NodeView，而 `view.dom` 自己就是 `div`、也在
         * `SEL_BLOCK_SEL` 里 ⇒ `closest(SEL_BLOCK_SEL)` 会一路取到 `view.dom`，`blockLineBoxes`
         * 于是算出**整篇文档高**的"行盒"，带糊满全屏。块级公式**已经**由 `mathBlockBoxesIn`
         * 按构件盒整块并进来了（那一份才是对的），这里再出一份只会更糟。
         */
        if (t.parentElement?.closest('[data-md-math-block]')) continue
        let start = -1
        let whole = false
        try {
          start = view.posAtDOM(t, 0)
        } catch {
          start = NaN
        }
        if (!Number.isFinite(start)) {
          /**
           * 反查失败：**KaTeX 构件内部**的文字节点没有自己的文档位置（它是原子节点的一部分）
           * ⇒ 退回用**构件自己的位置**判"在不在区间里"；在就把整个节点算进来（原子节点要么全在、
           * 要么全不在，不需要逐字裁剪）。不兜底就会漏掉这几段 —— 而拖动期浏览器那份已经被我们
           * 关掉（`data-sel-own=all`）⇒ 那几段会**完全没有选中样式**（实测漏 5 片）。
           */
          const host = t.parentElement?.closest(
            '[data-md-math-rendered],[data-md-math-block]'
          ) as HTMLElement | null
          if (!host) continue
          try {
            const hp = view.posAtDOM(host, 0)
            if (!(Number.isFinite(hp) && hp >= from - 1 && hp <= to + 1)) continue
            start = 0
            whole = true
          } catch {
            continue
          }
        }
        const a1 = whole ? 0 : Math.max(from, start)
        const b1 = whole ? t.length : Math.min(to, start + t.length)
        if (b1 <= a1) continue
        const r = document.createRange()
        try {
          r.setStart(t, a1 - start)
          r.setEnd(t, b1 - start)
        } catch {
          continue
        }
        const rects: RectBox[] = []
        for (const cr of Array.from(r.getClientRects())) {
          if (cr.width <= 0.5 && cr.height <= 0.5) continue
          rects.push({ left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom })
        }
        if (!rects.length) continue
        const block = (t.parentElement?.closest(SEL_BLOCK_SEL) as HTMLElement | null) ?? null
        if (block) onBlock(block)
        const blockMath = !!t.parentElement?.closest('[data-md-math-block]')
        const lh = parseFloat(
          getComputedStyle(t.parentElement ?? (t as unknown as Element)).lineHeight
        )
        out.push({ range: r, rects, block, blockMath, lh: Number.isFinite(lh) ? lh : 0 })
        if (out.length >= SEL_BAND_MAX_FRAGS) break
      }
      return out
    }

    /**
     * 构件的**文档区间**（`[s,e)`，`e>s`）。`posAtDOM(el,0)` 给的是构件**前面**那个位置；
     * 长度取 `doc.nodeAt(pos).nodeSize`（行内公式/图片这类原子节点都是 1）。
     */
    const widgetRange = (view: EditorView, el: HTMLElement): { s: number; e: number } | null => {
      let p = NaN
      try {
        p = view.posAtDOM(el, 0)
      } catch {
        return null
      }
      if (!Number.isFinite(p)) return null
      let size = 1
      try {
        const n = view.state.doc.nodeAt(p)
        if (n && n.nodeSize > 0) size = n.nodeSize
      } catch {
        /* 取不到就按 1 处理 */
      }
      return { s: p, e: p + size }
    }

    /**
     * **严格覆盖**判定：只有 `[from,to]` 把构件整段包住（`from ≤ s && to ≥ e`）才算"并入"。
     * ⚠️ 第一百二十三（用户报障：「从后往前选『粗』到『星』，竟把后面的 `a * kb` 也选上」）真因：
     * 旧口径是 `p >= from - 1 && p <= to + 1`（±1 位置）⇒ **选区正好停在公式起点**时照样命中，
     * 于是把公式**整块**矩形并进来 ⇒ 画出了选区之外的灰底（"不许更宽"）。
     */
    const coversWidget = (from: number, to: number, r: { s: number; e: number } | null): boolean =>
      !!r && r.e > r.s && from <= r.s && to >= r.e

    /** 落在区间里、且**被完整覆盖**的**行内公式渲染子树**（落定态只接管这几段） */
    const mathWidgetsIn = (view: EditorView, from: number, to: number): HTMLElement[] => {
      const out: HTMLElement[] = []
      for (const el of Array.from(
        view.dom.querySelectorAll<HTMLElement>('[data-md-math-rendered]')
      )) {
        if (coversWidget(from, to, widgetRange(view, el))) out.push(el)
      }
      return out
    }

    /**
     * 落在区间里、且**被完整覆盖**的**块级公式盒**（`div.md-math-block`）。
     *
     * ⚠️ 第一百二十七轮（用户报障 2 的真凶之一）：块级公式是 **NodeView + KaTeX**，它内部那些文字
     * 节点**没有自己的文档位置**（`posAtDOM` 抛）⇒ `visibleFrags` 一条都取不到它，于是
     * `paintSelBands(mode='all')` 对**整块公式一个矩形都不画**；而拖动期 `data-sel-own='all'`
     * 已经把浏览器那份关掉了 ⇒ **在块级公式上拖动，拖动期一个像素的选中样式都没有**（逐帧实测：
     * 12~24 个公式字形盒的"覆盖差额"帧帧不为 0，`own=null/bandN=0/hl=0`）。松手后靠原生/落定态
     * 才回来 —— 正是用户"按下拖动但内容却没有被选中的样式，抬起时才有"那句话。
     * 所以块级公式必须**与图片一样当成"可覆盖的原子盒"**并进来。
     *
     * 盒子的取法：优先用**公式自身的渲染盒**（KaTeX 的 `.katex-display` 子元素，宽高贴着公式），
     * 拿不到才退回外层 `div.md-math-block`（它是**整行宽**，会把整行都铺上带，那正是"不许更宽"）。
     */
    const mathBlockBoxesIn = (view: EditorView, from: number, to: number): HTMLElement[] => {
      const out: HTMLElement[] = []
      for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>('[data-md-math-block]'))) {
        if (!coversWidget(from, to, widgetRange(view, el))) continue
        const inner = el.firstElementChild as HTMLElement | null
        out.push(inner && inner.getBoundingClientRect().width > 0.5 ? inner : el)
      }
      return out
    }

    /** 落在区间里、且**被完整覆盖**的图片实体盒（选中观感仍由既有 `img-selected` 负责，这里只让带连续过图） */
    const imgWidgetsIn = (view: EditorView, from: number, to: number): HTMLElement[] => {
      const out: HTMLElement[] = []
      const srcs = collectImgSources(view.state)
      for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>('[data-img-widget]'))) {
        const f = Number(el.getAttribute('data-img-from'))
        if (!Number.isFinite(f)) continue
        const src = srcs.find((i) => i.from === f)
        if (!src) continue
        if (from <= src.from && to >= src.to) out.push(el)
      }
      return out
    }

    const ensureSelBand = (view: EditorView): HTMLElement => {
      if (selBand && selBand.isConnected) return selBand
      selBand = document.createElement('div')
      selBand.className = SEL_BAND_CLASS
      selBand.setAttribute('data-sel-band', '')
      selBand.contentEditable = 'false'
      selBand.setAttribute('aria-hidden', 'true')
      ;(view.dom.parentElement ?? document.body).appendChild(selBand)
      return selBand
    }

    /** 闸门开关：`null` = 浏览器自己画（默认）；`all` = 拖动期整层独占；`math` = 落定态只接管行内公式 */
    const setSelOwn = (view: EditorView | null | undefined, v: 'all' | 'math' | null): void => {
      const dom = view?.dom
      const cur = dom ? (dom.getAttribute(SEL_OWN_ATTR) as 'all' | 'math' | null) : null
      if (selOwn === v && cur === v) return
      selOwn = v
      if (!dom) return
      try {
        if (v) dom.setAttribute(SEL_OWN_ATTR, v)
        else dom.removeAttribute(SEL_OWN_ATTR)
      } catch {
        /* 视图已销毁：忽略 */
      }
    }

    /**
     * 原生（浏览器 DOM）选区的**文档区间**。
     * 第一百二十一轮：拖动期整层由我们画（浏览器那份关掉）⇒ "我们画的"必须**包含**浏览器本来
     * 会画的那段（否则就是新的一种"漏画"）：所以取 `试探区间 ∪ 原生区间`。原来的"把原生那段从
     * 临时高亮里扣掉"（第一百一十五轮）随之作废 —— 那是"两层各画一半"时代的补丁。
     */
    const nativeDocRange = (view: EditorView): { from: number; to: number } | null => {
      const s = window.getSelection()
      if (!s || s.isCollapsed || !s.rangeCount) return null
      const r = s.getRangeAt(0)
      if (!view.dom.contains(r.startContainer) || !view.dom.contains(r.endContainer)) return null
      try {
        const a = view.posAtDOM(r.startContainer, r.startOffset)
        const b = view.posAtDOM(r.endContainer, r.endOffset)
        return { from: Math.min(a, b), to: Math.max(a, b) }
      } catch {
        return null
      }
    }

    const clearSelBands = (view?: EditorView | null): void => {
      setSelOwn(view, null)
      if (selBand) {
        selBand.remove()
        selBand = null
      }
      setSelNative(view, false)
      try {
        const h = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
        h?.delete(LIVE_SEL_HIGHLIGHT)
      } catch {
        /* 环境没有这个 API：忽略 */
      }
      try {
        const d = view?.dom
        d?.removeAttribute('data-sel-band-live')
        d?.removeAttribute('data-sel-band-ours')
        d?.removeAttribute('data-sel-band-miss')
      } catch {
        /* 视图已销毁：忽略 */
      }
    }

    /**
     * 画一帧选中带（**只画不改**）。
     * @param mode `math` = 落定态（只接管行内公式那几段）；`all` = 拖动期（整层独占）
     * @returns 这一帧"我们负责画"的矩形数（0 ⇒ 已撤层撤闸，退回浏览器绘制）
     */
    const paintSelBands = (
      view: EditorView,
      from: number,
      to: number,
      mode: 'all' | 'math'
    ): number => {
      if (!(to > from)) {
        clearSelBands(view)
        return 0
      }
      const lineCache = new Map<HTMLElement, RectBox[]>()
      const linesOf = (b: HTMLElement): RectBox[] => {
        let v = lineCache.get(b)
        if (!v) {
          v = blockLineBoxes(b)
          lineCache.set(b, v)
        }
        return v
      }
      /** 落定态：先看有没有行内公式落在区间里（**不整树遍历**，只查构件） */
      const widgets = mode === 'math' ? mathWidgetsIn(view, from, to) : []
      const frags = mode === 'all' ? visibleFrags(view, from, to, linesOf) : []
      if (mode === 'math' && !widgets.length) {
        clearSelBands(view)
        return 0
      }
      if (mode === 'all' && frags.length > SEL_BAND_MAX_FRAGS) {
        view.dom.setAttribute('data-sel-band-miss', 'over-cap')
        clearSelBands(view)
        return 0
      }
      const lineOf = (block: HTMLElement | null, cy: number, fallback: RectBox): RectBox => {
        const lb = block ? pickLine(linesOf(block), cy) : null
        return lb ?? fallback
      }
      // ── 我们负责的矩形（**行盒**高 × 覆盖到的 x 范围）+ 它属于哪一条行盒（合并只在同一条行盒内做）
      const pieces: Array<{ rect: RectBox; line: RectBox }> = []
      /**
       * 这些带"落在哪些块里"——用来判**带能不能被看见**（见下面的 `bandBlocksOpaque`）。
       * 第一百二十五轮：表格 `thead/th` 有 `background: var(--panel-2)`、显形源码有
       * `background-color: var(--edge)`，两者都**不透明**；而我们的层挂在
       * `view.dom.parentElement` 且**不写 z-index**（markdown.css 里"覆盖层自己 `z-index: auto`"
       * 那段）⇒ 落在正文**之下**、被这些底色整块盖住 ⇒ 用户报的"表头/源码拖动期没有选中样式"
       * （逐帧实测：闸 `all` + 带存在，但像素上是裸底色 `rgb(233,235,240)` / `rgb(228,230,234)`，
       * 松手后才是 `rgb(209,212,218)` / `rgb(205,208,212)`，Δ 67~69）。
       */
      const pieceBlocks = new Set<HTMLElement>()
      /** 兜底高亮用：我们负责的**片段**（带没盖住的那几段补进 Highlight） */
      const intentFrags: SelFrag[] = mode === 'all' ? frags : []
      if (mode === 'math') {
        for (const w of widgets) {
          const box = w.getBoundingClientRect()
          if (!(box.width > 0.5 && box.height > 0.5)) continue
          const r: RectBox = { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
          const block = (w.closest(SEL_BLOCK_SEL) as HTMLElement | null) ?? null
          if (block) pieceBlocks.add(block)
          const lb = lineOf(block, (box.top + box.bottom) / 2, r)
          pieces.push({
            rect: { left: r.left, right: r.right, top: lb.top, bottom: lb.bottom },
            line: lb
          })
          // 兜底：这颗公式里的文字盒（行盒算错时也要有底色）
          const walker = document.createTreeWalker(w, NodeFilter.SHOW_TEXT)
          let n: Node | null
          while ((n = walker.nextNode())) {
            const t = n as Text
            if (!t.length) continue
            const rg = document.createRange()
            rg.selectNodeContents(t)
            const rects: RectBox[] = []
            for (const cr of Array.from(rg.getClientRects())) {
              if (cr.width <= 0.5 && cr.height <= 0.5) continue
              rects.push({ left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom })
            }
            if (rects.length) intentFrags.push({ range: rg, rects, block, blockMath: false, lh: 0 })
          }
        }
      } else {
        for (const f of frags) {
          // 块级公式的片段在下面单独处理（不套行盒）
          if (f.blockMath) continue
          if (f.block) pieceBlocks.add(f.block)
          for (const r of f.rects) {
            const lb = lineOf(f.block, (r.top + r.bottom) / 2, r)
            pieces.push({
              rect: { left: r.left, right: r.right, top: lb.top, bottom: lb.bottom },
              line: lb
            })
          }
        }
        /**
         * 行内公式：用**构件盒**取 x（公式片段的文字盒与相邻正文之间实测有 ~1.3px 的缝）。
         * 命中口径 = **严格覆盖**（`coversWidget`）：选区只"碰到"公式起点不算命中，绝不把公式
         * 整块并进来（第一百二十三用户报障真因）。
         */
        for (const w of Array.from(
          view.dom.querySelectorAll<HTMLElement>('[data-md-math-rendered]')
        )) {
          if (!coversWidget(from, to, widgetRange(view, w))) continue
          const box = w.getBoundingClientRect()
          if (!(box.width > 0.5 && box.height > 0.5)) continue
          const r: RectBox = { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
          const block = (w.closest(SEL_BLOCK_SEL) as HTMLElement | null) ?? null
          if (block) pieceBlocks.add(block)
          const lb = lineOf(block, (box.top + box.bottom) / 2, r)
          pieces.push({
            rect: { left: r.left, right: r.right, top: lb.top, bottom: lb.bottom },
            line: lb
          })
        }
        // 图片：让带连续过图（严格覆盖才算；选中观感仍由 `img-selected` 负责）
        for (const w of imgWidgetsIn(view, from, to)) {
          const box = w.getBoundingClientRect()
          if (!(box.width > 0.5 && box.height > 0.5)) continue
          const r: RectBox = { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
          const block = (w.closest(SEL_BLOCK_SEL) as HTMLElement | null) ?? null
          if (block) pieceBlocks.add(block)
          const lb = lineOf(block, (box.top + box.bottom) / 2, r)
          pieces.push({
            rect: { left: r.left, right: r.right, top: lb.top, bottom: lb.bottom },
            line: lb
          })
        }
        // 块级公式：它在 `visibleFrags` 里取不到任何片段（KaTeX 的字形没有文档位置）⇒ 必须像图片
        // 一样按**构件盒**并进来，否则整块公式在拖动期一点样式都没有（见 `mathBlockBoxesIn`）。
        // ⚠️ 这里**不套外层行盒**（`lineOf` 会一路 `closest` 到 `view.dom` 那个 div ⇒ 行盒变成
        // 整篇文档高，带会糊满全屏）—— 块的边界就是公式自己的盒。
        for (const w of mathBlockBoxesIn(view, from, to)) {
          const box = w.getBoundingClientRect()
          if (!(box.width > 0.5 && box.height > 0.5)) continue
          const own: RectBox = {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom
          }
          const block = (w.closest(SEL_BLOCK_SEL) as HTMLElement | null) ?? null
          if (block) pieceBlocks.add(block)
          pieces.push({ rect: own, line: own })
        }
        // 块级公式的**文字片段兜底**：片段在 KaTeX 的行内块里，浏览器画的是它自己的行高盒
        // （外层行盒会把 89px 算成别的）⇒ 每片段自成一条"行"、不与相邻片段跨行合并。
        for (const f of frags) {
          if (!f.blockMath) continue
          if (f.block) pieceBlocks.add(f.block)
          for (const r of f.rects) {
            const h = r.bottom - r.top
            const pad = f.lh > h ? (f.lh - h) / 2 : 0
            const own: RectBox = {
              left: r.left,
              right: r.right,
              top: r.top - pad,
              bottom: r.bottom + pad
            }
            pieces.push({ rect: own, line: own })
          }
        }
      }
      if (!pieces.length) {
        clearSelBands(view)
        return 0
      }
      const bands = mergeBands(pieces, 8)
      for (const b of bands) {
        b.left -= SEL_BAND_PAD_X
        b.right += SEL_BAND_PAD_X
      }
      // ── 画（容器与 `.img-src-overlay` 同一套：挂在 `view.dom.parentElement`，落在正文之下）
      const node = ensureSelBand(view)
      const parent = node.offsetParent as HTMLElement | null
      const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
      const frag = document.createDocumentFragment()
      for (const b of bands) {
        const d = document.createElement('div')
        d.style.left = `${(b.left - base.left).toFixed(2)}px`
        d.style.top = `${(b.top - base.top).toFixed(2)}px`
        d.style.width = `${Math.max(0, b.right - b.left).toFixed(2)}px`
        d.style.height = `${Math.max(0, b.bottom - b.top).toFixed(2)}px`
        frag.appendChild(d)
      }
      node.replaceChildren(frag)
      /**
       * 带**被不透明底色盖住**时，盖住我们的那一层元素（`elementsFromPoint` 里第一个
       * `backgroundColor` alpha > 0.02 的、且在我们的正文子树之内）。逐帧实测的两处真凶：
       *   * 表格 `thead/th`：`background: var(--panel-2)` = `rgb(233,235,240)`；
       *   * 显形源码 `<span class="img-src-revealed">`：`background-color: var(--edge)` = `rgb(228,230,234)`
       *     —— 它是**段落的后代**（不是祖先），所以只能按"带上的实际像素点"判，不能只走祖先链。
       * 零硬编码：只看 computed 背景色的 alpha；±2px 只是**取样容差**（上沿/中心/下沿三点抽样），
       * 不是视觉尺寸。
       */
      const opaqueCoverAt = (r: RectBox): HTMLElement | null => {
        const x = (r.left + r.right) / 2
        for (const y of [r.top + 2, (r.top + r.bottom) / 2, r.bottom - 2]) {
          let stack: Element[] = []
          try {
            stack = document.elementsFromPoint(x, y)
          } catch {
            stack = []
          }
          for (const el of stack) {
            if (el === view.dom) break
            if (!view.dom.contains(el)) continue
            /**
             * ⚠️ 只认**结构性的不透明块**（与 markdown.css 里那组"交回原生"的选择器**同一份白名单**）：
             * 泛化到"任何有不透明底色的元素"会把图片 widget 的拖动高亮也算进来 ⇒ 每帧时有时无地
             * 撤掉过图的带（实测 A 手势的可见并集 4 帧回缩、出现接缝）。
             */
            if (!(el as HTMLElement).matches?.(NATIVE_KINDS)) continue
            let bg = ''
            try {
              bg = getComputedStyle(el).backgroundColor
            } catch {
              bg = ''
            }
            const m = /^rgba?\(([^)]+)\)$/.exec(bg)
            if (!m) continue
            const p = m[1].split(',').map((v) => parseFloat(v))
            if ((p.length > 3 ? p[3] : 1) > 0.02) return el as HTMLElement
          }
        }
        return null
      }
      // ── 回读**渲染后**的矩形（自证："画的"确实盖住了"要画的"）
      const drawn: RectBox[] = []
      for (const d of Array.from(node.children)) {
        const r = d.getBoundingClientRect()
        drawn.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
      }
      /**
       * 第一百二十五轮：**看不见的带要撤掉，并把盖住它的那层交给原生**。
       *
       * 用户两条报障（表头 / 点图后立刻在源码上拖动）逐帧实测的机制完全一样：
       * `data-sel-own='all'` 把浏览器自己的绘制关掉了，而我们的带画在 `view.dom` **之下**
       * （markdown.css："覆盖层自己 `z-index: auto`，落在正文/选区/图片之下"）⇒ 碰到
       * `th` 的 `--panel-2`、显形源码的 `--edge` 这类**不透明底色**就被整块盖住 ⇒
       * **拖动期一点样式都没有，松手后（落定态不再整层独占）才回来**。
       *
       * 做法（"闸只能关掉我们确实画到的部分"）：
       *   ① 被盖住的带**从我们的层里撤掉** —— 留着只会和原生在底色上叠成两层 `--sel`
       *      （实测 `rgb(184,188,193)` vs 松手后 `rgb(205,208,212)`，Δ 60，肉眼更暗）；
       *   ② 把"盖住我们的那层元素"标 `data-sel-band-native` ⇒ **原生选区只在这些块里接管绘制**
       *      （原生画在底色**之上**、文字**之下**，与松手后逐像素一致：表头 `rgb(209,212,218)`、
       *      源码 `rgb(205,208,212)`，Δ 0）；
       *   ③ 这些块里的片段交给原生，**不再进兜底 Highlight**（否则又叠一层）。
       * 其余部分照旧：整层独占 + 我们的带（零叠加）。
       */
      const dropIdx = new Set<number>()
      drawn.forEach((r, i) => {
        if (opaqueCoverAt(r)) dropIdx.add(i)
      })
      const kids = Array.from(node.children)
      for (const i of dropIdx) kids[i]?.remove()
      setSelNative(view, dropIdx.size > 0)
      const hiddenRects = drawn.filter((_, i) => dropIdx.has(i))
      const rendered = drawn.filter((_, i) => !dropIdx.has(i))
      const handledByNative = (f: SelFrag): boolean => {
        return f.rects.some((r) =>
          hiddenRects.some(
            (h) =>
              h.left <= r.left + 0.5 &&
              h.right >= r.right - 0.5 &&
              Math.min(h.bottom, r.bottom) - Math.max(h.top, r.top) > 0
          )
        )
      }
      const covered = (r: RectBox): boolean =>
        rendered.some(
          (b) =>
            b.left <= r.left + 0.5 &&
            b.right >= r.right - 0.5 &&
            Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 0
        )
      let missFrag = 0
      const missRanges: Range[] = []
      for (const f of intentFrags) {
        if (handledByNative(f)) continue
        if (f.rects.every(covered)) continue
        missFrag++
        missRanges.push(f.range)
      }
      try {
        const h = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
        const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
        if (h && H) {
          if (missRanges.length) h.set(LIVE_SEL_HIGHLIGHT, new H(...missRanges))
          else h.delete(LIVE_SEL_HIGHLIGHT)
        }
      } catch {
        /* 无 API：忽略（带本身已经画出来了） */
      }
      setSelOwn(view, rendered.length ? mode : null)
      try {
        const fmt = (r: RectBox): string =>
          `${r.left.toFixed(2)},${r.top.toFixed(2)},${r.right.toFixed(2)},${r.bottom.toFixed(2)}`
        view.dom.setAttribute(
          'data-sel-band-ours',
          intentFrags
            .flatMap((f) => f.rects)
            .map(fmt)
            .join(';')
        )
        view.dom.setAttribute('data-sel-band-live', rendered.map(fmt).join(';'))
        view.dom.setAttribute('data-sel-band-miss', `0/${missFrag}`)
      } catch {
        /* 忽略 */
      }
      return rendered.length
    }

    /** 落定态：按**模型选区**画一帧（`from/to/doc` 全同就跳过重算：选区事务很多，别每笔都量布局） */
    const paintSettledSel = (view: EditorView): void => {
      const s = view.state.selection
      const k = settledKey
      if (k && k.from === s.from && k.to === s.to && k.doc === view.state.doc) return
      settledKey = { from: s.from, to: s.to, doc: view.state.doc }
      if (s.empty) {
        clearSelBands(view)
        return
      }
      paintSelBands(view, s.from, s.to, 'math')
    }

    const clearLiveSel = (view?: EditorView | null): void => {
      liveRange.from = -1
      liveRange.to = -1
      /**
       * ① 图片类：只摘"当前状态并未选中"的那些（装饰自己加的那份不动）。清 `liveMarked` 之前
       * 先算 `stillSelected`，`liveMarked` 为空就直接跳过（省一次 `collectImgSources`）。
       */
      if (liveMarked.size && view) {
        const stillSelected = new Set<number>()
        const sel = view.state.selection
        if (sel && !sel.empty) {
          for (const i of collectImgSources(view.state)) {
            if (
              selectionIntersectsSource(
                { from: sel.from, to: sel.to, empty: false, nodeSel: false },
                { from: i.from, to: i.to }
              )
            )
              stillSelected.add(i.from)
          }
        }
        for (const el of liveMarked) {
          const from = Number(el.getAttribute('data-img-from'))
          if (!stillSelected.has(from)) el.classList.remove(IMG_SELECTED_CLASS)
        }
      }
      liveMarked.clear()
      /**
       * ② 选中带：撤掉"整层独占"，改按**当前模型选区**画落定态（只有行内公式那几段由我们接管）。
       * 视图已销毁 ⇒ 整层撤掉（容器挂在 `view.dom` 之外，必须手动摘）。
       */
      settledKey = null
      if (view && view.dom?.isConnected) paintSettledSel(view)
      else clearSelBands(view)
    }

    /**
     * 按试探区间画一帧（同一帧里文字与图片一起画）。
     * @param from/@param to 试探区间（`[min(锚点, 当前点), max(...)]`，锚点复用按下点/按列映射）
     */
    const paintLiveSel = (view: EditorView, from: number, to: number): void => {
      if (to <= from) {
        clearLiveSel(view)
        return
      }
      liveRange.from = from
      liveRange.to = to
      /**
       * ① 文字 + 公式 + 图片：整层行盒选中带（`all` 档：拖动期由我们独占绘制）。
       * 几何与落定态**同一份函数**（`paintSelBands`）⇒ 用户第②条"拖动中 ≡ 松手后"按构造成立。
       * 画不出来（位置不合法、片段超上限）⇒ 撤闸，浏览器自己那份照旧 ⇒ 不会"没有样式"。
       */
      settledKey = null
      /** 我们画的 ⊇ 浏览器本来会画的 ⇒ 取"试探区间 ∪ 原生区间"（见 `nativeDocRange`） */
      const nat = nativeDocRange(view)
      const pf = nat ? Math.min(from, nat.from) : from
      const pt = nat ? Math.max(to, nat.to) : to
      paintSelBands(view, pf, pt, 'all')
      // ② 图片：落在试探区间里的 widget 加既有 `img-selected`
      const srcs = collectImgSources(view.state).filter((i) =>
        selectionIntersectsSource(
          { from, to, empty: false, nodeSel: false },
          { from: i.from, to: i.to }
        )
      )
      const want = new Set(srcs.map((i) => i.from))
      const widgets = view.dom.querySelectorAll<HTMLElement>('[data-img-widget]')
      for (const w of Array.from(widgets)) {
        const f = Number(w.getAttribute('data-img-from'))
        if (!Number.isFinite(f)) continue
        if (want.has(f)) {
          if (!w.classList.contains(IMG_SELECTED_CLASS)) {
            w.classList.add(IMG_SELECTED_CLASS)
            liveMarked.add(w)
          }
        } else if (liveMarked.has(w)) {
          w.classList.remove(IMG_SELECTED_CLASS)
          liveMarked.delete(w)
        }
      }
    }

    /**
     * 第一百一十五轮 · **单次手势内可见覆盖只增不减**（真因一的护栏）。
     * 远端走**高水位**：只要指针还在朝远离锚点的方向走，试探区间的远端**只增不减**；
     * 只有指针**真的往回走了 ≥`TAIL_BACK_PX`(4px)** 才允许把高水位降到当前值。
     * 4px 的理由：指针 jitter / 亚像素取整通常 <2px，而"往回选"的手部动作一定远超 4px
     * ⇒ 既不会吞掉真正的反向回缩，也不会让尾巴被一两帧的抖动吃掉。
     */
    const TAIL_BACK_PX = 4

    /** 指针到按下点的"轴向距离"（px）：判断"继续远离"还是"真的往回走" */
    const pxAway = (x: number, y: number): number => {
      const p = boxDrag?.press
      return p ? Math.abs(x - p.x) + Math.abs(y - p.y) : 0
    }

    /**
     * 拖动期每帧：锚点（按下点/原生锚点）→ 当前点（盒上取半盒端，否则用原生光标）⇒ 试探区间。
     * 远端经**高水位护栏**处理；返回值同时供绘制与落定使用（两者取同一个值 ⇒ 松手不跳变）。
     */
    const boxDragRange = (
      view: EditorView,
      x: number,
      y: number
    ): { from: number; to: number } | null => {
      if (!boxDrag) return null
      const a = boxDrag.anchor ?? boxDrag.pressPos
      if (a == null) return null
      const b = boxDrag.focus ?? view.state.selection.head
      if (b == null) return null
      const px = pxAway(x, y)
      if (boxDrag.hw == null) {
        boxDrag.hw = b
        boxDrag.hwPx = px
      } else {
        const growing = Math.abs(b - a) >= Math.abs(boxDrag.hw - a)
        const back = px < boxDrag.hwPx - TAIL_BACK_PX
        if (growing || back) {
          boxDrag.hw = b
          boxDrag.hwPx = px
        }
      }
      const far = boxDrag.hw ?? b
      return { from: Math.min(a, far), to: Math.max(a, far) }
    }

    const boxDragLive = (view: EditorView, x: number, y: number): void => {
      const r = boxDragRange(view, x, y)
      if (!r) return
      /** 记下"画面上这一份"的**两端**（落定按它对齐，见 `onBandUp` 里那段说明） */
      if (boxDrag) {
        boxDrag.lastLiveNear = r.from
        boxDrag.lastLiveFar = r.to
      }
      /**
       * 诊断锚（与 `data-img-open` 同一用途）：把这一帧的**锚点 / 当前点 / 试探区间**摊平成
       * `anchor|head|from|to`，套件可以直接逐帧断言"锚点恒定、远端不回缩"。
       */
      view.dom.setAttribute(
        'data-img-drag-live',
        `${boxDrag?.anchor ?? boxDrag?.pressPos}|${boxDrag?.focus ?? view.state.selection.head}|${r.from}|${r.to}`
      )
      paintLiveSel(view, r.from, r.to)
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
            // 第八十二轮：**多个** <img …> 标签合成一段的 htmlBlock 也要认（否则整段只显示源码）
            if (!isImgOnlyRawHtml(src)) return true
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
            if (livePending() && !tr.getMeta(KEY)) return value
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
              // 第一百零四轮（DOM 身份快照）：拖动期间只让"**按下点所在的那个源码**"保持显示，
              // 其它源一律隐藏（第七十五轮防闪口径）；松手后恢复既有口径。
              revealDecision(selLike, i, { dragging: dragActive, dragInsideFrom }) === 'show' &&
              (i.kind !== 'node' || selLike.nodeSel)
            const pick = keep && showable(keep) ? keep : (imgs.find((i) => showable(i)) ?? null)
            if (!pick) return { from: null, editing: false, openedAt: value.openedAt }
            /**
             * 光标**严格落进**标识符文本 ⇒ 正在编辑（底色撤掉；Typora 同观感）。
             * ⚠️ 第六十四轮：刚点开的那一下，浏览器/PM 会顺手把光标落到标识符里（那是这一击的
             * 收尾，不是"用户要点进文本来编辑"）⇒ 开点后 400ms 内忽略这种选区同步，
             * 底色才不会被"先加后撤"地闪一下。
             */
            const justOpened = Date.now() - (value.openedAt || 0) < 400
            /**
             * ⚠️ 第一百一十二轮（用户报障：交界处点击 ⇒ "显示源码 / 不显示源码"闪烁）：
             * 此前**只要 `pick` 与 `value.from` 不同就重置 `openedAt`**，于是一次"按压把可见源从
             * A 切到 B"（`onDragDown` 的按哪段显哪段口径）也会被当成"刚点开" ⇒ `justOpened` 为真
             * ⇒ 光标明明**严格落在 B 里面**却把 `editing` 压成 `false`（底色亮着），400ms 后才又
             * 切回编辑态（底色撤掉）—— 一次点击**两次可见跃迁**。实测（交界处 9 点）：
             * `R(bgE) → -(open=null) → RE(bgO) → R(bgE)`，回摆在 #1 与 #3 帧。
             * 现在 `openedAt` **只在"从没开 → 开"那一次**才重置（真正的激活），A→B 切换沿用原值：
             * `editing` 只由 `caretInside`（光标严格在 (from,to) 内）决定，不再被误压。
             */
            const caretInside =
              sel.empty && sel.from > pick.from && sel.from < pick.to && !justOpened
            return {
              from: pick.from,
              editing: caretInside,
              openedAt: value.from == null ? Date.now() : value.openedAt
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
              /**
               * 第八十二轮：这一段里**不止一张图**（紧邻的多个 <img …>）⇒ 打一个类，
               * 让 CSS 把白空策略改回 normal 并强制所有 widget 行内并排（+ 间隙）。
               * 为什么需要：段内空白是 reak-spaces（保留换行），夹在两张图之间的换行会被
               * 当成换行符 ⇒ 两图被拆到两行（实测：纯两标签夹具 215px 宽的两图上下排）。
               */
              if (inside.length >= 2) {
                decos.push(Decoration.node(from, to, { class: 'img-side-by-side' }))
                return
              }
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
            /**
             * 第一百零六轮（用户口径）：「图片要像浏览器里展示的图片一样**可以被选择选中** ——
             * 拖动选中跨过图片时，图片本身也要显示为被选中」。
             * 判据 = **选区与它有交**（`selectionIntersectsSource`，浏览器语义：碰到就算，
             * 不要求全覆盖）；⚠️ 它**只**决定观感（`img-selected`）：标识符"该不该隐藏"仍走
             * `selectionCoversSource`（见 `revealDecision`）—— 两条口径已拆开，不许合并。
             */
            const sel93 = state.selection
            const selLike93 = {
              from: sel93.from,
              to: sel93.to,
              empty: sel93.empty,
              nodeSel: sel93.constructor.name === 'NodeSelection'
            }
            for (const img of imgs) {
              const selected = selectionIntersectsSource(selLike93, img)
              if (selected && img.kind === 'node') {
                decos.push(Decoration.node(img.from, img.to, { class: IMG_SELECTED_CLASS }))
              }
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
                      if (selected) span.classList.add(IMG_SELECTED_CLASS)
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
              /**
               * 第八十三轮：**只由 `<img …>` 标签组成的多标签原文**是**合法**的（每一张都会渲染），
               * 不能算"改坏" —— 否则整段会被挂上 `.img-src-incomplete`，那层包装把源码文本
               * 一起留在行内流里（实测：`span.md-html` 宽 924、跨两行），把第二个 widget
               * 挤到下一行去（㉕③ 的真因之一）。
               */
              if (isImgOnlyRawHtml(t)) return true
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
              clearPending()
              /**
               * 第一百零八轮（用户口径）：先接管"**整行全高覆盖层里的空白带**"——
               * 点它 **不收回**源码，并且按**同一 x 列**把光标落到该行源码上（浏览器输入框语义）。
               * ⚠️ 只接管"片段盒子之外"的那一片：源码字形/内边距、图片本体、别处一律照旧放行。
               */
              const t0 = event.target as HTMLElement | null
              if (!t0?.closest?.('[data-img-widget]') && t0?.tagName !== 'IMG') {
                const band = bandAt(view, event.clientX, event.clientY)
                if (band) {
                  const pos = caretByColumn(view, band.el, band.frag, event.clientX)
                  if (pos != null) {
                    event.preventDefault()
                    /**
                     * 第一百一十轮：把这一按记成"带内拖动的锚点"（拖动时按同一套映射扩选）；
                     * 没有拖动就是一次普通单击 ⇒ 只落光标（选区为空）——口径不变。
                     */
                    bandDrag = { el: band.el, anchor: pos }
                    view.dispatch(
                      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
                    )
                    return true
                  }
                }
              }
              /**
               * 第七十一轮（用户报障：标识符"根本无法编辑和选中"）：**已经显示出来的标识符文本**
               * 必须走原生文本行为（放光标、拖选、输入）。此前这里对"按在图片源码范围内"的按下
               * **一律** `preventDefault` + `return true` ⇒ 标识符文本上的拖选也被吞掉
               * （实测：在标识符内部拖动 ⇒ `from==to`、`empty:true`，选区根本没起来）。
               * 现收窄为：**按在标识符文本上一律放行**（返回 false，交给 PM/浏览器），
               * 其余仍走"坐标 → 落在图片源码范围内 ⇒ 记 pendingClick"的老判据。
               */
              const target = t0
              if (target?.closest?.('[data-img-revealed]')) return false
              /**
               * 第七十八轮：远程图片的**占位**（`click` 档下的 `[data-remote-src]`）也必须放行 ——
               * 否则这里的 `preventDefault()`（加上元素自身 `draggable`）会把后续的 `click`
               * 吞掉，app 容器上那个"点一下加载远程图"的钩子就永远收不到 ⇒ 用户点了没反应。
               */
              if (target?.closest?.('[data-remote-src]')) return false
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
              /**
               * 第八十六轮（闪烁根因 + "点不出光标"根因）：
               * `posAtCoords` 会把**图片正下方**的点击也映射到"源码范围 ±1"（PM 把那里算作末尾/边界），
               * 于是"点下方空白"被误当成"点图片" ⇒ 记 `pendingClick` + `preventDefault()`：
               *   * `mouseup` 又执行一次**激活**（可见状态改变）⇒ 一次手势 **两次可见跃迁** = 闪烁；
               *   * 被 `preventDefault` 吃掉的那一击，PM 内建的"点最后一块下方 ⇒ 末尾补段落"再也没机会跑
               *     ⇒ 用户"点不出光标、无法输入"。
               * 收窄为：**点击必须落在图片自身矩形内**（±2px）才算点图片；否则一律放行（返回 false），
               * 让 PM/浏览器按自己的规则处理（正文点击、末尾补段落、拖选…）。
               */
              const inside = (el: HTMLElement | null): boolean => {
                if (!el) return false
                const r = el.getBoundingClientRect()
                return (
                  event.clientX >= r.left - 2 &&
                  event.clientX <= r.right + 2 &&
                  event.clientY >= r.top - 2 &&
                  event.clientY <= r.bottom + 2
                )
              }
              let imgEl: HTMLElement | null = null
              if (hit.kind === 'raw') {
                imgEl = view.dom.querySelector(
                  `[data-img-widget][data-img-from="${hit.from}"]`
                ) as HTMLElement | null
              } else {
                try {
                  const dom = view.nodeDOM(hit.from)
                  imgEl =
                    dom && dom.nodeType === 1
                      ? (dom as HTMLElement)
                      : ((dom?.parentElement as HTMLElement | null) ?? null)
                } catch {
                  imgEl = null
                }
              }
              if (!inside(imgEl)) return false
              setPending(hit.kind, hit.from, event.clientX, event.clientY)
              event.preventDefault()
              return true
            },
            mouseup(view, event) {
              const pending = pendingClick
              clearPending()
              if (!pending) return false
              /**
               * 第九十四轮（用户报障："**从后往前拖**，松开鼠标后选区丢了"）：真因是**这里**——
               * 之前对"按下落在图片源码范围内"的这一击**无条件**做激活收尾（把光标按回 `from`），
               * 于是一路拖出来的选区被这一下收成光标（实测：`{from:109,to:109,empty:true}`，
               * 而 `movedFar=true` ⇒ 明明拖动过）。现在按"**指针是否真的拖动过**"分流：
               * 位移 >10px 一律**不接管**（不激活、也不动选区），PM 拖出来的选区原样保留；
               * 只有真正的单击（≤10px）才走激活/收尾 ⇒ 第四十五轮"单击落光标"口径不受影响。
               */
              const movedFar =
                Math.abs(event.clientX - pending.x) > 10 || Math.abs(event.clientY - pending.y) > 10
              if (movedFar) return false
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
            if ((img.kind === 'node' || at?.type.name === 'htmlBlock') && !livePending()) {
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
          const ro = new ResizeObserver(() => {
            sync()
            scheduleOverlay(editorView)
            /** 第一百二十一轮：布局变了 ⇒ 落定态的带要按新几何重画（`settledKey` 只挡"输入没变"） */
            settledKey = null
            if (boxDrag == null) {
              try {
                paintSettledSel(editorView)
              } catch {
                clearSelBands(editorView)
              }
            }
          })
          ro.observe(editorView.dom)
          const onScroll = (): void => {
            sync()
            scheduleOverlay(editorView)
          }
          editorView.dom.addEventListener('scroll', onScroll, true)
          const onResize = (): void => {
            scheduleOverlay(editorView)
            settledKey = null
            if (boxDrag == null) {
              try {
                paintSettledSel(editorView)
              } catch {
                clearSelBands(editorView)
              }
            }
          }
          window.addEventListener('resize', onResize)
          /**
           * 第七十三轮：`pendingClick` 的清理钩子（诊断锚挂在 `view.dom` 的 `data-img-pending`）。
           * 覆盖"按下之后再也等不到 mouseup"的所有常见路径：失焦、页面隐藏、开始打字
           * （keydown ⇒ 已经不是点击了）、指针取消/离开、以及**下一次按下**开始时重置。
           */
          pendingDom = editorView.dom
          const onBlur = (): void => clearPending()
          const onVis = (): void => {
            if (document.visibilityState !== 'visible') clearPending()
          }
          const onKey = (): void => clearPending()
          const onCancel = (): void => clearPending()
          window.addEventListener('blur', onBlur)
          document.addEventListener('visibilitychange', onVis)
          window.addEventListener('keydown', onKey, true)
          editorView.dom.addEventListener('pointercancel', onCancel, true)
          editorView.dom.addEventListener('mouseleave', onCancel, true)
          /**
           * 第九十六轮（用户真实手势）：**在"最后一块右侧的空白"按下并往左拖**时，
           * PM 只会一路落光标、**不会建立选区**（实测：7 次事务全是 `empty:true`，
           * 位置 136→109 逐个落点）。这里自己起一个"空白拖选"：
           *   * `mousedown` 命中"最后一块的**行内**范围内、且位置贴住该块末尾、且不在图片本体上"
           *     ⇒ 记下锚点 = 该块末尾的文本位置；
           *   * `mousemove`（按住左键）⇒ 用 `posAtCoords` 取当前位置，把选区设成
           *     `[min(锚点, 当前), max(...)]` ⇒ 与 Typora 一样能拖出选区；
           *   * `mouseup` ⇒ 结束（单击情形照旧交给第四十五轮的"单击落光标"）。
           * 监听器挂在 `view.dom` 的**冒泡阶段、PM 之后注册** ⇒ 每次移动都**覆盖**PM 落下的光标。
           */
          let blankAnchor: number | null = null
          let blankTarget = 0
          let blankRaf: number | null = null
          /**
           * 第九十七轮（parent 授权）：把"**落在无文字的那条 y 上**"的坐标映射到**最近的有文字位置**。
           * 策略：先原位试；不落在"非空文本块"上时，**沿 y 向上优先、再向下**按 4px 步长探测
           * （上限 200px），取首个落在非空文本块上的位置。⇒ **起点本身有文字时行为完全不变**。
           * 返回 `{ pos, dy, mapped }`（`dy` = 相对原 y 的偏移，`mapped` = 是否做过探测映射）。
           */
          const posNearText = (
            x: number,
            y: number
          ): { pos: number; dy: number; mapped: boolean } | null => {
            /**
             * 第九十八轮：**"有文字"改由浏览器原生点位取节点判定**。
             * 旧判据 `resolve(pos).parent.isTextblock && content.size>0` 太粗 —— 段落本身就是非空
             * 文本块 ⇒ 在任何 y（含图片那条空行）都判"有文字" ⇒ `mapped` 永远是 false（上一轮的红）。
             * 现在：`document.caretRangeFromPoint(x,y)`（Safari 用 `caretPositionFromPoint`）取该点下的
             * 节点，**只有它是非空文本节点**才算"有文字"；否则进入下面的 y 探测。
             */
            const hasTextAt = (xx: number, yy: number): boolean => {
              try {
                const d = document as Document & {
                  caretRangeFromPoint?: (px: number, py: number) => Range | null
                  caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node } | null
                }
                const cr = d.caretRangeFromPoint?.(xx, yy)
                if (cr) {
                  return (
                    cr.startContainer.nodeType === 3 &&
                    (cr.startContainer.textContent ?? '').length > 0
                  )
                }
                const cp = d.caretPositionFromPoint?.(xx, yy)
                if (cp) {
                  return (
                    cp.offsetNode.nodeType === 3 && (cp.offsetNode.textContent ?? '').length > 0
                  )
                }
              } catch {
                /* 取不到就按"没有文字"处理 ⇒ 走探测 */
              }
              return false
            }
            const probe = (yy: number): { pos: number; ok: boolean } | null => {
              const at = editorView.posAtCoords({ left: x, top: yy })
              if (!at) return null
              return { pos: at.pos, ok: hasTextAt(x, yy) }
            }
            const here = probe(y)
            if (here && here.ok) return { pos: here.pos, dy: 0, mapped: false }
            for (let d = 4; d <= 200; d += 4) {
              const up = probe(y - d)
              if (up && up.ok) return { pos: up.pos, dy: -d, mapped: true }
              const down = probe(y + d)
              if (down && down.ok) return { pos: down.pos, dy: d, mapped: true }
            }
            return here ? { pos: here.pos, dy: 0, mapped: false } : null
          }
          const onDownBlank = (event: MouseEvent): void => {
            if (event.button !== 0) return
            const target = event.target as HTMLElement | null
            if (
              target?.closest?.('[data-img-widget]') ||
              target?.closest?.('[data-img-revealed]') ||
              target?.closest?.('img')
            ) {
              return
            }
            const hit = posNearText(event.clientX, event.clientY)
            if (!hit) return
            const doc = editorView.state.doc
            if (doc.childCount === 0) return
            const last = doc.child(doc.childCount - 1)
            const lastFrom = doc.content.size - last.nodeSize
            let rect: DOMRect | null = null
            try {
              const dom = editorView.nodeDOM(lastFrom)
              const el =
                dom && dom.nodeType === 1 ? (dom as HTMLElement) : (dom?.parentElement ?? null)
              rect = el ? el.getBoundingClientRect() : null
            } catch {
              rect = null
            }
            if (!rect) return
            if (event.clientY < rect.top - 2 || event.clientY > rect.bottom + 2) return
            // ⚠️ 第九十七轮：**只在"按下点确实没有文字"（`mapped===true`）时才接管** ——
            //    起点本身有文字时（普通拖选）一律不碰，避免把 ⑰③/⑰④ 那类正文拖选抢过来。
            if (!hit.mapped) return
            /**
             * 第一百轮：锚点取**原生位置**（按下点在图片右侧空白时它 = 该块末尾，通常正好是
             * `img.to`）——只有它才可能让"选区覆盖整个源码范围"成立；`hit.pos` 是**向上探测到
             * 的最近文字位置**（在源码内部），拿它当锚点会导致 `sel.to < img.to` ⇒ `covers:false`。
             * 探测只用于**拖动过程中的目标位置**。
             */
            const raw = editorView.posAtCoords({ left: event.clientX, top: event.clientY })
            blankAnchor = Math.max(hit.pos, raw ? raw.pos : hit.pos)
            blankTarget = blankAnchor
          }
          /**
           * 第一百轮：**rAF 看门狗**。第九十七～九十九轮实测：我在 `mousemove` 里建立的区间会被
           * PM 的 document 级处理紧跟其后收成光标（两次连跑结果不一致 ⇒ 偶发）。
           * 看门狗在 `blankAnchor != null` 期间**每帧**把选区重新断言成 `[锚点, 目标位置]`；
           * 只在"目标区间 ≠ 当前区间"时才 dispatch（不做无条件写，避免事务噪声）。
           */
          const watchBlank = (): void => {
            blankRaf = null
            if (blankAnchor == null) return
            const from = Math.min(blankAnchor, blankTarget)
            const to = Math.max(blankAnchor, blankTarget)
            const cur = editorView.state.selection
            if (cur.from !== from || cur.to !== to || cur.empty) {
              try {
                editorView.dispatch(
                  editorView.state.tr.setSelection(
                    TextSelection.create(editorView.state.doc, from, to)
                  )
                )
              } catch {
                /* 位置非法（文档刚被改）⇒ 下一帧再试 */
              }
            }
            if (blankAnchor != null) blankRaf = window.requestAnimationFrame(watchBlank)
          }
          const onMoveBlank = (event: MouseEvent): void => {
            if (blankAnchor == null) return
            if (event.buttons !== 1) {
              blankAnchor = null
              return
            }
            /**
             * 第一百轮：拖动目标用 `posNearText`（**必须是文本节点**才取，否则沿 y 探测）。
             * ⚠️ 试过"原生 `posAtCoords` 当目标"⇒ **更差**：在图片那条空行上它对任何 x 都返回
             * **同一个块末尾位置** ⇒ `from==to` ⇒ 选区恒为空（实测 ㉛④ 由绿转红）。故保留探测版。
             */
            const hit = posNearText(event.clientX, event.clientY)
            if (hit) blankTarget = hit.pos
            if (blankRaf == null) blankRaf = window.requestAnimationFrame(watchBlank)
          }
          const onUpBlank = (): void => {
            blankAnchor = null
            if (blankRaf != null) {
              window.cancelAnimationFrame(blankRaf)
              blankRaf = null
            }
          }
          editorView.dom.addEventListener('mousedown', onDownBlank)
          // 第一百零四轮：**只看事件目标的 DOM 身份**（不碰坐标）——命中标识符文本就记下它的 from
          const onDragDown = (event: Event): void => {
            dragActive = true
            const target = event.target as HTMLElement | null
            const el = target?.closest?.('[data-img-revealed]') as HTMLElement | null
            const raw = el ? el.getAttribute('data-img-from') : null
            let inside = raw != null && raw !== '' ? Number(raw) : null
            /**
             * 第一百零八轮：按在"整行全高覆盖层里的**空白带**"上，也算**按在这一段源码上** ——
             * 空白带是图片/源码的一部分（见 `bandAt` 的说明）。否则 `dragging && dragInsideFrom == null`
             * 会按第七十五轮防闪口径把这段源码**在按住期间藏掉**，于是同一次按下里刚落的
             * "按列光标"会被 DOM 选区回读抹掉（实测：落的 285 在 60ms 后回退成 355）。
             */
            if (inside == null && event instanceof MouseEvent) {
              /**
               * 第一百一十二轮：判据由"只看空白带（`bandAt`）"扩成**"按在这一段可见源码的整行区域上"**
               * —— `bandAt` 只看"覆盖层行盒 − 片段盒"，于是**片段行盒自己的 padding 那几像素**
               * （源码行盒 354.08..386.27 与字形盒 359.67..380.67 之间）是个**缝**：
               * 既不算片段、也不算带 ⇒ `dragInsideFrom == null` ⇒ 按住那一瞬间
               * `dragging && dragInsideFrom == null` 按第七十五轮口径把它**藏掉一帧**再显示
               * （实测：`R(bgE) → -(open=null) → RE(bgO) → R(bgE)` 的 #1 帧就是它）。
               * 现在改用同一个"可见源码区域"判据：**覆盖层行盒 ∪ 片段行盒**命中即算按在这段上。
               */
              const band = bandAt(editorView, event.clientX, event.clientY)
              if (band) {
                const f = Number(band.el.getAttribute('data-img-from'))
                if (Number.isFinite(f)) inside = f
              } else {
                const f = revealedSourceFromAtPoint(editorView, event.clientX, event.clientY)
                if (f != null) inside = f
              }
            }
            dragInsideFrom = inside
            /**
             * 第一百一十一轮：**跨图片实体拖动**这一路（原生手势）的按下登记 —— 只记数字、不碰选区。
             * 带内按下（`inside != null` 且确实命中 band）时**不登记**：那一路由 `bandDrag` 接管
             * （它 preventDefault 了 mousedown，没有原生手势，落定方式不同）。
             */
            boxSettleTarget = null
            boxDrag = null
            if (event instanceof MouseEvent && !bandAt(editorView, event.clientX, event.clientY)) {
              const at = editorView.posAtCoords({ left: event.clientX, top: event.clientY })
              boxDrag = {
                pressPos: at ? at.pos : null,
                anchor: null,
                focus: null,
                anchorLost: false,
                lastLiveNear: null,
                lastLiveFar: null,
                hw: null,
                hwPx: 0,
                press: { x: event.clientX, y: event.clientY }
              }
            }
          }
          const onDragUp = (): void => {
            dragActive = false
            dragInsideFrom = null
            /**
             * 松手后**触发一次重算**（空事务）⇒ 立刻回到既有口径。
             *
             * ⚠️ 第一百零九轮修正（用户报障：「点击空白区域 / 点击源码会出现**背景颜色闪烁**」）：
             * 此前这里发的是**带 `KEY` meta 的空事务** `setMeta(KEY, { from })`，而 `apply` 的 meta
             * 分支会把 `editing` **强制**写成 `false`（`editing: !!meta.editing`）。于是当光标本来
             * 就在源码里（编辑态）时，这一下会把底色**重新点亮**，紧接着又被下一次选区事务切回编辑态
             * ⇒ 一帧内 `底色亮 → 灭` 的**回摆**。逐帧实测（点空白带）：`… editing+bg-off →（93ms）
             * revealed+bg →（110ms）editing+bg-off …`。
             * 现在改发**空事务**：`apply` 走"按当前选区重算"那条既有分支，`editing` 由 `caretInside`
             * 口径得出，不再被 meta 强改；`addToHistory: false` 免得往撤销栈里塞无意义的一步。
             */
            try {
              editorView.dispatch(
                editorView.state.tr
                  .setSelection(editorView.state.selection)
                  .setMeta('addToHistory', false)
              )
            } catch {
              /* 忽略：下一次选区事务会再算一遍 */
            }
          }
          window.addEventListener('mousedown', onDragDown, true)
          window.addEventListener('mouseup', onDragUp, true)
          window.addEventListener('pointercancel', onDragUp, true)
          window.addEventListener('blur', onDragUp)
          /**
           * ⚠️ 第九十七轮：`mousemove/mouseup` 挂在 **window**（冒泡链最后）—— PM 在拖动期间会在
           * **document** 级监听并落光标，挂在 `view.dom` 上会被它**之后**覆盖（实测：我的
           * `{136,137,empty:false}` 刚建立，紧接着就被 PM 的 `{136,136}` 收掉）。挂 window 才能最后落子。
           */
          window.addEventListener('mousemove', onMoveBlank)
          window.addEventListener('mouseup', onUpBlank, true)
          /**
           * 第一百一十轮：空白带拖动（与上面那套"最后一块右侧空白拖选"并列、互不干扰 ——
           * 那套只在 `blankAnchor != null` 时动作，而这套只在 `bandDrag != null` 时动作）。
           * 挂在 window 上：指针移出编辑器/移出窗口也能继续扩选，松手（或指针取消/失焦）即结束。
           */
          const onBandMove = (event: MouseEvent): void => {
            if (bandDrag) {
              if (event.buttons === 1) bandDragMove(editorView, event.clientX, event.clientY)
              return
            }
            /**
             * 第一百一十一轮：**跨图片实体拖动**这一路（原生手势）。
             * 拖动期**只记状态、一个字节都不落**（见 `boxDrag` 那段说明）：锚点在第一帧若还是空的
             * 说明原生锚点被死区吃掉了，用按下点兜底；focus 按"指针压在盒子哪一半"算。
             */
            if (!boxDrag || event.buttons !== 1) return
            const sel = editorView.state.selection
            if (boxDrag.anchor == null) {
              if (sel.empty && boxDrag.pressPos != null) {
                boxDrag.anchor = boxDrag.pressPos
                boxDrag.anchorLost = true
              } else {
                boxDrag.anchor = sel.anchor
              }
            }
            /**
             * 死区（原子盒）命中：见 `atomFocusAt`。**只在指针确实落在原子盒内**时才接管 focus；
             * 指针在盒外一律 `focus = null` ⇒ `boxDragRange` 退回原生映射（`state.selection.head`）
             * —— 于是"从公式/图片里往外拖"能继续按原生那条路扩选，不会被钉在盒子里。
             */
            const hitEdge = atomFocusAt(editorView, event.clientX, event.clientY, boxDrag.anchor)
            boxDrag.focus = hitEdge
            // 诊断锚（与 `data-img-open` 同一用途）：套件可以直接断言"助手有没有认出指针压在原子盒上"
            editorView.dom.setAttribute(
              'data-img-drag-edge',
              hitEdge == null ? '' : String(hitEdge)
            )
            /**
             * 第一百一十三轮（P1）：同一帧里把"试探区间"画出来（文字走 CSS Highlight、图片加既有
             * `img-selected`）——**仍然零 dispatch**。这样"按下并拖动"就有即时观感，不必等松手。
             */
            boxDragLive(editorView, event.clientX, event.clientY)
          }
          const onBandUp = (): void => {
            bandDrag = null
            /**
             * 第一百二十六轮诊断锚（用户报障：跨表格/公式/图片拖动，松手后丢一部分）：
             * 落定的**输入**逐项落到 DOM 上，供逐帧取证（`boxDrag` 是否在、锚点/高水位/远端/区间）。
             */
            const dbgIn = (bd: typeof boxDrag, extra: string): void => {
              try {
                editorView.dom.setAttribute(
                  'data-img-settle-in',
                  `${bd ? `${bd.anchor}|${bd.hw}|${bd.focus}|${bd.anchorLost ? 1 : 0}` : 'nodrag'}|${extra}`
                )
              } catch {
                /* 忽略 */
              }
            }
            /**
             * 第一百一十一轮：松手（或指针取消/失焦）时把"跨图片实体"那一路落定 ——
             * 仍然是**唯一一处**落定 + 有界复验（`boxDragSettle`），拖动期没落过任何子。
             */
            if (!boxDrag) {
              dbgIn(
                null,
                `nodrag|sel${editorView.state.selection.from}-${editorView.state.selection.to}`
              )
              clearLiveSel(editorView)
              return
            }
            const bd = boxDrag
            boxDrag = null
            const anchor = bd.anchor
            /**
             * ─── 第一百二十七轮（用户报障 1：松手后的选区必须与拖动期一致）────────────────────
             * 落定的边界**只取"画面上那一份"**（`lastLiveNear`/`lastLiveFar`）并上**锚点**与**落点**；
             * **不再取 `hw`、也不再取模型里的 `selection.head`**。
             *
             * 为什么不能用那两个（逐帧实测，两类都踩到了）：
             * ① **`hw` 是整段手势的最大值**：用户拖到最远又拖回来时，画面（`[60,409]`）比 `hw`
             *    （`[11,409]`）窄得多，只按 `hw` 落定就会**多选 49 个位置**
             *    （实测 W2：`live 60-409` vs `settled 11-409`）⇒ "本不该选中却被选中"。
             * ② **`selection.head` 是 PM 的**模型**值，会**晚于画面**推进**：PM 的 `DOMObserver` 是
             *    ~20ms 的定时器，松手那一瞬它刚把 DOM 选区读回来 ⇒ 读到的是**没画过的**位置
             *    （逐帧实测 I2：画面 `94-401`，落定输入读到的 `selection.head` 已是 **408**、
             *    锚点记录 `94|401` ⇒ 落定成了 `94-408`，比画面多 7 个位置；W1 同形 `402→409`）。
             *    注意：**"松手点比最后一帧更远"这条既有口径并没有丢** —— `lastLiveFar` 取的是
             *    **试探区间 ∪ 原生 DOM 区间**（`paintLiveSel` 里那个并集），而画面上画的就是这个并集，
             *    所以"画面 ⊆ 落定"依旧成立；实测 A=[118,355] 不变（见本轮报告）。
             * 取"画面那一份"之后：**落定 ⊇ 画面**（看到的一定被选中），且
             * **落定 ⊆ 画面 ∪ 锚点 ∪ 落点**（绝不会突然多出一段没画过的）⇒ 双向差集收敛到
             * "锚点/落点并入"的那 ≤2 位。
             */
            const focus =
              bd.focus ??
              (bd.anchorLost && editorView.state.selection.empty
                ? editorView.state.selection.head
                : null)
            const cands: number[] = []
            if (bd.lastLiveNear != null && bd.lastLiveFar != null) {
              cands.push(bd.lastLiveNear, bd.lastLiveFar)
            }
            if (anchor != null) cands.push(anchor)
            if (focus != null) cands.push(focus)
            const sFrom = cands.length ? Math.min(...cands) : null
            const sTo = cands.length ? Math.max(...cands) : null
            /**
             * 落点也要"画得到"：落定前把试探区间扩到同一个极值并**重画一帧**，否则会出现
             * "落定比画面宽、而那一帧的画面上什么都没有"的观感断层（用户第②条：按松手后的样式做）。
             */
            if (sFrom != null && sTo != null && sTo > sFrom) {
              paintLiveSel(editorView, sFrom, sTo)
            }
            if (sFrom == null || sTo == null || sFrom === sTo) {
              // 没有要落定的东西 ⇒ 立刻清干净（别把临时绘制留在文档上）
              dbgIn(
                bd,
                `empty-target|far${bd.hw}|focus${focus}|sel${editorView.state.selection.from}-${editorView.state.selection.to}`
              )
              clearLiveSel(editorView)
              return
            }
            dbgIn(bd, `target${sFrom}-${sTo}|far${bd.hw}|focus${focus}`)
            boxSettleTarget = { from: sFrom, to: sTo }
            boxSettleFails = 0
            editorView.dom.removeAttribute('data-img-settle-fallback')
            boxDragSettle(editorView)
          }
          window.addEventListener('mousemove', onBandMove)
          window.addEventListener('mouseup', onBandUp, true)
          window.addEventListener('pointercancel', onBandUp, true)
          window.addEventListener('blur', onBandUp)
          return {
            update: () => {
              try {
                sync()
              } catch {
                /* 定位失败不该影响编辑：下一次 update 会再算一遍 */
              }
              /**
               * 第一百零九轮：**摘层要同步**，画层才逐帧合并。
               * 进入编辑态/隐藏时那一帧就把覆盖层撤掉（纯 DOM 摘除、零测量），否则"底色已经撤了、
               * 灰带还多留一帧"本身也是一次可见闪动（逐帧实测：编辑态那一帧覆盖层仍为 2）。
               * 需要**测量**的重算照旧 `scheduleOverlay`（逐帧合并，避免布局抖动）。
               */
              if (!hasOverlayTarget(editorView)) dropOverlay()
              else scheduleOverlay(editorView)
              /**
               * 第一百一十三轮（P1）：拖动期的临时绘制要**跟着 PM 的事务重画**。
               * 真因实测：原生拖动本身每帧都在落光标（PM 事务）⇒ widget 由 `toDOM` **重建** ⇒ 我们
               * 刚加的 `img-selected` 连同元素一起消失，下一帧再加回来 ⇒ 逐帧
               * `img1[254] → img0[] → img1[254]`（肉眼就是"选中样式在闪"）。
               * 这里在 `update`（PM 重建之后）按同一份试探区间重画一次：文字走 Highlight、图片补类。
               *
               * ⚠️ 第一百一十六轮（收口）：**只在"指针还按着"（`boxDrag != null`）时重画**。
               * 松手后这一段重画窗口会一直写到落定复验结束（旧版固定 40 帧 ≈650ms），期间持续改
               * widget 的类/Highlight ⇒ 与套件里"程序化覆盖后再断言类与样式"的步骤抢时序（实测多出
               * ㉛④ / ㉜① 的**旋转红**）。松手之后一律交给 `boxDragSettle` 的清理路径决定。
               */
              if (boxDrag != null && liveRange.from >= 0 && liveRange.to > liveRange.from) {
                paintLiveSel(editorView, liveRange.from, liveRange.to)
              } else if (boxDrag == null) {
                /**
                 * 第一百二十一轮：**落定态**也要画一帧 —— 行内公式那几段由我们的选中带接管
                 *（浏览器对公式片段画的是 KaTeX 内层 inline-block 的盒子：实测 15px，同行正文
                 * 143.25px ⇒ 用户第①条）。`paintSettledSel` 自带"同 from/to/doc 就跳过"的判据，
                 * 所以这里不必再包一层。异常一律吞掉：画不出来就撤闸退回浏览器绘制。
                 */
                try {
                  paintSettledSel(editorView)
                } catch {
                  clearSelBands(editorView)
                }
              }
            },
            destroy: () => {
              ro.disconnect()
              editorView.dom.removeEventListener('scroll', onScroll, true)
              window.removeEventListener('resize', onResize)
              window.removeEventListener('blur', onBlur)
              document.removeEventListener('visibilitychange', onVis)
              window.removeEventListener('keydown', onKey, true)
              editorView.dom.removeEventListener('pointercancel', onCancel, true)
              editorView.dom.removeEventListener('mouseleave', onCancel, true)
              editorView.dom.removeEventListener('mousedown', onDownBlank)
              window.removeEventListener('mousedown', onDragDown, true)
              window.removeEventListener('mouseup', onDragUp, true)
              window.removeEventListener('pointercancel', onDragUp, true)
              window.removeEventListener('blur', onDragUp)
              window.removeEventListener('mousemove', onMoveBlank)
              window.removeEventListener('mouseup', onUpBlank, true)
              window.removeEventListener('mousemove', onBandMove)
              window.removeEventListener('mouseup', onBandUp, true)
              window.removeEventListener('pointercancel', onBandUp, true)
              window.removeEventListener('blur', onBandUp)
              bandDrag = null
              boxDrag = null
              boxSettleTarget = null
              clearLiveSel(null)
              clearSelBands(editorView)
              if (boxSettleRaf != null) {
                window.cancelAnimationFrame(boxSettleRaf)
                boxSettleRaf = null
              }
              editorView.dom.removeAttribute('data-img-drag-edge')
              if (pendingDom === editorView.dom) pendingDom = null
              clearPending()
              hideBar()
              if (overlayRaf != null) {
                window.cancelAnimationFrame(overlayRaf)
                overlayRaf = null
              }
              dropOverlay()
            }
          }
        }
      })
    ]
  }
})
