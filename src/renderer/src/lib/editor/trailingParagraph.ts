/**
 * 「文档末尾是图片 ⇒ 点它**下方**在下一行落光标」（第八十六轮重做；参照主流编辑器）
 *
 * 与第八十四轮那版的差别（那版被回退，原因是**闪**且**点不出光标**）：
 *   * 那版挂在 `handleDOMEvents.mousedown` 上，与图片激活路径（`ImageSourceUi` 的
 *     `mousedown` + `pendingClick` + `mouseup` 激活）**抢同一击** ⇒ 一次手势 ≥2 次可见跃迁；
 *     而且它 `preventDefault()` 之后，PM 内建的"点最后一块下方补段落"也被吃掉 ⇒ 点不出光标。
 *   * 这版挂在 **`handleDOMEvents.click`**（冒泡、PM 与浏览器都已经处理完这一击之后）：
 *     **不 preventDefault、不 stopPropagation、不记 pendingClick** ⇒ 与图片激活路径完全错开。
 *     （同时 `ImageSourceUi.mousedown` 已收窄为"点击必须落在图片自身矩形内"，见那里的注释。）
 *
 * 契约（`docs/image-behavior.md` 第 4 节的延伸）：
 *   1) **只有**最后一个顶层块是图片时才生效（`![]()` 节点 / 裸 `<img …>` 原文 / images-only htmlBlock）；
 *   2) 点**最后一块矩形下方**且仍在编辑器盒内 ⇒ 末尾插入一个空段落并**把光标放进去**；
 *   3) 不点就不动文档；点了之后新段落是用户意图 ⇒ 走默认 undo 栈（可 Ctrl+Z 撤销）；
 *   4) 点在正文/图片/标识符上时一律不处理（`clickBelowTrailingImage` 返回 false）。
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { collectImgSources, isImgOnlyRawHtml } from './imageToolbar'

/**
 * 纯判据：文档**最后一个顶层块**是不是"只有图片"。三种形态都认：
 * `paragraph`（只有 `image` 节点 / 只有 images-only 原文文本）、images-only 的 `htmlBlock`。
 */
export function lastBlockIsImage(state: EditorState): boolean {
  const doc = state.doc
  if (doc.childCount === 0) return false
  const last = doc.child(doc.childCount - 1)
  const lastFrom = doc.content.size - last.nodeSize
  if (last.type.name === 'htmlBlock') return isImgOnlyRawHtml(String(last.attrs.source ?? ''))
  if (!last.isTextblock) return false
  const imgs = collectImgSources(state).filter(
    (i) => i.from >= lastFrom && i.to <= doc.content.size
  )
  if (!imgs.length) return false
  let onlyImages = true
  last.forEach((child, offset) => {
    const from = lastFrom + 1 + offset
    const to = from + child.nodeSize
    if (child.isText) {
      const t = (child.text ?? '').trim()
      if (!t) return
      if (!isImgOnlyRawHtml(t) && !imgs.some((i) => i.from >= from && i.to <= to))
        onlyImages = false
      return
    }
    if (child.type.name !== 'image') onlyImages = false
  })
  return onlyImages
}

/** 点是否落在"最后一块的下方"（仍在编辑器盒内） */
export function isBelowLastBlock(view: EditorView, clientX: number, clientY: number): boolean {
  const doc = view.state.doc
  if (doc.childCount === 0) return false
  const lastFrom = doc.content.size - doc.child(doc.childCount - 1).nodeSize
  let rect: DOMRect | null = null
  try {
    const dom = view.nodeDOM(lastFrom)
    const el = dom && dom.nodeType === 1 ? (dom as HTMLElement) : (dom?.parentElement ?? null)
    rect = el ? el.getBoundingClientRect() : null
  } catch {
    rect = null
  }
  if (!rect) return false
  const editor = view.dom.getBoundingClientRect()
  if (clientY <= rect.bottom - 1) return false
  if (clientY > editor.bottom + 1) return false
  return clientX >= editor.left - 1 && clientX <= editor.right + 1
}

/**
 * 事件处理：**只在**"末尾是图片 + 点在它下方"时，插入一个空段落并把光标放进去。
 * 返回 true 表示"这次点击我处理了"（调用方仍然**不** `preventDefault` —— 见文件头说明）。
 */
export function addTrailingParagraphAtClick(
  view: EditorView,
  clientX: number,
  clientY: number
): boolean {
  if (!lastBlockIsImage(view.state)) return false
  if (!isBelowLastBlock(view, clientX, clientY)) return false
  const para = view.state.schema.nodes.paragraph
  if (!para) return false
  const end = view.state.doc.content.size
  const tr = view.state.tr.insert(end, para.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1), 1))
  view.dispatch(tr) // 默认进 undo 栈
  return true
}

export const TrailingParagraph = Extension.create({
  name: 'luminTrailingParagraph',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('luminTrailingParagraph'),
        props: {
          handleDOMEvents: {
            // ⚠️ 只在 `click`（冒泡、后于一切鼠标处理）里做事；**不**拦事件、**不** `preventDefault`
            click(view, event) {
              addTrailingParagraphAtClick(view, event.clientX, event.clientY)
              return false
            }
          }
        }
      })
    ]
  }
})
