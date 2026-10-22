// ─── 大纲位置（左侧边栏 ⇄ 编辑区右侧）的唯一实现 ────────────────────────────────
//
// 这个开关此前只在「设置 → 编辑器」里有一处入口（`SettingsDialog` 直接写 settings）。
// 现在顶部快捷工具栏的视图区、应用内「视图」菜单、原生菜单 + 快捷键都得能用同一件事，
// 于是把「翻这个开关时顺带要做的几件小事」收在这里，避免各处各写一份、慢慢走样。
//
// 规则本身是纯函数 `lib/outlineSideState.ts` 的 `moveOutlineSide`（单测覆盖），这里只负责
// 把 store 里的几个字段读出来、把结果写回去：
//   * 搬到右侧 → 左栏页签收回「文件」，右侧 dock/面板打开；
//   * **搬回左侧 → 左栏强制可见**（用户报障的根因：原来只改了位置，没打开左栏），页签切到
//     「大纲」，并把搬动前左栏的显隐记进 `ui.sidebarVisibleBeforeOutlineLeft`；
//   * 再搬回右侧 → 左栏显隐还原成搬动前的样子（不污染用户的左栏偏好）。
//
// 为什么「搬回左侧」必须把 `settings.sidebarVisible` 也写成 true：重启时 `main.ts` 用
// `settings.sidebarVisible` 初始化 `ui.sidebarVisible`，只改 ui 的话重启后左栏又没了。
// 切回右侧时按记忆把设置值还原（没有记忆则保持当前值）。
import { computed, type ComputedRef } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { moveOutlineSide } from '../lib/outlineSideState'

export interface OutlineSide {
  /** 当前是否「大纲在编辑区右侧」（三栏） */
  onRight: ComputedRef<boolean>
  /** 幂等地设置位置；值是当前值时不写库（设置写盘有成本，也避免多余的重渲染） */
  setOutlineSide: (onRight: boolean) => void
  toggleOutlineSide: () => void
}

export function useOutlineSide(): OutlineSide {
  const settings = useSettingsStore()
  const ui = useUiStore()

  const onRight = computed(() => settings.outlineOnRight)

  function setOutlineSide(next: boolean): void {
    if (settings.outlineOnRight === next) return

    const change = moveOutlineSide(
      {
        outlineOnRight: settings.outlineOnRight,
        sidebarVisible: ui.sidebarVisible,
        sidebarVisibleBefore: ui.sidebarVisibleBeforeOutlineLeft,
        sidebarTab: ui.sidebarTab,
        rightDockVisible: settings.rightDockVisible,
        outlineRightExpanded: settings.outlineRightExpanded
      },
      next
    )
    if (!change.changed) return

    settings.set('outlineOnRight', change.outlineOnRight)
    // 左栏显隐：切到左侧强制 true、切回右侧还原记忆值（见纯函数的说明）
    ui.sidebarVisible = change.sidebarVisible
    if (change.sidebarVisibilityChanged) {
      settings.set('sidebarVisible', change.sidebarVisible)
    }
    ui.sidebarVisibleBeforeOutlineLeft = change.sidebarVisibleBefore
    // 左栏页签：搬家后直接亮出大纲（此刻右侧 dock 因无按钮而隐藏，不亮就「哪都看不到大纲」）
    ui.sidebarTab = change.sidebarTab

    if (change.outlineOnRight) {
      // 既有口径：搬到右侧就得看得见（dock 设置值恢复为开、面板展开）
      settings.set('rightDockVisible', change.rightDockVisible)
      settings.set('outlineRightExpanded', change.outlineRightExpanded)
    }
  }

  return {
    onRight,
    setOutlineSide,
    toggleOutlineSide: () => setOutlineSide(!settings.outlineOnRight)
  }
}
