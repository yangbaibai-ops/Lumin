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

/** 这段文本是不是"整段就是一个 `<img …>`" */
export function isRawImgHtml(text: string): boolean {
  return RAW_IMG_RE.test(text.trim())
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
      if (!isRawImgHtml(source)) return false
      out.push({
        kind: 'raw',
        from: pos,
        to: pos + node.nodeSize,
        src: rawHtmlAttr(source, 'src') ?? '',
        alt: rawHtmlAttr(source, 'alt') ?? '',
        zoom: zoomOfStyle(rawHtmlAttr(source, 'style')),
        markdown: source
      })
      return false
    }
    if (node.isText && isRawImgHtml(node.text ?? '')) {
      const raw = (node.text ?? '').trim()
      out.push({
        kind: 'raw',
        from: pos,
        to: pos + node.nodeSize,
        src: rawHtmlAttr(raw, 'src') ?? '',
        alt: rawHtmlAttr(raw, 'alt') ?? '',
        zoom: zoomOfStyle(rawHtmlAttr(raw, 'style')),
        markdown: raw
      })
      return false
    }
    return true
  })
  return out.sort((a, b) => a.from - b.from)
}

const KEY = new PluginKey<{ from: number | null }>('luminImageSource')

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

/** 点档位：节点形式 → 改成原文；原文形式 → **原地**改 style 里的 zoom（绝不新增第二个 `<img>`） */
export function applyZoom(view: EditorView, img: ImgSource, zoom: number, open: boolean): void {
  if (img.kind === 'raw') {
    if (view.state.doc.nodeAt(img.from)?.type.name === 'htmlBlock') {
      // 块级 HTML 形态：原地改 `source` 属性（文档里仍然只有一个 `<img>`）
      const node = view.state.doc.nodeAt(img.from)
      const source = String(node?.attrs.source ?? '')
      view.dispatch(
        view.state.tr.setNodeMarkup(img.from, undefined, {
          ...node?.attrs,
          source: withZoomInRaw(source, zoom)
        })
      )
    } else {
      const raw = view.state.doc.textBetween(img.from, img.to, '')
      replaceRaw(view, img, withZoomInRaw(raw, zoom))
    }
  } else {
    nodeToRaw(view, img, zoom)
  }
  // 换完之后把"打开"状态挪到新的范围上（长度可能变了），否则工具栏会立刻消失
  requestAnimationFrame(() => {
    const next = collectImgSources(view.state).find((i) => i.src === img.src)
    if (next) view.dispatch(view.state.tr.setMeta(KEY, { from: open ? next.from : null }))
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

/** 悬浮工具栏：定位在源码行**上方**（两者矩形不相交），右对齐 */
function placeToolbar(view: EditorView, bar: HTMLElement, srcLine: HTMLElement | null): void {
  const anchor = srcLine ?? view.dom
  const r = anchor.getBoundingClientRect()
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
    /** 源码行浮层（第五十六轮：挂在 `view.dom.parentElement` 上，**不在**编辑器 DOM 里） */
    let srcLine: HTMLElement | null = null
    /** 提交时需要的视图：由下面插件 `view()` 里赋值 */
    let pluginView: EditorView | null = null
    /** 正在编辑的位置与内容：只在"同一张图"上恢复，换图（或文档被换掉）一律重置 */
    let editingAt: number | null = null
    let editingText = ''
    /** 上一次同步时源码行对着哪张图（换了就重置编辑态，免得把上一张的输入当成这一张的） */
    let syncedFrom: number | null = null

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
    const ensureSrcLine = (view: EditorView): HTMLElement => {
      if (srcLine && srcLine.isConnected) return srcLine
      const line = document.createElement('div')
      line.className = 'img-src-line img-src-line--overlay'
      line.setAttribute('data-img-source', '')
      line.setAttribute('contenteditable', 'false')
      // 第五十八轮用户口径：**不许有拼写检查的红波浪线**（截图里那排波浪线就是它）
      line.setAttribute('spellcheck', 'false')
      line.setAttribute('autocorrect', 'off')
      line.setAttribute('autocapitalize', 'off')
      const input = document.createElement('textarea')
      input.className = 'img-src-line__input'
      input.setAttribute('data-img-source-input', '')
      input.setAttribute('spellcheck', 'false')
      input.setAttribute('autocorrect', 'off')
      input.setAttribute('autocapitalize', 'off')
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('data-gramm', 'false')
      input.setAttribute('wrap', 'off')
      input.setAttribute('rows', '1')
      const cur = (): ImgSource | null => {
        const v = pluginView
        if (!v) return null
        const all = collectImgSources(v.state)
        const at = KEY.getState(v.state)?.from ?? null
        return (
          (at == null ? null : (all.find((i) => i.from === at) ?? null)) ??
          (editingAt == null ? null : (all.find((i) => i.from === editingAt) ?? null))
        )
      }
      const orig = (): string => cur()?.markdown ?? ''
      const commit = (): void => {
        const v = pluginView
        if (!v) return
        const target = cur()
        if (!target) return
        const ok = safeCommit(v, line, target, input.value, orig())
        if (ok) {
          editingAt = null
          editingText = ''
          input.classList.remove('is-invalid')
        }
      }
      input.addEventListener('input', () => {
        editingAt = KEY.getState(view.state)?.from ?? null
        editingText = input.value
        input.classList.remove('is-invalid')
      })
      input.addEventListener('keydown', (e) => {
        // 浮层不在编辑器 DOM 里，但仍然别把按键漏给编辑器的快捷键
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          editingAt = null
          editingText = ''
          input.value = orig()
          input.classList.remove('is-invalid')
          input.blur()
          view.dispatch(view.state.tr.setMeta(KEY, { from: null }))
        }
      })
      input.addEventListener('blur', () => {
        if (input.classList.contains('is-invalid')) return
        if (input.value.trim() === orig().trim()) return
        commit()
      })
      line.appendChild(input)
      ;(view.dom.parentElement ?? document.body).appendChild(line)
      srcLine = line
      return line
    }

    const hideSrcLine = (): void => {
      if (srcLine) srcLine.remove()
      srcLine = null
    }

    /** 提交一次：非法/异常 ⇒ 不动文档 + 红边 + 还原原值（文档永远不许被写坏） */
    const safeCommit = (
      view: EditorView,
      line: HTMLElement,
      img: ImgSource,
      text: string,
      original: string
    ): boolean => {
      const input = line.querySelector<HTMLTextAreaElement>('[data-img-source-input]')
      try {
        const ok = commitImgSource(view, img, text)
        line.setAttribute('data-img-commit', ok ? 'ok' : 'bad-parse')
        if (!ok && input) {
          input.classList.add('is-invalid')
          input.value = original
        }
        return ok
      } catch (err) {
        line.setAttribute('data-img-commit', 'error')
        line.setAttribute('data-img-commit-msg', String((err as Error)?.message).slice(0, 120))
        if (input) {
          input.classList.add('is-invalid')
          input.value = original
        }
        return false
      }
    }

    return [
      new Plugin<{ from: number | null }>({
        key: KEY,
        state: {
          init: () => ({ from: null }),
          apply(tr, value, _old, next) {
            const meta = tr.getMeta(KEY) as { from: number | null } | undefined
            if (meta) return { from: meta.from }
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
            if (keep && revealDecision(selLike, keep) === 'show') return { from: keep.from }
            for (const i of imgs) {
              if (revealDecision(selLike, i) === 'show') return { from: i.from }
            }
            return { from: null }
          }
        },
        props: {
          decorations(state) {
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
                // 原文本身就是标记字符：平时隐藏（内容仍在文档里，保存逐字节不变）
                //  * 行内文本形态用 inline 装饰；
                //  * 块级 HtmlBlock 形态（独立一行的 `<img …>`）用 node 装饰
                const isBlock = state.doc.nodeAt(img.from)?.type.name === 'htmlBlock'
                decos.push(
                  isBlock
                    ? Decoration.node(img.from, img.to, { class: 'img-src-marker-hidden' })
                    : Decoration.inline(img.from, img.to, { class: 'img-src-marker-hidden' })
                )
                // 在同一位置画真图（缩放按源码里的 style）。
                // ⚠️ 第五十五轮：**行内上下文里保持行内** —— `文字 <img> 文字` 不许拆行。
                //    判据：这段原文是行内文本、且它所在的段落里还有别的**非空**内容
                //    ⇒ 用 inline-block 随文字流动；否则（独占一行）才按块级居中。
                const inline = imgIsInline(state, img)
                decos.push(
                  Decoration.widget(
                    img.from,
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
                    { side: -1 }
                  )
                )
              }
            }
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
              // 点图片 = 选中它（= "点开"这一步）；选区落在构造上，判据自然给出"显示"
              const img = collectImgSources(view.state).find((i) => i.from === from)
              if (!img) return false
              const sel = TextSelection.create(view.state.doc, Math.min(img.from + 1, img.to))
              view.dispatch(view.state.tr.setSelection(sel).setMeta(KEY, { from: img.from }))
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
          pluginView = editorView
          /**
           * ─── 源码行 = **编辑器 DOM 之外的浮层**（第五十六轮）────────────────────────
           *
           * 为什么不能继续做 widget：源码行里是 `<textarea>`，Chromium 会把它的 value 镜像成
           * 一个子文本节点 ⇒ 在 PM 眼里那是编辑器 DOM 里的一次变更 ⇒ **重绘 widget**，
           * 用户正在编辑的那份 DOM 被换掉（实测：新 URL 在提交前被还原，改 URL 静默失效）。
           * 搬出来之后这块 DOM 完全不在 `view.dom` 里，PM 的 DOM 观察者看不到任何东西
           * —— 编辑不再丢字、也不再需要"重绘后恢复"那套补丁。
           *
           * 定位与工具栏**同一套逻辑**：都挂在 `view.dom.parentElement`（编辑器滚动容器）上，
           * 用绝对定位按"图片矩形"现量摆放：源码行贴图片上沿，工具栏再贴源码行上沿。
           * 因为它只是视图层的 DOM，**永远不会进入 Markdown**（导出/复制/往返都不带它）。
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
            return w ? w.getBoundingClientRect() : null
          }
          /**
           * 摆放标记浮层（第五十八轮口径）：
           *   * **与图片同一行**（行内混排）⇒ 标记**贴该行顶部**（`top` 对齐图片 `top`），
           *     不做"贴图片上沿"那种上移 —— 用户口径是"在顶部而非和图片居中"；
           *   * 独占一行（块级图片）⇒ 仍旧贴在图片**上方**（不遮住图片本身）。
           */
          const placeSrcLine = (
            line: HTMLElement,
            rect: DOMRect,
            base: DOMRect,
            inline: boolean
          ): void => {
            const top = inline ? rect.top - base.top : rect.top - base.top - line.offsetHeight - 4
            line.style.top = `${Math.round(top)}px`
            line.style.left = `${Math.round(rect.left - base.left)}px`
            line.style.width = `${Math.round(rect.width)}px`
            line.classList.toggle('img-src-line--top', inline)
            line.setAttribute('data-img-align', inline ? 'top' : 'above')
          }
          const sync = (): void => {
            const open = KEY.getState(editorView.state)?.from ?? null
            const imgs = collectImgSources(editorView.state)
            const img = open == null ? null : (imgs.find((i) => i.from === open) ?? null)
            if (!img) {
              hideSrcLine()
              hideBar()
              return
            }
            const rect = imgRectOf(img)
            if (!rect) {
              hideSrcLine()
              hideBar()
              return
            }
            const line = ensureSrcLine(editorView)
            // 换了一张图（或文档整个换了）⇒ 编辑态重置，别把上一张的输入带过来
            if (syncedFrom !== img.from) {
              syncedFrom = img.from
              editingAt = null
              editingText = ''
            }
            const base = (line.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? null
            placeSrcLine(
              line,
              rect,
              base ?? ({ left: 0, top: 0 } as DOMRect),
              imgIsInline(editorView.state, img)
            )
            // 内容与状态每次同步都刷新（位置/缩放/形态变化后都要对）
            // 排版口径**跟正文一模一样**（`.md-marker` 一族）：浮层在编辑器 DOM 之外，
            // 天生继承不到 `.ProseMirror` 的字号/字族，所以直接把正文的 computed 抄过来。
            const bodyCs = getComputedStyle(editorView.dom)
            line.style.fontSize = bodyCs.fontSize
            line.style.fontFamily = bodyCs.fontFamily
            const ta = line.querySelector<HTMLTextAreaElement>('[data-img-source-input]')
            if (ta) {
              const resumed = editingAt === img.from
              const want = resumed ? editingText : img.markdown
              if (ta.value !== want) ta.value = want
              line.setAttribute('data-img-kind', img.kind)
              line.setAttribute('data-img-zoom', String(img.zoom ?? 100))
              line.setAttribute('data-img-text', img.markdown)
            }
            const el = ensureBar(editorView)
            placeToolbar(editorView, el, line)
            const active = img.zoom ?? 100
            for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-img-zoom]'))) {
              const pct = Number(b.getAttribute('data-img-zoom'))
              b.classList.toggle('is-active', pct === active)
              b.setAttribute('aria-pressed', pct === active ? 'true' : 'false')
              b.title = i18n.global.t('editor.imageZoom', { pct })
            }
          }
          // 装饰变化 / 滚动 / 尺寸变化都可能要挪浮层；update 里**同步**做一次
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
              hideSrcLine()
            }
          }
        }
      })
    ]
  }
})
