// ─── 拖选视觉反馈：DOM 层高亮 ──────────────────────────────────────────────
//
// 职责：在拖选过程中提供即时视觉反馈，不涉及模型层。
// 手段：DOM classList（盒子高亮）
//
// 约束：拖动期不能 dispatch，只能纯 DOM 操作。

import type { EditorView } from '@tiptap/pm/view'

/**
 * 拖选绘制器：纯 DOM 操作，提供即时视觉反馈。
 */
export class DragPainter {
  private highlightedBoxes = new Set<HTMLElement>()

  constructor(private view: EditorView) {}

  /**
   * 高亮指定区间。
   * 实现：给区间内的所有 widget 盒子添加 'is-drag-selecting' 类。
   */
  highlight(from: number, to: number): void {
    // 清理旧的高亮
    this.clear()

    // 遍历区间内的所有位置，找出盒子
    const boxes: HTMLElement[] = []
    this.view.state.doc.nodesBetween(from, to, (_node, pos) => {
      if (pos >= to) return false

      // 尝试获取该位置的 DOM 节点
      try {
        const dom = this.view.nodeDOM(pos)
        if (dom && dom.nodeType === 1) {
          const el = dom as HTMLElement
          // 检查是否是 widget（通过属性识别）
          if (el.hasAttribute('data-img-widget') || el.classList.contains('md-math-rendered')) {
            boxes.push(el)
          }
        }
      } catch {
        // nodeDom 可能抛异常，忽略
      }

      return true
    })

    // 给所有盒子添加高亮类
    for (const box of boxes) {
      box.classList.add('is-drag-selecting')
      this.highlightedBoxes.add(box)
    }
  }

  /**
   * 清除所有高亮。
   */
  clear(): void {
    for (const box of this.highlightedBoxes) {
      box.classList.remove('is-drag-selecting')
    }
    this.highlightedBoxes.clear()
  }
}
