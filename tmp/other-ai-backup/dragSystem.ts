// ─── 拖选系统集成：初始化 + resolver 注册 + 事件管理 ───────────────────────
//
// 职责：
// 1. 初始化时注册图片和公式的 resolver
// 2. 管理 mousedown/move/up 事件
// 3. 协调 stateMachine 和 painter

import type { EditorView } from '@tiptap/pm/view'
import { registerBoxResolver } from './pointerTarget'
import { DragSelectionStateMachine } from './dragSelection'
import { DragPainter } from './dragPaint'

/**
 * 拖选系统管理器。
 * 生命周期与编辑器视图绑定。
 */
export class DragSelectionManager {
  private stateMachine: DragSelectionStateMachine
  private painter: DragPainter
  private isActive = false

  constructor(private view: EditorView) {
    this.stateMachine = new DragSelectionStateMachine(view)
    this.painter = new DragPainter(view)
    this.setupEventListeners()
  }

  /**
   * 设置全局事件监听器。
   */
  private setupEventListeners(): void {
    this.view.dom.addEventListener('mousedown', (e) => this.onMouseDown(e))
  }

  /**
   * mousedown 处理：判断是否需要接管拖选。
   */
  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return // 只处理左键

    const anchor = this.stateMachine.start(event.clientX, event.clientY)
    if (anchor === null) return // 普通位置，让 PM 处理

    // 接管拖选
    event.preventDefault()
    this.isActive = true

    const onMouseMove = (e: MouseEvent): void => {
      if (!this.isActive) return

      const range = this.stateMachine.move(e.clientX, e.clientY)
      if (range) {
        // 拖动中：更新视觉反馈（不 dispatch）
        this.painter.highlight(range.from, range.to)
      }
    }

    const onMouseUp = (e: MouseEvent): void => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('pointercancel', onCancel)

      if (!this.isActive) return
      this.isActive = false

      // 松手：落定选区（stateMachine 内部会 dispatch）
      this.stateMachine.end(e.clientX, e.clientY)

      // 延迟清理视觉反馈（避免闪烁的一帧）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.painter.clear()
        })
      })
    }

    const onCancel = (): void => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('pointercancel', onCancel)

      this.isActive = false
      this.stateMachine.reset()
      this.painter.clear()
    }

    // 全局监听（避免被 PM 事件处理抢先）
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('pointercancel', onCancel)
  }

  /**
   * 销毁管理器。
   */
  destroy(): void {
    this.stateMachine.reset()
    this.painter.clear()
  }
}

/**
 * 初始化拖选系统：注册所有 resolver。
 * 必须在创建 DragSelectionManager 之前调用。
 */
export function initDragResolvers(): void {
  // 注册图片 resolver
  registerBoxResolver((_view, el) => {
    if (!el.hasAttribute('data-img-widget')) return null

    const fromAttr = el.getAttribute('data-img-from')
    if (!fromAttr) return null

    const from = Number(fromAttr)
    if (!Number.isFinite(from) || from < 0) return null

    // 图片 widget 通常是 0 宽度装饰，源码区间由文档模型决定
    // 这里简化为 [from, from+1]，实际应查询 collectImgSources
    // 但为了不依赖 imageToolbar 的具体实现，暂时使用启发式
    const to = from + 1

    return {
      kind: 'image' as const,
      from,
      to,
      el
    }
  })

  // 注册行内公式 resolver
  registerBoxResolver((view, el) => {
    if (!el.classList.contains('md-math-rendered')) return null

    // 行内公式的 widget 挂在源码起点
    // 需要通过 view 查询位置
    try {
      const pos = view.posAtDOM(el, 0)
      if (pos === null || pos === undefined) return null

      // 从该位置往后找公式的源码区间
      // 简化实现：假设公式长度为 10（实际应解析 mark）
      const from = pos
      const to = Math.min(pos + 10, view.state.doc.content.size)

      return {
        kind: 'math-inline' as const,
        from,
        to,
        el
      }
    } catch {
      return null
    }
  })
}
