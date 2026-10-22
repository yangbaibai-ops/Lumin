// ─── 「大纲位置」搬动时的状态收敛（纯函数）────────────────────────────────────
//
// 用户报障（本轮）：大纲在编辑区右侧、左栏已收起时，点「把大纲放回左侧边栏」，
// **左侧什么都不出现** —— 根因是原实现只改了 `outlineOnRight` 与页签，
// 没有把 `ui.sidebarVisible`（左栏显隐）打开：`App.vue` 用 `v-if="ui.sidebarVisible"`
// 渲染整条左栏，于是大纲虽然挂回了左栏，整条左栏却仍是不存在的。
//
// 这里把「搬一次大纲位置，左栏/右栏各自该变成什么」收成一份可单测的纯函数：
//
//   搬到左侧（onRight = false）：
//     * 左栏**强制可见**（这是本轮修的核心）：`ui.sidebarVisible` 与 `settings.sidebarVisible`
//       一起置 true，否则重启后 `main.ts` 仍会按旧设置把它藏起来；
//     * 把搬动前的左栏显隐记进 `sidebarVisibleBefore`（会话内记忆），切回右侧时原样还回去 ——
//       用户原来收起了左栏，切回右侧后左栏必须还是收起的；
//     * 页签切到「大纲」：搬回来的就是大纲，而且此刻右侧 dock 因无按钮而整条隐藏，
//       若左栏还停在「文件」，用户会看不到大纲（页签随时可切回文件）；
//     * `rightDockVisible` 不动 —— 它记录的是用户在设置里的偏好，只是渲染条件不再满足。
//
//   搬到右侧（onRight = true）：
//     * 左栏显隐**恢复搬动前**的状态（`sidebarVisibleBefore`），没有记忆时保持当前；不写死 false，
//       避免把用户本来开着的左栏顺手关掉，也避免把他本来关着的左栏顺手打开；
//     * 页签收回「文件」（三栏模式下左栏只承担文件树，页签行整行隐藏）；
//     * 右侧面板展开、dock 设置值打开（既有口径：搬过去就得看得见）。
//
// 为什么 `sidebarVisibilityChanged` 单独返回：设置写盘有成本（整份 settings 写 SQLite +
// 广播），只有真的变了才写；调用方据此决定是否 `settings.set('sidebarVisible', …)`。
export type SidebarTab = 'files' | 'outline'

export interface OutlineSideState {
  /** 当前大纲是否在编辑区右侧（settings.outlineOnRight） */
  outlineOnRight: boolean
  /** 左栏此刻是否可见（ui.sidebarVisible） */
  sidebarVisible: boolean
  /** 上次「搬到左侧」之前记下的左栏显隐（null = 没有记忆，例如重启后） */
  sidebarVisibleBefore: boolean | null
  /** 左栏页签（ui.sidebarTab） */
  sidebarTab: SidebarTab
  /** 设置里的「显示右侧停靠栏」（用户偏好，搬左侧时不许改） */
  rightDockVisible: boolean
  /** 右侧大纲面板是否展开 */
  outlineRightExpanded: boolean
}

export interface OutlineSideNext extends OutlineSideState {
  /** 这次调用是否真的搬了位置（false = 幂等调用，什么都没改） */
  changed: boolean
  /** 左栏显隐是否发生了变化（调用方据此决定要不要写 settings） */
  sidebarVisibilityChanged: boolean
}

/** 搬一次大纲位置：返回完整的目标状态，不修改入参 */
export function moveOutlineSide(state: OutlineSideState, onRight: boolean): OutlineSideNext {
  // 幂等：已经在目标位置 ⇒ 原样返回，**不要**用当前值覆盖记忆（否则「原状态」会被自己污染）
  if (state.outlineOnRight === onRight) {
    return { ...state, changed: false, sidebarVisibilityChanged: false }
  }

  if (onRight) {
    const sidebarVisible = state.sidebarVisibleBefore ?? state.sidebarVisible
    return {
      outlineOnRight: true,
      sidebarVisible,
      sidebarVisibleBefore: null,
      sidebarTab: 'files',
      rightDockVisible: true,
      outlineRightExpanded: true,
      changed: true,
      sidebarVisibilityChanged: sidebarVisible !== state.sidebarVisible
    }
  }

  return {
    outlineOnRight: false,
    sidebarVisible: true,
    // 先记后改：顺序反了就永远记成「可见」，切回右侧时再也回不到用户原本的收起状态
    sidebarVisibleBefore: state.sidebarVisible,
    sidebarTab: 'outline',
    // dock 偏好保持用户设置值；渲染层用「有可用按钮」把它暂时藏起来
    rightDockVisible: state.rightDockVisible,
    outlineRightExpanded: state.outlineRightExpanded,
    changed: true,
    sidebarVisibilityChanged: state.sidebarVisible !== true
  }
}
