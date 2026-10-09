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
  const left = Math.max(2, r.right - base.left - w)
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
            const open = KEY.getState(state)?.from ?? null
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
                // 在同一位置画真图（缩放按源码里的 style）
                decos.push(
                  Decoration.widget(
                    img.from,
                    () => {
                      const span = document.createElement('span')
                      span.className = 'img-widget'
                      span.setAttribute('data-img-widget', '')
                      span.setAttribute('data-img-from', String(img.from))
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
              if (img.from !== open) continue
              // 源码行：只读 + 可复制（上方一块；用 data-* 语义锚点给套件定位）
              decos.push(
                Decoration.widget(
                  img.from,
                  () => {
                    const line = document.createElement('div')
                    line.className = 'img-src-line'
                    line.setAttribute('data-img-source', '')
                    line.setAttribute('data-img-kind', img.kind)
                    line.setAttribute('data-img-zoom', String(img.zoom ?? 100))
                    line.setAttribute('contenteditable', 'false')
                    line.textContent = img.markdown
                    return line
                  },
                  { side: -2 }
                )
              )
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
          const sync = (): void => {
            /**
             * 工具栏的可见性**由源码行的存在决定**（而不是由插件里那个位置值决定）：
             * 位置在编辑过程中会漂（缩放把 `![alt](src)` 换成 `<img …>` 时长度就变了），
             * 只要"位置对不上任何图片"，源码行就不渲染了 —— 那时工具栏必须一起消失，
             * 否则会留下一个没有源码行可依附的孤儿浮层。
             */
            const line = editorView.dom.querySelector('[data-img-source]') as HTMLElement | null
            if (!line) {
              hideBar()
              return
            }
            const open = KEY.getState(editorView.state)?.from ?? null
            const el = ensureBar(editorView)
            placeToolbar(editorView, el, line)
            const img = collectImgSources(editorView.state).find((i) => i.from === open)
            const active = img?.zoom ?? 100
            for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-img-zoom]'))) {
              const pct = Number(b.getAttribute('data-img-zoom'))
              b.classList.toggle('is-active', pct === active)
              b.setAttribute('aria-pressed', pct === active ? 'true' : 'false')
              b.title = i18n.global.t('editor.imageZoom', { pct })
            }
          }
          // 装饰变化 / 滚动 / 尺寸变化都可能要挪工具栏；update 里**同步**做一次
          // （放进 rAF 会留下一帧的孤儿窗口期：源码行已经没了、工具栏还在）
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
