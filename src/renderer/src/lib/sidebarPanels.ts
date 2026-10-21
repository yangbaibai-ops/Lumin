// ─── 右侧栏「两个按钮」的状态机（纯函数）──────────────────────────────────────
//
// 用户口径：大纲 / AI 是**两个独立按钮**，不是同一视图的两个页签。
// 规则只有三条，收在这里是为了能被单测逐条钉住（组件里只负责渲染与写 store）：
//   1. 点一个**非当前**面板 → 显示该面板（互斥切换）；
//   2. 点**当前**面板 → 收起整栏（"再点一次收起"）；
//   3. 收起态点任意面板 → 展开并显示该面板。
//
// 不在组件里直接写这三个分支的原因：`selectPanel` 与窄轨里的按钮共用同一条规则，
// 两处各写一遍迟早分叉（一边"再点收起"、一边"再点没反应"）。
export type SidebarPanel = 'outline' | 'ai'

export interface SidebarPanelState {
  /** 整栏是否展开（持久化键 settings.outlineRightExpanded） */
  expanded: boolean
  /** 当前显示哪个面板（ui.rightTab） */
  panel: SidebarPanel
}

/** 点某个面板按钮之后的新状态（不修改入参） */
export function clickSidebarPanel(
  state: SidebarPanelState,
  clicked: SidebarPanel
): SidebarPanelState {
  if (state.expanded && state.panel === clicked) {
    return { expanded: false, panel: state.panel }
  }
  return { expanded: true, panel: clicked }
}
