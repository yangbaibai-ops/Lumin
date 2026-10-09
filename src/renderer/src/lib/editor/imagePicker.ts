/**
 * **`![]()` 的纯渲染选图按钮**（第四十八轮 · 切片 A）。
 *
 * 口径（用户/父任务拍板）：
 *   * 文档里出现**字面** `![]()`（alt 与 URL 都空）⇒ 在 `(` 与 `)` 之间渲染一个按钮；
 *   * **文档内容逐字节仍是 `![]()`** —— 按钮是 `Decoration.widget`，纯渲染、零污染；
 *   * 括号里一旦有任意字符（`![](x)`）⇒ 该 widget **不再产出**（装饰按文本重算，自然消失）；
 *   * 点按钮 ⇒ `<input type="file" accept="image/*">`（渲染层，不新增 IPC）⇒ 选中后走既有
 *     `lib/insertImage.ts` 的 `insertImageFromBytes` 落盘，再把那段 `![]()` 替换成图片节点
 *     （序列化即 `![](path)`）；
 *   * `stopEvent` 只吃**按钮自身**的 mousedown/click；`ignoreSelection` 让光标能落在按钮前/后；
 *     按钮 `contenteditable=false`。
 *
 * 与数学/标记那套 widget 同一写法（`Decoration.widget` + `contenteditable=false` + `side`），
 * 但这里**不需要**任何会话状态：按钮是"按文本现算"的。
 */
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { insertImageFromBytes } from '../insertImage'

/** 空图：`![]()` 里 `(` 与 `)` 之间的位置就是按钮的落点（widget 插在 `(` 之后） */
const EMPTY_IMAGE = '![]()'
const KEY = new PluginKey('luminImagePicker')

/** 在文档里找出所有"字面 `![]()`"在括号中间的那个位置（绝对文档位置） */
function emptyImageSlots(doc: PMNode): number[] {
  const slots: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text || !node.text.includes(EMPTY_IMAGE)) return true
    let at = node.text.indexOf(EMPTY_IMAGE)
    while (at >= 0) {
      // `(` 在 `![]` 之后 ⇒ 括号中间 = 文本起点 + at + 4（`!` `[` `]` `(` 四个字符之后）
      slots.push(pos + at + 4)
      at = node.text.indexOf(EMPTY_IMAGE, at + EMPTY_IMAGE.length)
    }
    return true
  })
  return slots
}

function pickerDom(view: EditorView, pos: number): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-image-picker'
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('data-md-image-picker', '')
  button.textContent = '选择图片…'
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
  // 测试钩子：让套件能断言"文件选择被请求"（不真弹窗）
  ;(window as unknown as { __mdImagePickRequests?: number }).__mdImagePickRequests =
    ((window as unknown as { __mdImagePickRequests?: number }).__mdImagePickRequests ?? 0) + 1
  input.addEventListener('change', () => {
    const file = input.files && input.files[0] ? input.files[0] : null
    input.remove()
    if (!file) return
    void file
      .arrayBuffer()
      .then((buf) =>
        insertImageFromBytes(
          (src: string) => {
            // 把这段字面 `![]()` 换成图片节点（序列化 ⇒ `![](src)`）
            if (view.isDestroyed) return
            const image = view.state.schema.nodes.image
            if (!image) return
            const slots = emptyImageSlots(view.state.doc)
            const at = slots.includes(slot) ? slot : slots[0]
            if (at === undefined) {
              view.dispatch(view.state.tr.insert(view.state.selection.from, image.create({ src })))
              return
            }
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
  // 兜底：用户取消对话框时把 input 摘掉（change 不会触发）
  setTimeout(() => {
    if (input.isConnected && (!input.files || input.files.length === 0)) input.remove()
  }, 60_000)
}

export const ImagePicker = {
  /** 由宿主扩展在 setup 时把 view 绑进来（decorations(state) 拿不到 view） */
  bind(view: EditorView): void {
    bindImageView(view)
  },
  name: 'luminImagePicker',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: KEY,
        // 自绑定视图：widget 的 DOM 创建函数拿不到 view，点击时要用它来派发替换事务
        view: (v: EditorView) => {
          bindImageView(v)
          return {}
        },
        props: {
          decorations(state) {
            const slots = emptyImageSlots(state.doc)
            if (!slots.length) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              slots.map((pos) =>
                Decoration.widget(pos, () => pickerDom(pluginView as EditorView, pos), {
                  side: -1,
                  key: 'md-image-picker:' + pos,
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

/**
 * 插件里拿不到 view（`decorations(state)` 只有 state），但 widget 的 DOM 创建函数在
 * "视图求值装饰"时被调用；这里用一次性的 `view` 捕获（由 `setup` 提供），与仓库里
 * `mathPreview` 用插件 state 之外的模块变量存视图是同一套做法。
 */
let pluginView: EditorView | null = null
export function bindImageView(view: EditorView): void {
  pluginView = view
}
