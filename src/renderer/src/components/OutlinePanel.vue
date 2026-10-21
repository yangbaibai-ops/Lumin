<script setup lang="ts">
// ─── 右侧栏（三栏模式）：只有两个按钮（大纲 / AI），点一下开、再点一下收 ──────────
//
// 用户口径：**不要「大纲 / AI」页签**，也**不要额外的"隐藏/显示侧边栏"按钮**。
// 这一栏顶部只有两个独立按钮 —— 一个打开大纲、一个打开 AI 对话：
//   * 点「大纲」→ 显示大纲；再点「大纲」→ 整栏收起（只剩窄条上的两个按钮）；
//   * 点「AI」→ 显示 AI；再点「AI」→ 收起；
//   * 两者互斥：点另一个直接切过去；收起态点任意一枚 → 展开并显示它。
// 按钮用 `aria-pressed` 表达"这个面板正在显示"，不是 tablist / role=tab
// （没有页签语义，也就没有 roving tabindex 那套方向键规则）。
//
//   * 两个面板**都常驻 DOM**，收起只是 `v-show` 隐藏整块内容 —— 聊天记录、大纲滚动位置
//     都不会因为收起/再打开而丢；
//   * 宽度**可拖**：左缘 5px 的拖拽手柄（与左侧栏的手柄同一套做法、同一档钳位 160~420），
//     宽度落在 `outlineRightWidth`，重启保持；
//   * 收起 / 展开：状态落在**既有** `outlineRightExpanded`（SQLite 持久化，重启保持）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Outline from './Outline.vue'
import AiChatPanel from './AiChatPanel.vue'
import Icon from './Icon.vue'
import { clickSidebarPanel, type SidebarPanel } from '../lib/sidebarPanels'

const { t } = useI18n()
const settings = useSettingsStore()
const ui = useUiStore()

/** 折叠态固定 34px；展开态用设置里的宽度（拖拽与键盘都走这一档钳位） */
const OUTLINE_MIN = 160
const OUTLINE_MAX = 420
const width = computed({
  get: () => settings.outlineRightWidth,
  set: (v: number) =>
    settings.set('outlineRightWidth', Math.max(OUTLINE_MIN, Math.min(OUTLINE_MAX, v)))
})
const panelWidth = computed(() => (settings.outlineRightExpanded ? width.value : 34))
const hidden = computed(() => !settings.outlineRightExpanded)

/** 只有两个按钮（不是页签）：顺序固定，图标与文案都从这一份表来 */
const PANELS = [
  { id: 'outline', icon: 'list', labelKey: 'sidebar.outline' },
  { id: 'ai', icon: 'sparkles', labelKey: 'ai.chat.tab' }
] as const satisfies readonly {
  id: SidebarPanel
  icon: string
  labelKey: string
}[]

function isShown(tab: SidebarPanel): boolean {
  return settings.outlineRightExpanded && ui.rightTab === tab
}

/**
 * 点按钮：规则只有一份（lib/sidebarPanels.ts）——
 * 互斥切换；**再点当前面板 = 收起整栏**；收起态点任意一枚 = 展开并显示它。
 * 没有独立的"隐藏/显示"按钮：收起这一动作只挂在当前面板按钮的第二次点击上。
 */
function selectPanel(tab: SidebarPanel): void {
  const next = clickSidebarPanel(
    { expanded: settings.outlineRightExpanded, panel: ui.rightTab },
    tab
  )
  ui.rightTab = next.panel
  settings.set('outlineRightExpanded', next.expanded)
}

// ── 拖拽调宽：手柄在面板**左缘**，所以宽度 = 窗口右缘到指针的距离 ──
const dragging = ref(false)

/**
 * 键盘调宽（与 AppSidebar 同一口径）：本面板在右边，所以「把分隔条往左拖」＝变宽，
 * 即 ← 是加宽、→ 是变窄 —— 方向跟的是**分隔条的移动方向**，不是宽度的增减。
 */
function onResizeKeydown(e: KeyboardEvent): void {
  const step = e.shiftKey ? 40 : 16
  if (e.key === 'ArrowLeft') width.value = width.value + step
  else if (e.key === 'ArrowRight') width.value = width.value - step
  else if (e.key === 'Home') width.value = OUTLINE_MAX
  else if (e.key === 'End') width.value = OUTLINE_MIN
  else return
  e.preventDefault()
}

