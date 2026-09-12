// ─── 浮层关闭条件的公共判断 ─────────────────────────────────────────────────
// 「点击外部 / 滚动 / 缩放 → 关闭浮层」是通用需求，但有两个已踩过的坑：
//  1) **浮层内部滚动不应关闭浮层**：下拉里的列表（最近文档等）自带滚动条，
//     滚动条一动 scroll 事件就会冒到 window，若不加区分就会把菜单关掉，
//     用户表现为「菜单里有滚动条却滚不动，一滚就消失」；
//  2) 浮层经 Teleport 挂到 body，与触发按钮并非 DOM 祖先关系，因此判断
//     「是否在浮层内」必须显式传入元素，不能靠 `closest()`。
// 编辑器右键菜单（EditorContextMenu.vue）里是同一套逻辑，这里抽出来给
// 工具栏/侧栏的各个浮层共用，避免再复制一遍踩同样的坑。
export function isEventInside(e: Event, ...panels: (HTMLElement | null | undefined)[]): boolean {
  const target = e.target as Node | null
  if (!target) return false
  return panels.some((p) => !!p && p.contains(target))
}

/**
 * 滚动/缩放时的统一处理：外部滚动或任何缩放 → 关闭；浮层内部滚动 → 忽略。
 * 用法：`window.addEventListener('scroll', h, true)` + `window.addEventListener('resize', h)`
 */
export function shouldCloseOnScrollOrResize(
  e: Event,
  ...panels: (HTMLElement | null | undefined)[]
): boolean {
  if (e.type === 'scroll' && isEventInside(e, ...panels)) return false
  return true
}
