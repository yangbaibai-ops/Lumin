// ─── 代码块语言浮层的位置计算（纯函数）────────────────────────────────────────
//
// 用户口径（本轮）：语言选择器要**在代码块外面**，不许压住任何一行代码；默认贴在
// 代码块**上方、右对齐**，顶部空间不够时自动翻到**下方**，两种位置都不与代码块的
// rect 相交。样式要简约，但"不遮挡代码"是硬约束 —— 所以位置不能靠 CSS 猜，必须按
// 两个 rect 算出来，并且这条计算要能单测（tests/codeBlockLangPickerPlacement.test.mjs
// 用真实尺寸的矩形证明「交集面积 = 0」）。
//
// 为什么单独成模块而不是塞在 CodeBlockView.vue 里：
//   * NodeView 里那段代码要碰 DOM / CM / mermaid，单测跑不起来；
//   * "在块外"是几何问题，输入只有「块 rect / 视口 / 面板尺寸」，输出只有
//     「left / top / 宽度上限 / 高度上限 / 贴在哪一边」，全是可断言的数字。
//
// ⚠️ 口径（改之前先读）：
//   * **永远 fixed + 视口坐标**：`.code-block-wrapper` 是 `overflow: hidden`（layoutNoOverflow
//     守着它），absolute 子元素会被裁掉；fixed 既不占布局（块高不变），又不被祖先裁剪。
//   * **宽度上限 = min(240px, 代码块宽的 40%, 视口宽 - 16px)**：浮层只是块外的一条
//     小注脚，不能长得比代码块还抢眼（用户口径「整体宽度不超过代码块的 40%」）。
//   * **高度上限 = 贴的那一侧到视口边缘的空间**：候选列表再长也只会在浮层里自己滚，
//     绝不越过代码块的上/下边缘（即"任何时刻都不压代码"）。
//   * **同一侧一旦选定就粘住**：列表展开/收起只改高度，不左右上下乱跳；只有当这一侧
//     被滚到几乎没有空间（例如块被顶到视口上沿）才翻到另一侧 —— 翻边也不重叠。

/** 浮层与代码块边缘的距离（px）：视觉"贴着块"但留一条缝 */
export const PICKER_GAP_PX = 6
/** 浮层与视口边缘的最小留白（px）：窄窗口下夹住它，绝不让它顶出页面 */
export const PICKER_VIEWPORT_PAD_PX = 8
/** 浮层宽度上限（px）：能放下 typescript / sequenceDiagram 的就近常量 */
export const PICKER_MAX_WIDTH_PX = 240
/** 浮层宽度上限 ÷ 代码块宽度（用户口径：不超过代码块的 40%） */
export const PICKER_MAX_WIDTH_RATIO = 0.4
/** 浮层高度下限（px）：再挤也要露出输入框那一行 */
export const PICKER_MIN_HEIGHT_PX = 32

export interface PickerRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type PickerSide = 'above' | 'below'

export interface PickerPlacementInput {
  /** 代码块外壳（`.code-block-wrapper`）的视口坐标 */
  block: PickerRect
  viewport: { width: number; height: number }
  /** 浮层当前的自然尺寸（未夹取前） */
  panelWidth: number
  panelHeight: number
  /** 本次打开已经贴住的边；null = 刚打开，按空间挑一边 */
  side: PickerSide | null
}

export interface PickerPlacement {
  side: PickerSide
  left: number
  top: number
  /** 内联 max-width：min(240, 块宽 × 40%, 视口 - 16) */
  maxWidth: number
  /** 内联 max-height：贴的那一侧到视口边缘的空间（≥ PICKER_MIN_HEIGHT_PX） */
  maxHeight: number
}

/** 这一侧从代码块边缘到视口边缘的净空间（已扣掉 gap 与 pad） */
function spaceOn(side: PickerSide, block: PickerRect, viewportHeight: number): number {
  if (side === 'above') {
    return Math.max(0, block.top - PICKER_GAP_PX - PICKER_VIEWPORT_PAD_PX)
  }
  return Math.max(0, viewportHeight - PICKER_VIEWPORT_PAD_PX - block.bottom - PICKER_GAP_PX)
}

/** 两个矩形的交集面积（单测/验收都用它判"压没压到"） */
export function rectIntersectionArea(a: PickerRect, b: PickerRect): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  return w * h
}

/**
 * 算出浮层该摆在哪。
 *
 * 选边规则（按优先级）：
 *   1. 新打开：上方放得下（自然高度 ≤ 上方净空间）→ 上方；否则下方放得下 → 下方；
 *      两边都放不下 → 空间大的那一边（随后靠 maxHeight 夹住，仍然不重叠）。
 *   2. 已经在一侧：空间还剩至少 PICKER_MIN_HEIGHT_PX 就**粘住**（不因列表展开而跳边）；
 *      否则若另一侧更宽裕就翻过去（例如滚动把块顶到视口上沿）。
 *
 * 右边对齐代码块右缘，再按视口左右夹住；垂直方向因为始终在块外，水平怎么夹都不会
 * 压到代码 —— 交集面积的保证来自"top 在块上方/下方"这一条。
 */
export function placePicker(input: PickerPlacementInput): PickerPlacement {
  const { block, viewport, panelWidth, panelHeight } = input
  const above = spaceOn('above', block, viewport.height)
  const below = spaceOn('below', block, viewport.height)

  let side: PickerSide
  if (input.side === null) {
    if (above >= panelHeight) side = 'above'
    else if (below >= panelHeight) side = 'below'
    else side = below > above ? 'below' : 'above'
  } else {
    side = input.side
    const own = side === 'above' ? above : below
    const other = side === 'above' ? below : above
    if (own < PICKER_MIN_HEIGHT_PX && other > own) side = side === 'above' ? 'below' : 'above'
  }

  const space = side === 'above' ? above : below
  const maxHeight = Math.max(PICKER_MIN_HEIGHT_PX, Math.floor(space))
  // 面板高度取"自然高度"和"这一侧空间"的较小值：夹住之后它的边缘正好在 gap 之外
  const height = Math.min(panelHeight, maxHeight)

  const maxWidth = Math.max(
    1,
    Math.min(
      PICKER_MAX_WIDTH_PX,
      Math.floor(block.width * PICKER_MAX_WIDTH_RATIO),
      viewport.width - PICKER_VIEWPORT_PAD_PX * 2
    )
  )
  const width = Math.min(panelWidth, maxWidth)
  // 右对齐块右缘；再夹进视口（左右 8px 留白）
  const left = Math.min(
    Math.max(block.right - width, PICKER_VIEWPORT_PAD_PX),
    Math.max(PICKER_VIEWPORT_PAD_PX, viewport.width - width - PICKER_VIEWPORT_PAD_PX)
  )
  // 上方：底边 = 块顶 - gap；下方：顶边 = 块底 + gap。Math.round 最多挪半像素，仍在块外。
  const top =
    side === 'above'
      ? Math.round(block.top - PICKER_GAP_PX - height)
      : Math.round(block.bottom + PICKER_GAP_PX)

  return { side, left: Math.round(left), top, maxWidth, maxHeight }
}