function onDragStart(e: MouseEvent): void {
  if (!settings.outlineRightExpanded) return // 折叠态是窄轨，先展开再拖
  dragging.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const move = (ev: MouseEvent): void => {
    width.value = window.innerWidth - ev.clientX
  }
  const up = (): void => {
    dragging.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  e.preventDefault()
}
</script>

<template>
  <aside
    data-outline-panel
    data-sidebar
    :data-sidebar-collapsed="hidden ? 'true' : 'false'"
    class="relative flex h-full flex-none flex-col border-l border-edge bg-app"
    :class="dragging ? '' : 'transition-[width] duration-200'"
    :style="{ '--outline-w': panelWidth + 'px' }"
  >
    <!-- 左缘拖拽手柄（与 AppSidebar 的手柄同一套做法：5px 热区，悬停显色；
         键盘可用方向键调宽，见 onResizeKeydown） -->
    <div
      v-if="settings.outlineRightExpanded"
      class="absolute -left-[3px] top-0 z-[var(--z-grip)] h-full w-[5px] cursor-col-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      :class="dragging ? 'opacity-100' : ''"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('outline.resize')"
      :aria-valuenow="width"
      :aria-valuemin="OUTLINE_MIN"
      :aria-valuemax="OUTLINE_MAX"
      tabindex="0"
      data-outline-resize
      @mousedown="onDragStart"
      @keydown="onResizeKeydown"
    >
      <div
        class="mx-auto h-full w-px transition-colors"
        :class="dragging ? 'bg-accent' : 'bg-transparent'"
      />
    </div>

    <!-- 整栏顶部**只有两枚按钮**（大纲 / AI）：展开时是并排的两个带字按钮，
         收起时同一组按钮变成 34px 窄条上的两枚图标按钮 —— 收起态也始终可见可点。
         没有 tablist / role=tab / aria-selected，按钮各自带 aria-pressed。 -->
    <div
      class="flex flex-none"
      :class="
        hidden
          ? 'flex-col items-center gap-1 px-1 py-1.5'
          : 'items-center gap-1 border-b border-edge py-1.5 pl-1.5 pr-1.5'
      "
      :data-sidebar-rail="hidden ? 'true' : undefined"
      data-sidebar-buttons
    >
      <button
        v-for="p in PANELS"
        :key="p.id"
        type="button"
        class="flex items-center justify-center rounded-lg transition-colors duration-150"
        :class="
          hidden
            ? 'icon-btn !h-6.5 !w-6.5'
            : 'min-w-0 flex-1 gap-1.5 px-2 py-1.5 text-ui font-medium'
        "
        :data-sidebar-tab="p.id"
        :aria-pressed="isShown(p.id) ? 'true' : 'false'"
        :aria-controls="`sidebar-panel-${p.id}`"
        :aria-label="t(p.labelKey)"
        :title="t(p.labelKey)"
        @click="selectPanel(p.id)"
      >
        <Icon :name="p.icon" :size="hidden ? 14 : 13" />
        <span v-if="!hidden" class="truncate">{{ t(p.labelKey) }}</span>
      </button>
    </div>

    <!-- 面板内容常驻 DOM，收起时只切显隐（`v-show`）：
         大纲的滚动位置、AI 的聊天记录在收起/再打开之间原样保留。 -->
    <div v-show="!hidden" class="flex min-h-0 flex-1 flex-col">
      <div
        v-show="ui.rightTab === 'outline'"
        id="sidebar-panel-outline"
        class="min-h-0 flex-1 px-1.5 pt-1"
        role="region"
        :aria-label="t('sidebar.outline')"
      >
        <Outline />
      </div>
      <div
        v-show="ui.rightTab === 'ai'"
        id="sidebar-panel-ai"
        class="min-h-0 flex-1"
        role="region"
        :aria-label="t('ai.chat.tab')"
      >
        <AiChatPanel :active="ui.rightTab === 'ai'" />
      </div>
    </div>
  </aside>
</template>
