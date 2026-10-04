// ─── 大纲位置（左侧边栏 ⇄ 编辑区右侧）的唯一实现 ────────────────────────────────
//
// 这个开关此前只在「设置 → 编辑器」里有一处入口（`SettingsDialog` 直接写 settings）。
// 现在顶部快捷工具栏的视图区、应用内「视图」菜单、原生菜单 + 快捷键都得能用同一件事，
// 于是把「翻这个开关时顺带要做的两件小事」收在这里，避免各处各写一份、慢慢走样：
//
//   * 打开（放到右侧）→ 右侧大纲面板设为**展开**、左栏页签收回「文件」，
//     并**记住左栏刚才显示的是哪一页**（用户口径：搬回来要回到那一页）。
//     不这么做的话，用户点完可能看到「左栏还停在大纲页签」或「右侧大纲是一条折叠窄轨」，
//     与「打开就能同时看到目录与大纲」的预期不符。
//   * 关掉（放回左侧）→ 左栏页签**恢复成打开前那一页**（第十轮用户口径）：
//        - 打开前在「文件」⇒ 回「文件」（大纲回左栏了，但用户本来就在看目录，不该被切走）；
//        - 打开前在「大纲」⇒ 回「大纲」（这也顺带保住了旧行为：刚把大纲搬回来，页签跟着亮，
//          用户看得到"它去哪了"）；
//        - 没有记录（例如启动时 `outlineOnRight` 就已经是 true）⇒ 退回「大纲」，
//          因为那一步刚把大纲搬回左栏，亮起它是最不容易让人迷惑的默认。
//
// 与 `AppSidebar.vue` 里那个 `watch(settings.outlineOnRight)` 是同一口径的两半：
// 那边兜住「任何来源把它改成 true」的收敛（页签收回「文件」），这里负责「顺带把状态摆正」。
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
      // 先记账再改页签：顺序反了就永远记成「文件」（那正是要避免的）
      ui.sidebarTabBeforeOutlineRight = ui.sidebarTab
      settings.set('outlineRightExpanded', true)
      ui.sidebarTab = 'files'
    } else {
      ui.sidebarTab = ui.sidebarTabBeforeOutlineRight ?? 'outline'
      ui.sidebarTabBeforeOutlineRight = null
    }
  }

  return {
    onRight,
    setOutlineSide,
    toggleOutlineSide: () => setOutlineSide(!settings.outlineOnRight)
  }
}
