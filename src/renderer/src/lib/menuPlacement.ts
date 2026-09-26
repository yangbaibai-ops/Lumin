/**
 * ─── 浮层落点计算（纯函数）──────────────────────────────────────────────────────
 *
 * 背景（审计 §10 P1「重复实现：菜单定位 3 份、popover 2 份」）：这段几何此前在三处各写了一遍
 * ——`ContextMenu.vue`、`EditorContextMenu.vue`（两份逐字相同）与 `TopMenuBar.vue`（横向同、
 * 纵向按"到窗口底部还剩多少"钳制 maxHeight）。重复的代价不是难看，而是**踩过的坑会再踩一次**：
 * 子菜单曾经与父面板留 2px 空档，配合 mouseleave 立即收起，表现成"怎么都移不到二级菜单上"；
 * 修法改成"贴死、重叠 1px"（`SUBMENU_OVERLAP`）—— 那次只改了当时那份实现。
 *
 * 约定：所有尺寸都用 `offsetWidth/offsetHeight`（**不要**用 `getBoundingClientRect()` ——
 * 入场动效带 scale，后者返回缩放后的 96% 尺寸，贴边时仍会溢出几个像素）。
 */

/** 距离视口边缘的最小留白 */
export const MENU_MARGIN = 8
/** 子菜单与父面板**重叠**的像素数（贴死，保证指针移得进去；留空档会导致移动瞬间判定离开） */
export const SUBMENU_OVERLAP = 1
/** 子菜单上沿相对父项行的偏移（略微上提，视觉上对齐条目） */
export const SUBMENU_ROW_OFFSET = -6

export interface Placement {
  left: number
  top: number
}

export interface Viewport {
  width: number
  height: number
}

/** 一级菜单：出现在指针处，并整体钳在视口内（贴边显示，不溢出） */
export function placeAtPoint(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: Viewport,
  margin: number = MENU_MARGIN
): Placement {
  return {
    left: Math.max(margin, Math.min(x, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(y, viewport.height - size.height - margin))
  }
}

/**
 * 子菜单的**横向**落点：优先贴在父面板右侧（重叠 `SUBMENU_OVERLAP`），
 * 右侧放不下就翻到左侧（同样重叠），最后再夹一次 `margin`。
 *
 * 单独导出是因为 `TopMenuBar.vue` 的纵向策略不同（用 maxHeight + 内部滚动，而不是量高度），
 * 但横向这条规则必须与两个右键菜单完全一致 —— 三个入口里任意一个留了空隙，
 * 用户就会遇到"某一处的二级菜单移不进去"。
 */
export function placeSubmenuX(input: {
  parentLeft: number
  parentRight: number
  width: number
  viewportWidth: number
  margin?: number
}): { left: number; flipped: boolean } {
  const margin = input.margin ?? MENU_MARGIN
  const flipped = input.parentRight + input.width > input.viewportWidth - margin
  const raw = flipped
    ? input.parentLeft - input.width + SUBMENU_OVERLAP
    : input.parentRight - SUBMENU_OVERLAP
  return { left: Math.max(margin, raw), flipped }
}

/** 子菜单的**完整**落点（横向见 `placeSubmenuX`，纵向夹在视口内并对齐父项行） */
export function placeSubmenu(input: {
  parentLeft: number
  parentRight: number
  rowTop: number
  size: { width: number; height: number }
  viewport: Viewport
  margin?: number
}): Placement & { flipped: boolean } {
  const margin = input.margin ?? MENU_MARGIN
  const x = placeSubmenuX({
    parentLeft: input.parentLeft,
    parentRight: input.parentRight,
    width: input.size.width,
    viewportWidth: input.viewport.width,
    margin
  })
  return {
    left: x.left,
    flipped: x.flipped,
    top: Math.max(
      margin,
      Math.min(
        input.rowTop + SUBMENU_ROW_OFFSET,
        input.viewport.height - input.size.height - margin
      )
    )
  }
}
