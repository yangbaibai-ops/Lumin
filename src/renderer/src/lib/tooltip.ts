// ─── 全局 tooltip：接管原生 title 提示，统一主题样式 + 0.75s 延迟 ──────────
// 采用「事件委托」而非逐个组件改 v-tooltip：全局捕获 mouseover/mouseout，
// 自动识别带 [title] 的元素，悬停 750ms 后弹出统一样式的浮层，并把原生
// title 临时移除（防止浏览器原生灰框同时出现），移出后恢复。
import { reactive } from 'vue'

export interface TooltipState {
  visible: boolean
  text: string
  x: number
  y: number
  /** true = 显示在元素上方；false = 下方（顶部空间不足时） */
  above: boolean
  /** 目标元素视口矩形（供组件侧做精确钳制/翻转，保证整块完整显示） */
  targetRect: { top: number; bottom: number; left: number; right: number }
}

export const tooltipState = reactive<TooltipState>({
  visible: false,
  text: '',
  x: 0,
  y: 0,
  above: true,
  targetRect: { top: 0, bottom: 0, left: 0, right: 0 }
})

const DELAY_MS = 750
let timer: ReturnType<typeof setTimeout> | null = null
let currentEl: HTMLElement | null = null
let savedTitle: string | null = null
let installed = false

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function restoreTitle(): void {
  // 只在 title 仍然缺失时写回：若悬停期间组件重新渲染并写入了新的 title
  // （例如随状态变化的 :title），写回旧值会让提示与实际状态不一致
  if (currentEl && savedTitle !== null && !currentEl.hasAttribute('title')) {
    currentEl.setAttribute('title', savedTitle)
  }
  currentEl = null
  savedTitle = null
}

function hideTooltip(): void {
  clearTimer()
  tooltipState.visible = false
  restoreTitle()
}

function showTooltip(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const above = rect.top > 64
  tooltipState.text = savedTitle ?? ''
  tooltipState.x = rect.left + rect.width / 2
  tooltipState.y = above ? rect.top : rect.bottom
  tooltipState.above = above
  tooltipState.targetRect = {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right
  }
  tooltipState.visible = true
}

function onMouseOver(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  // 仍在当前标题元素内部移动：保持现状（title 已被临时移除，closest 找不到）
  if (currentEl && target && currentEl.contains(target)) return

  const el = target?.closest?.('[title]') as HTMLElement | null
  hideTooltip()
  if (!el) return
  savedTitle = el.getAttribute('title') ?? ''
  if (!savedTitle) return
  currentEl = el
  el.removeAttribute('title')
  timer = setTimeout(() => showTooltip(el), DELAY_MS)
}

function onMouseOut(e: MouseEvent): void {
  if (!currentEl) return
  const related = e.relatedTarget as HTMLElement | null
  if (related && currentEl.contains(related)) return
  hideTooltip()
}

/** 安装全局监听（幂等，只需调用一次） */
export function installGlobalTooltip(): void {
  if (installed) return
  installed = true
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout', onMouseOut, true)
}
