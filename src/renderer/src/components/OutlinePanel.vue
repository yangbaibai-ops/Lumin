<script setup lang="ts">
// ─── 右侧面板（三栏模式）：大纲 / AI 对话 ─────────────────────────────────────
//
// 设置里打开「大纲放在编辑区右侧」后，编辑区右侧出现这一栏；栏内有两个页签：
//   * 大纲（默认）：沿用原来的可拖宽 / 折叠行为；
//   * AI 对话：右侧栏形态的对话面板（`AiChatPanel.vue`）。
// 两个面板**都常驻 DOM**，切页签只切显隐 —— 与左侧栏同一口径：聊天记录、滚动位置、
// 大纲滚动位置都不会因为切一次页签而丢。
//
//   * 宽度**可拖**：左缘 5px 的拖拽手柄（与左侧栏的手柄同一套做法、同一档钳位 160~420），
//     宽度落在 `outlineRightWidth`，重启保持；
//   * 折叠 / 展开：折叠 = 34px 窄轨（只留一个箭头），展开 = 设定宽度；
//     箭头方向跟着状态翻转（展开时是「›」= 收起，折叠时是「‹」= 展开）。
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Outline from './Outline.vue'
import AiChatPanel from './AiChatPanel.vue'
import Icon from './Icon.vue'

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

function toggle(): void {
  settings.set('outlineRightExpanded', !settings.outlineRightExpanded)
}

// ── 页签（大纲 / AI 对话）────────────────────────────────────────────────────
const RIGHT_TABS = ['outline', 'ai'] as const

/**
 * 键盘路径（与左侧栏 AppSidebar 同一口径）：← → 在两项间移动并把焦点带过去，
 * Home/End 到两端；选中项 Tab 可进入、其余项用方向键到达。
 */
function onTabsKeydown(e: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const cur = RIGHT_TABS.indexOf(ui.rightTab)
  const next =
    e.key === 'ArrowRight'
      ? RIGHT_TABS[(Math.max(0, cur) + 1) % RIGHT_TABS.length]
      : e.key === 'ArrowLeft'
        ? RIGHT_TABS[(Math.max(0, cur) + RIGHT_TABS.length - 1) % RIGHT_TABS.length]
        : e.key === 'Home'
          ? RIGHT_TABS[0]
          : RIGHT_TABS[RIGHT_TABS.length - 1]
  ui.rightTab = next
  void nextTick(() => {
    document.querySelector<HTMLElement>(`[data-right-tab="${next}"]`)?.focus()
  })
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

    <div
      class="flex flex-none items-center gap-1 border-b border-edge py-1.5"
      :class="settings.outlineRightExpanded ? 'pl-1.5 pr-1.5' : 'justify-center px-1'"
    >
      <!-- 两个页签：与左侧栏同一套 tab 语义/样式（选中项下方一条 accent 渐变细线） -->
      <div
        v-if="settings.outlineRightExpanded"
        class="flex min-w-0 flex-1 gap-1"
        role="tablist"
        :aria-label="t('sidebar.outline') + ' / ' + t('ai.chat.tab')"
        data-right-tablist
        @keydown="onTabsKeydown"
      >
        <button
          v-for="tab in RIGHT_TABS"
          :id="`right-tab-${tab}`"
          :key="tab"
          role="tab"
          :aria-selected="ui.rightTab === tab ? 'true' : 'false'"
          :aria-controls="`right-panel-${tab}`"
          :tabindex="ui.rightTab === tab ? 0 : -1"
          class="relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-ui font-medium transition-all duration-200"
          :class="ui.rightTab === tab ? 'text-ink' : 'text-ink-2b hover:text-ink-2'"
          :data-right-tab="tab"
          @click="ui.rightTab = tab"
        >
          <Icon :name="tab === 'outline' ? 'list' : 'sparkles'" :size="13" />
          <span class="truncate">{{
            tab === 'outline' ? t('sidebar.outline') : t('ai.chat.tab')
          }}</span>
          <span
            v-if="ui.rightTab === tab"
            class="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-gradient-to-r from-accent to-accent-2"
            style="animation: lm-fade-in 0.25s ease"
          />
        </button>
      </div>
      <button
        class="icon-btn !h-6.5 !w-6.5 flex-none"
        data-outline-toggle
        :title="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-label="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-expanded="settings.outlineRightExpanded"
        @click="toggle"
      >
        <Icon :name="settings.outlineRightExpanded ? 'chevron-right' : 'chevron-left'" :size="15" />
      </button>
    </div>

    <!-- 展开时才有内容；折叠态只留那条窄轨。两个面板**都常驻 DOM**（切页签只切显隐，
         聊天记录/滚动位置不丢），与左侧栏 AppSidebar 的口径一致。 -->
    <div v-if="settings.outlineRightExpanded" class="flex min-h-0 flex-1 flex-col">
      <div
        v-show="ui.rightTab === 'outline'"
        id="right-panel-outline"
        class="min-h-0 flex-1 px-1.5 pt-1"
        role="tabpanel"
        aria-labelledby="right-tab-outline"
      >
        <Outline />
      </div>
      <div
        v-show="ui.rightTab === 'ai'"
        id="right-panel-ai"
        class="min-h-0 flex-1"
        role="tabpanel"
        aria-labelledby="right-tab-ai"
      >
        <AiChatPanel :active="ui.rightTab === 'ai'" />
      </div>
    </div>
  </aside>
</template>
