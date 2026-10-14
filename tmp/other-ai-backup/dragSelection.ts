// ─── 拖选状态机：管理拖选的生命周期 ────────────────────────────────────────
//
// 约束：
// 1. 拖动期间不能 dispatch（会打断 Chromium 原生手势）
// 2. 使用 posAtCoords 计算位置（相对稳定）
// 3. mouseup 后一帧决策，然后 6 帧有界复验（对抗 PM 的 DOMObserver 定时器）

import type { EditorView } from '@tiptap/pm/view'
import { TextSelection } from '@tiptap/pm/state'
import { boxEdgeAtPoint } from './pointerTarget'

interface DragState {
  /** 锚点位置（文档坐标） */
  anchor: number
  /** 当前头部位置（文档坐标） */
  head: number
  /** 是否正在拖动 */
  active: boolean
}

/**
 * 拖选状态机：纯计算，不操作 DOM。
 */
export class DragSelectionStateMachine {
  private state: DragState = { anchor: 0, head: 0, active: false }
  private verifyFrames = 0
  private verifyTimer: number | null = null

  constructor(private view: EditorView) {}

  /**
   * 开始拖选。
   * 返回锚点位置，null = 无法确定起点（比如在编辑器外按下）。
   */
  start(x: number, y: number): number | null {
    const pos = this.posAtPoint(x, y)
    if (pos === null) return null

    this.state = { anchor: pos, head: pos, active: true }
    this.verifyFrames = 0
    if (this.verifyTimer !== null) {
      cancelAnimationFrame(this.verifyTimer)
      this.verifyTimer = null
    }
    return pos
  }

  /**
   * 拖动中，更新头部位置。
   * 返回当前试探区间 {from, to}。
   */
  move(x: number, y: number): { from: number; to: number } | null {
    if (!this.state.active) return null

    const pos = this.posAtPoint(x, y)
    if (pos === null) return null

    this.state.head = pos
    return this.getRange()
  }

  /**
   * 松手，落定选区。
   * 返回最终选区，并启动复验。
   */
  end(x: number, y: number): { from: number; to: number } | null {
    if (!this.state.active) return null

    const pos = this.posAtPoint(x, y)
    if (pos !== null) {
      this.state.head = pos
    }

    const range = this.getRange()
    this.state.active = false

    // 一帧后落定，然后启动 6 帧复验
    requestAnimationFrame(() => {
      if (range) {
        this.applySelection(range.from, range.to)
        this.startVerify(range.from, range.to)
      }
    })

    return range
  }

  /**
   * 重置状态。
   */
  reset(): void {
    this.state = { anchor: 0, head: 0, active: false }
    this.verifyFrames = 0
    if (this.verifyTimer !== null) {
      cancelAnimationFrame(this.verifyTimer)
      this.verifyTimer = null
    }
  }

  /**
   * 获取当前试探区间。
   */
  private getRange(): { from: number; to: number } | null {
    const { anchor, head } = this.state
    if (anchor === head) return null
    return anchor < head ? { from: anchor, to: head } : { from: head, to: anchor }
  }

  /**
   * 给定点坐标，计算文档位置。
   * 优先使用盒子边缘规则，否则使用 posAtCoords。
   */
  private posAtPoint(x: number, y: number): number | null {
    // 1. 检查是否在盒子上
    const edgeHit = boxEdgeAtPoint(this.view, x, y)
    if (edgeHit) {
      return edgeHit.edge === 'start' ? edgeHit.box.from : edgeHit.box.to
    }

    // 2. 使用 PM 的 posAtCoords
    const pmPos = this.view.posAtCoords({ left: x, top: y })
    if (!pmPos) return null

    // 确保位置在文档范围内
    const { doc } = this.view.state
    return Math.max(0, Math.min(pmPos.pos, doc.content.size))
  }

  /**
   * 应用选区（dispatch）。
   */
  private applySelection(from: number, to: number): void {
    const { state } = this.view
    const { doc } = state

    // 确保范围有效
    const safeFrom = Math.max(0, Math.min(from, doc.content.size))
    const safeTo = Math.max(0, Math.min(to, doc.content.size))

    if (safeFrom === safeTo) return

    try {
      const tr = state.tr.setSelection(TextSelection.create(doc, safeFrom, safeTo))
      this.view.dispatch(tr)
    } catch (err) {
      console.warn('[dragSelection] Failed to apply selection:', err)
    }
  }

  /**
   * 启动 6 帧复验：对抗 PM 的 DOMObserver.flushSoon。
   */
  private startVerify(from: number, to: number): void {
    this.verifyFrames = 0
    const verify = (): void => {
      if (this.verifyFrames >= 6) {
        this.verifyTimer = null
        return
      }

      const { state } = this.view
      const current = state.selection
      if (current.from !== from || current.to !== to) {
        // 选区漂移了，修正它
        this.applySelection(from, to)
      }

      this.verifyFrames++
      this.verifyTimer = requestAnimationFrame(verify)
    }

    this.verifyTimer = requestAnimationFrame(verify)
  }
}
