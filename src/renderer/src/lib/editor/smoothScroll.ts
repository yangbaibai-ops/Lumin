/**
 * ─── 编辑器内的平滑滚动 ─────────────────────────────────────────────────────
 * 大纲/目录点击标题时，之前用的是 ProseMirror 的 `.scrollIntoView()`：它直接写
 * `scrollTop`，是**瞬时跳转**。这里改成对滚动容器做 `behavior: 'smooth'` 的滚动，
 * 并在系统开启「减少动态效果」时退化为瞬时定位（无障碍要求）。
 *
 * 两个容易踩的点：
 *  1. `scrollTo({ behavior })` 的显式取值**优先于** CSS 的 `scroll-behavior`，
 *     所以容器自带 `scroll-behavior: smooth`（打字机模式）时也能强制瞬时复位；
 *  2. `focus()` + 改选区会让浏览器把光标瞬时滚进视口，因此调用方要先复位再平滑滚。
 */

/** 系统是否偏好减少动效 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 把容器滚到指定位置（'instant' 用于复位，'smooth' 用于动画） */
export function scrollContainerTo(
  container: HTMLElement,
  top: number,
  behavior: 'instant' | 'smooth'
): void {
  container.scrollTo({ top: Math.max(0, top), behavior })
}

/** 平滑滚动到容器内的某个元素（顶部留 offset 像素的呼吸空间） */
export function smoothScrollToElement(
  container: HTMLElement,
  target: HTMLElement,
  offset = 12
): void {
  const cRect = container.getBoundingClientRect()
  const tRect = target.getBoundingClientRect()
  const top = container.scrollTop + (tRect.top - cRect.top) - offset
  scrollContainerTo(container, top, prefersReducedMotion() ? 'instant' : 'smooth')
}
