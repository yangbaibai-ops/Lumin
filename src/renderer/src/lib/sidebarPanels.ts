// ─── 右侧停靠栏「大纲」按钮的状态机（纯函数）──────────────────────────────────
//
// 用户口径：主分支移除 AI 后，停靠栏上**只保留「大纲」一个按钮**；停靠栏本身常驻，
// 点按钮只控制它左侧的面板：
//   1. 点**当前**面板 → 收起面板（停靠栏仍然在）；
//   2. 面板收起时点按钮 → 展开并显示大纲；
//   3. `rightDockVisible = false`（设置里关掉「显示右侧停靠栏」）→ 整条 dock 与面板都不显示，
//      此时按钮不可达，状态机原样返回。
//
// 三个状态分开存：
//   * `active`        当前选中的面板（settings.rightDockActive，落库，重启恢复）
//   * `expanded`      面板是否展开（settings.outlineRightExpanded）
//   * `rightDockVisible` 整条停靠栏是否显示（settings.rightDockVisible，默认 true）
// 这样「收起面板」不会把 `active` 清掉 —— 设置里关掉再打开、或重启后仍回到大纲。
export type SidebarPanel = 'outline'

export interface RightDockState {
  /** 当前选中的面板（与 expanded 无关） */
  active: SidebarPanel
  /** 面板是否展开；false = 只剩停靠栏 */
  expanded: boolean
  /** 整条停靠栏是否显示（设置里的「显示右侧停靠栏」） */
  rightDockVisible: boolean
}

/** 点面板按钮之后的新状态（不修改入参） */
export function clickRightDockButton(state: RightDockState, clicked: SidebarPanel): RightDockState {
  // 停靠栏被设置关掉时按钮不可达；兜底保持原状，避免任何程序化点击“隔空”打开面板
  if (!state.rightDockVisible) return state
  if (state.expanded && state.active === clicked) {
    return { ...state, expanded: false }
  }
  return { ...state, active: clicked, expanded: true }
}

/** 某个面板此刻是否真的可见（dock 关掉时，即使 expanded 记录为 true 也不可见） */
export function isRightDockPanelVisible(state: RightDockState, panel: SidebarPanel): boolean {
  return state.rightDockVisible && state.expanded && state.active === panel
}

/** 停靠栏本身是否可见（与面板展开无关） */
export function isRightDockVisible(state: RightDockState): boolean {
  return state.rightDockVisible
}
