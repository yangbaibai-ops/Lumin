// ─── 大纲位置（左侧边栏 ⇄ 编辑区右侧）的唯一实现 ────────────────────────────────
//
// 这个开关此前只在「设置 → 编辑器」里有一处入口（`SettingsDialog` 直接写 settings）。
// 现在顶部快捷工具栏的视图区、应用内「视图」菜单、原生菜单 + 快捷键都得能用同一件事，
// 于是把「翻这个开关时顺带要做的两件小事」收在这里，避免各处各写一份、慢慢走样：
//
//   * 打开（放到右侧）→ 右侧大纲面板设为**展开**、左栏页签收回「文件」。
//     不这么做的话，用户点完可能看到「左栏还停在大纲页签」或「右侧大纲是一条折叠窄轨」，
//     与「打开就能同时看到目录与大纲」的预期不符。
//   * 关掉（放回左侧）→ 左栏页签切到**大纲**：刚才那一步把大纲搬回了左栏，
//     页签跟着亮起来，用户才看得到「它去哪了」（否则左栏还是文件树，像是没反应）。
//
// 与 `AppSidebar.vue` 里那个 `watch(settings.outlineOnRight)` 是同一口径的两半：
// 那边兜住「任何来源把它改成 true」的收敛，这里负责「顺带把状态摆正」。
import { computed, type ComputedRef } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

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
    settings.set('outlineOnRight', next)
    if (next) {
      settings.set('outlineRightExpanded', true)
      ui.sidebarTab = 'files'
    } else {
      ui.sidebarTab = 'outline'
    }
  }

  return {
    onRight,
    setOutlineSide,
    toggleOutlineSide: () => setOutlineSide(!settings.outlineOnRight)
  }
}
