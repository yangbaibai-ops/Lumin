<script setup lang="ts">
// 右侧大纲面板（三栏模式）：设置里打开「大纲放在编辑区右侧」后，它出现在编辑区右侧，
// 于是左侧文件树与大纲可以同时看到。
//
//   * 宽度**可拖**：左缘 5px 的拖拽手柄（与左侧栏的手柄同一套做法、同一档钳位 160~420），
//     宽度落在 `outlineRightWidth`，重启保持；
//   * 折叠 / 展开：折叠 = 34px 窄轨（只留一个箭头），展开 = 设定宽度；
//     箭头方向跟着状态翻转（展开时是「›」= 收起，折叠时是「‹」= 展开）。
//     注意 Icon.vue 的 `name` 必须是**响应式**的，否则箭头不会跟着换（本轮修掉的那个 bug）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import Outline from './Outline.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const settings = useSettingsStore()

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
      :class="settings.outlineRightExpanded ? 'justify-between pl-3 pr-1.5' : 'justify-center px-1'"
    >
      <span
        v-if="settings.outlineRightExpanded"
        class="truncate text-ui-sm font-medium text-ink-2b"
        >{{ t('sidebar.outline') }}</span
      >
      <button
        class="icon-btn !h-6.5 !w-6.5"
        data-outline-toggle
        :title="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-label="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-expanded="settings.outlineRightExpanded"
        @click="toggle"
      >
        <Icon :name="settings.outlineRightExpanded ? 'chevron-right' : 'chevron-left'" :size="15" />
      </button>
    </div>

    <!-- 展开时才有列表；折叠态只留那条窄轨（`v-if` 而不是 v-show：
         折叠后列表没有意义，隐藏即可，也不必保留滚动位置） -->
    <div v-if="settings.outlineRightExpanded" class="min-h-0 flex-1 px-1.5 pt-1">
      <Outline />
    </div>
  </aside>
</template>
