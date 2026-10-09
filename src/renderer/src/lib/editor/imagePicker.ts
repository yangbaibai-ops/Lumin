/**
 * **`![]()` 的纯渲染选图按钮**（第四十八～五十一轮）。
 *
 * 口径（用户/父任务拍板）：
 *   * 文档里出现**字面** `![]()`（alt 与 URL 都空）⇒ 在 `(` 与 `)` 之间渲染一个按钮；
 *   * **文档内容逐字节仍是 `![]()`** —— 按钮是 `Decoration.widget`，纯渲染、零污染；
 *   * 括号里一旦有任意字符（`![](x)`）⇒ 该 widget **不再产出**（装饰按文本重算，自然消失）；
 *   * 点按钮 ⇒ `<input type="file" accept="image/*">`（渲染层，零新 IPC）⇒ 选中后走既有
 *     `lib/insertImage.ts` 的 `insertImageFromBytes` 落盘，再把那段 `![]()` 换成图片节点；
 *   * `stopEvent` 只吃**按钮自身**的 mousedown/click；`ignoreSelection` 让光标能在该位置落住；
 *     按钮 `contenteditable=false`，内联 SVG 图标（无纯文字），`title`/`aria-label` 提供语义。
 *
 * 第五十一轮 · P0-①a（用户报的硬伤）：`(` 与 `)` 之间**只有一个文档位置** ⇒ widget 的 `side`
 * 只决定**光标画在按钮哪一侧**，两头不能"同时"都有落点。所以改成**跟着点击位置走**：
 * 维护 view-only 的 `caretSide`，在**编辑区根节点的捕获阶段** `mousedown` 里比较指针 x 与按钮
 * 矩形中线（左半 ⇒ `before`、右半 ⇒ `after`），必要时用一次 meta 事务刷新装饰，于是
 * **点在按钮左侧光标画在左、点在右侧画在右**；文档一个字符都不动。
 */
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { insertImageFromBytes } from '../insertImage'

const EMPTY_IMAGE = '![]()'
const KEY = new PluginKey<number>('luminImagePicker')
/** 光标该画在按钮哪一侧（view-only；由点击位置决定） */
let caretSide: 'before' | 'after' = 'after'
/** 装过捕获监听的 view（幂等） */
let boundView: EditorView | null = null

function emptyImageSlots(doc: PMNode): number[] {
  const slots: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text || !node.text.includes(EMPTY_IMAGE)) return true
    let at = node.text.indexOf(EMPTY_IMAGE)
    while (at >= 0) {
      // `!` `[` `]` `(` 四个字符之后 = 括号中间
      slots.push(pos + at + 4)
      at = node.text.indexOf(EMPTY_IMAGE, at + EMPTY_IMAGE.length)
    }
    return true
  })
  return slots
}

/** 刷新装饰（meta 事务；`state` 里的计数器让 PM 重算 `decorations`） */
function refresh(view: EditorView, side: 'before' | 'after'): void {
  if (caretSide === side) return
  caretSide = side
  try {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(KEY, Date.now()))
  } catch {
    /* 视图销毁中：忽略 */
  }
}

/** 捕获阶段：点在按钮附近就按左右半边决定光标画在哪一侧（不改文档、不改选区） */
function onCaptureDown(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0) return
  const buttons = Array.from(view.dom.querySelectorAll<HTMLElement>('[data-md-image-picker]'))
  for (const el of buttons) {
    const r = el.getBoundingClientRect()
    const pad = 6
    if (
      event.clientX >= r.left - pad &&
      event.clientX <= r.right + pad &&
      event.clientY >= r.top - pad &&
      event.clientY <= r.bottom + pad
    ) {
      refresh(view, event.clientX < r.left + r.width / 2 ? 'before' : 'after')
      return
    }
  }
}

function pickerDom(view: EditorView, pos: number): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-image-picker'
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('data-md-image-picker', '')
  button.title = '选择图片'
  button.setAttribute('aria-label', '选择图片')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  frame.setAttribute('x', '1.5')
  frame.setAttribute('y', '2.5')
  frame.setAttribute('width', '13')
  frame.setAttribute('height', '11')
  frame.setAttribute('rx', '2')
  frame.setAttribute('fill', 'none')
  frame.setAttribute('stroke', 'currentColor')
  const hill = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  hill.setAttribute('d', 'M3 11.5l3-3 2 2 3-3.5 2 2.5')
  hill.setAttribute('fill', 'none')
  hill.setAttribute('stroke', 'currentColor')
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  dot.setAttribute('cx', '5.5')
  dot.setAttribute('cy', '5.8')
  dot.setAttribute('r', '1')
  dot.setAttribute('fill', 'currentColor')
  svg.append(frame, hill, dot)
  button.append(svg)
  button.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void chooseAndInsert(view, pos)
  })
  return button
}

async function chooseAndInsert(view: EditorView, slot: number): Promise<void> {
  if (view.isDestroyed) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  // 测试钩子：断言"文件选择被请求"（不真弹窗）
  const w = window as unknown as { __mdImagePickRequests?: number }
  w.__mdImagePickRequests = (w.__mdImagePickRequests ?? 0) + 1
  input.addEventListener('change', () => {
    const file = input.files && input.files[0] ? input.files[0] : null
    input.remove()
    if (!file) return
    void file
      .arrayBuffer()
      .then((buf) =>
        insertImageFromBytes(
          (src: string) => {
            if (view.isDestroyed) return
            const image = view.state.schema.nodes.image
            if (!image) return
            const slots = emptyImageSlots(view.state.doc)
            const at = slots.includes(slot) ? slot : slots[0]
            if (at === undefined) return
            view.dispatch(view.state.tr.replaceWith(at - 1, at + 2, image.create({ src })))
          },
          new Uint8Array(buf),
          file.name || 'image.png'
        )
      )
      .catch(() => {
        /* 读文件失败：静默（与既有粘贴路径同口径） */
      })
  })
  document.body.appendChild(input)
  input.click()
  setTimeout(() => {
    if (input.isConnected && (!input.files || input.files.length === 0)) input.remove()
  }, 60_000)
}

export const ImagePicker = {
  name: 'luminImagePicker',
  addProseMirrorPlugins() {
    return [
      new Plugin<number>({
        key: KEY,
        state: {
          init: () => 0,
          apply: (tr, value) => (tr.getMeta(KEY) !== undefined ? value + 1 : value)
        },
        view: (view) => {
          if (boundView !== view) {
            boundView = view
            const handler = (e: MouseEvent): void => onCaptureDown(view, e)
            view.dom.addEventListener('mousedown', handler, true)
          }
          return {}
        },
        props: {
          decorations(state) {
            const slots = emptyImageSlots(state.doc)
            const view = boundView
            if (!slots.length || !view) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              slots.map((pos) =>
                Decoration.widget(pos, () => pickerDom(view, pos), {
                  side: caretSide === 'before' ? 1 : -1,
                  key: 'md-image-picker:' + pos + ':' + caretSide,
                  ignoreSelection: true,
                  stopEvent: (event: Event) =>
                    event.type === 'mousedown' ||
                    event.type === 'click' ||
                    event.type === 'pointerdown'
                })
              )
            )
          }
        }
      })
    ]
  }
}
