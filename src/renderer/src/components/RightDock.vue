<script setup lang="ts">
// ─── 右侧停靠栏（dock）：窗口最右侧常驻的 40px 竖条 ─────────────────────────────
//
// 用户口径（第三次澄清）：
//   * 停靠栏与面板是**两块 DOM** —— dock 常驻，面板在它左侧；
//   * dock 上**只有两个按钮**：大纲 / AI（图标 + tooltip + aria-pressed）；
//   * 点当前按钮 → 面板收起但 dock 还在；点另一个 → 切换并展开；
//   * 整条 dock 的显隐只由设置 `rightDockVisible` 决定（编辑器外层用 v-show 包裹）。
//
// 这里**没有** tablist / role=tab / aria-selected：两个按钮是独立动作，不是页签。
// 状态规则全部走 `lib/sidebarPanels.ts` 的纯函数，组件只负责渲染与写 store。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'
import {
  clickRightDockButton,
  isRightDockPanelVisible,
  type RightDockState,
  type SidebarPanel
} from '../lib/sidebarPanels'

const { t } = useI18n()
const settings = useSettingsStore()

/** 按钮表只有这两项：顺序固定，图标与文案都从这里来 */
const PANELS = [
  { id: 'outline', icon: 'list', labelKey: 'sidebar.outline', panelId: 'right-dock-panel-outline' },
  { id: 'ai', icon: 'sparkles', labelKey: 'ai.chat.tab', panelId: 'right-dock-panel-ai' }
] as const satisfies readonly {
  id: SidebarPanel
  icon: string
  labelKey: string
  panelId: string
}[]

const state = computed<RightDockState>(() => ({
  active: settings.rightDockActive,
  expanded: settings.outlineRightExpanded,
  rightDockVisible: settings.rightDockVisible
}))

/** 点按钮：同按钮两次 = 收起面板；不同按钮 = 切换并展开（规则只有一份） */
function selectPanel(panel: SidebarPanel): void {
  const next = clickRightDockButton(state.value, panel)
  if (!next.rightDockVisible) return
  settings.set('rightDockActive', next.active)
  settings.set('outlineRightExpanded', next.expanded)
}
</script>

<template>
  <aside
    data-right-dock
    role="toolbar"
    aria-orientation="vertical"
    :aria-label="t('settings.rightDock')"
    class="flex h-full w-10 flex-none flex-col items-center gap-1 border-l border-edge bg-app py-2"
  >
    <button
      v-for="p in PANELS"
      :key="p.id"
      type="button"
      class="icon-btn"
      :class="{ active: isRightDockPanelVisible(state, p.id) }"
      data-right-dock-button
      :data-panel="p.id"
      :aria-pressed="isRightDockPanelVisible(state, p.id) ? 'true' : 'false'"
      :aria-controls="p.panelId"
      :aria-label="t(p.labelKey)"
      :title="t(p.labelKey)"
      @click="selectPanel(p.id)"
    >
      <Icon :name="p.icon" :size="15" />
    </button>
  </aside>
</template>
