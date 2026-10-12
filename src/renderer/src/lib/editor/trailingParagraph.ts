/**
 * 「文档末尾是图片 ⇒ 点它**下方**的空白能在下一行落光标」——（第八十四轮用户口径，照 Typora）
 *
 * 为什么单独一个文件：判据是**纯函数**（可单测、不碰 DOM），事件处理只做"收窄 + 一次事务"。
 * `imageToolbar.ts` 里已经有显隐/拖拽/缩放三条线，不再往那里堆补丁。
 *
 * 契约（`docs/image-behavior.md` 第 4 节的延伸）：
 *   1) **只有**"最后一个顶层块是图片"时才生效（`![]()` 节点 / 裸 `<img …>` 原文 / images-only htmlBlock）；
 *   2) 点**最后一块的矩形下方**（仍在编辑器内容区里）⇒ 末尾插入**一个空段落**并把光标放进去；
 *   3) **不点就不动文档**；点了之后新段落是用户意图 ⇒ **进 undo 栈**（可 Ctrl+Z 撤销）；
 *   4) 只要点在正文/图片/标识符上，一律**不拦**（返回 false，交给既有逻辑）。
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { collectImgSources, isImgOnlyRawHtml } from './imageToolbar'

/** 判定用得到的"块"信息（纯数据，便于单测） */
export interface TrailingBlockInfo {
  /** 是不是"这一段只有图片"（图片节点 / images-only 原文 / images-only htmlBlock） */
  isImageOnly: boolean
}

/**
 * 纯判据：**文档最后一个块是不是图片**（只有它成立，才允许"点下方出段落"）。
 * 三种形态都认：
 *   * `paragraph` 里只有 `image` 节点（可能多张并排）；
 *   * `paragraph` 里只有 images-only 的原文文本（`<img …>` 一个或多个）；
 *   * `htmlBlock`（独立成行的裸 `<img …>`，单标签或多标签）。
 * 其它任何结尾（普通段落、表格、代码块…）⇒ false（既有行为完全不变）。
 */
export function lastBlockIsImage(state: EditorState): boolean {
  const doc = state.doc
  if (doc.childCount === 0) return false
  const last = doc.child(doc.childCount - 1)
  const lastFrom = doc.content.size - last.nodeSize
  const lastTo = doc.content.size
  if (last.type.name === 'htmlBlock') {
    return isImgOnlyRawHtml(String(last.attrs.source ?? ''))
  }
  if (!last.isTextblock) return false
  const imgs = collectImgSources(state).filter((i) => i.from >= lastFrom && i.to <= lastTo)
  if (!imgs.length) return false
  // 段里除了这些源码之外还有别的东西（文字/别的节点）⇒ 不算"只有图片"
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

/**
 * 事件处理：**只**在"最后一块是图片 + 点在它下方（内容区以内）"时插一个空段落。
 * 返回 true 表示"这次点击被我处理了"（调用方应 `preventDefault` 以免浏览器再抢光标）。
 */
export function clickBelowTrailingImage(
  view: EditorView,
  clientY: number,
  clientX: number
): boolean {
  if (!lastBlockIsImage(view.state)) return false
  const doc = view.state.doc
  const last = doc.child(doc.childCount - 1)
  const lastFrom = doc.content.size - last.nodeSize
  // 最后一块的 DOM 矩形（用文档位置的 nodeDOM；拿不到就不做，宁可不动）
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
  // 收窄：必须在最后一块**下方**、且仍在编辑器内容列里（横坐标也在内容列内）
  if (clientY <= rect.bottom - 1) return false
  if (clientY > editor.bottom + 1) return false
  if (clientX < editor.left - 1 || clientX > editor.right + 1) return false
  const para = view.state.schema.nodes.paragraph
  if (!para) return false
  const tr = view.state.tr.insert(doc.content.size, para.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(doc.content.size + 1), 1))
  view.dispatch(tr) // 默认进 undo 栈（用户可 Ctrl+Z 撤销）
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
            mousedown(view, event) {
              // ⚠️ 只吃"末尾图片下方的空白"；点在正文/图片/标识符上时 `clickBelowTrailingImage`
              //    会因为"不在下方"直接返回 false ⇒ 既有逻辑（含 mousedown 记 pendingClick）不受影响。
              const handled = clickBelowTrailingImage(view, event.clientY, event.clientX)
              if (!handled) return false
              event.preventDefault()
              return true
            }
          }
        }
      })
    ]
  }
})
