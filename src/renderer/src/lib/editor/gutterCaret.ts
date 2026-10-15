// ─── 编辑区**左内边距**上按下 ⇒ 光标落到该行行首（第三十四轮报障③）─────────────
//
// 报障原话：「当行内公式出现在一行的最前方的时候，无法在公式的前面插入光标进行编辑。」
//
// 现象（真机逐坐标扫过，见报告里的数值）：正文列左边那条内边距（`.editor-content` 的
// `px-14`，56px 宽）**根本不在 `view.dom` 里** —— ProseMirror 的事件与
// `posAtCoords` 都只覆盖 `.ProseMirror` 自己那个盒子。于是：
//   * `view.posAtCoords({ left: <列左边缘左侧>, top: y })` 返回 **null**（实测 x=260/290/310/318 全 null）；
//   * 按下既不进 PM 的 mousedown，也没有任何别的处理者 ⇒ 浏览器把焦点丢给 `body`，
//     `activeElement = BODY`、`view.hasFocus() = false`。**Photoshop 式"点了没反应"**。
// 对照实测（同一份文档、同一个 y）：
//   * 行首公式：点在 x = 公式左边 - 2 / -4 / -8 ⇒ `selection.from = 1` 但 `focus = false`，
//     接着敲 `X` ⇒ **文档一个字符都不变**（`md` 前后逐字节相同）；
//   * 行中公式：点在公式左边 - 2 / -4 / -8 ⇒ `selection.from = 3/4`、`focus = true`，
//     敲 `X` ⇒ 落在公式**之前**（`前文X $E = mc^2$ …`）。
// 差别只在"左边有没有字"：行中公式左边是正文，点得到 PM；行首公式左边是内边距，点不到。
//
// 修法：在包裹层上补一条**只管左内边距**的 mousedown ——
//   1. 目标必须在这个包裹层里、但**不在** `view.dom` 里（= 纯粹是内边距）；
//   2. 坐标必须落在 `view.dom` 的竖直范围内、且在它的**左边缘之外**；
//   3. 把 x 夹到内容列左边缘 +1px，用 PM 自己的 `posAtCoords` 求该行的落点 ——
//      PM 对"行内横坐标越界"的夹取是既有的正确行为，行首公式因此得到**公式起点之前**那个位置；
//   4. `preventDefault()`（别让浏览器把焦点丢给 body）+ 落选区 + `view.focus()`。
//
// 为什么只做左内边距、不做右侧/上下：报障只在"行首公式左边没有字"这一处成立，
// 右内边距与上下内边距按列落光标各有自己的既有口径（见 imageToolbar 的空白带），
// 不在这里顺手改，免得把既有绿值搅进来。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { installOnce } from './inlineMarkerCore.ts'

/** 同一 `view` 上只保留一份监听（dev/HMR 会反复重建插件视图，见 `installOnce`） */
const gutterUninstall = new WeakMap<EditorView, () => void>()

export const gutterCaretKey = new PluginKey('gutterCaret')

/**
 * 左内边距按下 ⇒ 该行行首的文档位置（**纯几何**，不改文档）。
 *
 * 抽成导出函数是为了能在不装编辑器栈的情况下单测"夹取"这一步的判据。
 * @returns 要落的文档位置；不需要接管时返回 `null`
 */
export function gutterCaretPos(
  view: EditorView,
  clientX: number,
  clientY: number,
  wrapper: HTMLElement
): number | null {
  const rect = view.dom.getBoundingClientRect()
  // 竖直方向必须在正文列内（顶部 `pt-10` / 底部 `pb-40` 的内边距不接管）
  if (clientY < rect.top || clientY > rect.bottom) return null
  // 只接管**左内边距**：x 在内容列左边缘之外（含 0.5px 的亚像素余量）
  if (clientX >= rect.left) return null
  // 夹到内容列内部：PM 的 posAtCoords 只认自己那个盒子，越界一律 null
  const x = rect.left + 1
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1)
  if (!wrapper.contains(view.dom)) return null
  const hit = view.posAtCoords({ left: x, top: y })
  return hit ? hit.pos : null
}

export const GutterCaret = Extension.create({
  name: 'gutterCaret',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: gutterCaretKey,
        /**
         * 监听装在 `document` 上（**包裹层在事件里现取**，原因见下面那段注释）。
         *
         * ⚠️ 用 `installOnce` 而不是裸 `addEventListener`：`document` 比插件视图活得久
         * （dev 下 HMR 会反复重建插件视图），裸装会累积多份回调 —— 仓库里
         * `mathPreview` / `typoraInlineMarks` 都踩过这个坑（见 `installOnce` 的说明）。
         */
        view: (view) => {
          /**
           * ⚠️ 包裹层**不能在插件视图创建那一刻取**：Tiptap 是"先 `new EditorView(元素)`、
           * 之后才把那个元素挂进 DOM"，构造期 `view.dom.parentElement` 还是 `null`
           * —— 那时取一次就再也装不上了（实测：装在 `null` 上 ⇒ 左内边距按下仍然
           * `activeElement = BODY`、敲字一个字符都不进文档）。
           */
          const uninstall = installOnce(gutterUninstall, view, () => {
            const onMouseDown = (event: MouseEvent): void => {
              if (event.button !== 0) return
              if (view.isDestroyed) return
              const target = event.target as Element | null
              if (!target || typeof target.closest !== 'function') return
              // 落在可编辑内容里的按下全部放行（那是 PM 自己的地盘）
              if (view.dom.contains(target)) return
              const wrapper = view.dom.parentElement
              if (!wrapper || !wrapper.contains(target)) return
              const pos = gutterCaretPos(view, event.clientX, event.clientY, wrapper)
              if (pos == null) return
              const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size))
              const near = TextSelection.near($pos, 1) ?? TextSelection.near($pos, -1)
              if (!near) return
              // 别让浏览器把焦点丢给 body（内边距不是可聚焦元素）
              event.preventDefault()
              if (!view.state.selection.eq(near)) {
                view.dispatch(view.state.tr.setSelection(near))
              }
              view.focus()
            }
            document.addEventListener('mousedown', onMouseDown)
            return () => document.removeEventListener('mousedown', onMouseDown)
          })
          return {
            destroy: () => {
              uninstall?.()
              if (gutterUninstall.get(view) === uninstall) gutterUninstall.delete(view)
            }
          }
        }
      })
    ]
  }
})
