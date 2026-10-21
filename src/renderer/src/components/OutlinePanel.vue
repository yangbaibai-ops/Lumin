<script setup lang="ts">
// ─── 右侧栏（三栏模式）：两个独立按钮（大纲 / AI），可整栏隐藏 ────────────────
//
// 用户口径：**不要「大纲 / AI」页签**。这一栏顶部是两个并排的独立按钮 ——
// 一个打开大纲、一个打开 AI 对话；它们互斥（点哪个就显示哪个面板），
// 再点一次当前按钮 = 收起整栏。按钮用 `aria-pressed` 表达"这个面板正在显示"，
// 不是 tablist / role=tab（没有页签语义，也就没有 roving tabindex 那套方向键规则）。
//
//   * 两个面板**都常驻 DOM**，切换只切显隐 —— 与左侧栏同一口径：聊天记录、滚动位置、
//     大纲滚动位置都不会因为切一次而丢；
//   * 宽度**可拖**：左缘 5px 的拖拽手柄（与左侧栏的手柄同一套做法、同一档钳位 160~420），
//     宽度落在 `outlineRightWidth`，重启保持；
//   * 隐藏 / 显示：隐藏 = 34px 窄轨（大纲 / AI 两枚按钮 + 一枚展开箭头），
//     展开 = 设定宽度；状态落在**既有** `outlineRightExpanded`（SQLite 持久化，重启保持）。
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

/** 两个独立按钮（不是页签）：顺序固定，图标与文案都从这一份表来 */
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
 */
function selectPanel(tab: SidebarPanel): void {
  const next = clickSidebarPanel(
    { expanded: settings.outlineRightExpanded, panel: ui.rightTab },
    tab
  )
  ui.rightTab = next.panel
  settings.set('outlineRightExpanded', next.expanded)
}

/** 隐藏 / 显示整栏；`outlineRightExpanded` 是既有持久化键，重启保持 */
function toggle(): void {
  settings.set('outlineRightExpanded', !settings.outlineRightExpanded)
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
    :data-sidebar-hidden="hidden ? 'true' : 'false'"
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

    <!-- 顶部：两个**独立按钮**（大纲 / AI），互斥切换；右侧是隐藏整栏的开关。
         不是页签：没有 tablist / role=tab / aria-selected，按钮各自带 aria-pressed。 -->
    <div
      v-if="!hidden"
      class="flex flex-none items-center gap-1 border-b border-edge py-1.5 pl-1.5 pr-1.5"
      data-sidebar-buttons
    >
      <button
        v-for="p in PANELS"
        :key="p.id"
        type="button"
        class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-ui font-medium transition-colors duration-150"
        :class="
          isShown(p.id)
            ? 'bg-accent-soft text-ink'
            : 'text-ink-2b hover:bg-accent-soft hover:text-ink-2'
        "
        :data-sidebar-tab="p.id"
        :aria-pressed="isShown(p.id) ? 'true' : 'false'"
        :aria-controls="`sidebar-panel-${p.id}`"
        :aria-label="t(p.labelKey)"
        :title="t(p.labelKey)"
        @click="selectPanel(p.id)"
      >
        <Icon :name="p.icon" :size="13" />
        <span class="truncate">{{ t(p.labelKey) }}</span>
      </button>
      <button
        type="button"
        class="icon-btn !h-6.5 !w-6.5 flex-none"
        data-sidebar-hide
        :title="t('sidebar.hide')"
        :aria-label="t('sidebar.hide')"
        :aria-pressed="'true'"
        :aria-expanded="true"
        @click="toggle"
      >
        <Icon name="outline-panel" :size="15" />
      </button>
    </div>

    <!-- 隐藏态：34px 窄轨。两枚按钮仍然可达（点一下直接展开并显示该面板），
         另有一枚「显示侧边栏」箭头 —— 满足"隐藏时给一个窄轨可再打开"。 -->
    <div v-else class="flex flex-none flex-col items-center gap-1 px-1 py-1.5" data-sidebar-rail>
      <button
        v-for="p in PANELS"
        :key="p.id"
        type="button"
        class="icon-btn !h-6.5 !w-6.5"
        :data-sidebar-tab="p.id"
        :aria-pressed="'false'"
        :aria-label="t(p.labelKey)"
        :title="t(p.labelKey)"
        @click="selectPanel(p.id)"
      >
        <Icon :name="p.icon" :size="14" />
      </button>
      <button
        type="button"
        class="icon-btn !h-6.5 !w-6.5"
        data-sidebar-show
        :title="t('sidebar.show')"
        :aria-label="t('sidebar.show')"
        :aria-pressed="'false'"
        :aria-expanded="'false'"
        @click="toggle"
      >
        <Icon name="chevron-left" :size="15" />
      </button>
    </div>

    <!-- 展开时才有内容；隐藏态只留窄轨。两个面板**都常驻 DOM**（切换只切显隐，
         聊天记录/滚动位置不丢），与左侧栏 AppSidebar 的口径一致。 -->
    <div v-if="!hidden" class="flex min-h-0 flex-1 flex-col">
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
