<script setup lang="ts">
// ─── 右侧面板（大纲）：停在 40px 停靠栏的**左侧** ─────────────────────────────
//
// 用户口径（第三次澄清）：停靠栏与面板是两块 DOM。
//   * 本组件只负责面板内容与拖拽调宽，**不再渲染任何按钮**（按钮在 RightDock.vue）；
//   * 面板显隐 = `settings.outlineRightExpanded`，与 dock 是否存在无关；
//   * 面板内容常驻 DOM（`v-show`），收起/展开不会丢大纲滚动位置；
//   * 宽度沿用 `settings.outlineRightWidth`（钳 160~420），左缘 5px 手柄可拖、可键盘调。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import Outline from './Outline.vue'

const { t } = useI18n()
const settings = useSettingsStore()

const OUTLINE_MIN = 160
const OUTLINE_MAX = 420

const width = computed({
  get: () => settings.outlineRightWidth,
  set: (v: number) =>
    settings.set('outlineRightWidth', Math.max(OUTLINE_MIN, Math.min(OUTLINE_MAX, v)))
})

// ── 拖拽调宽：手柄在面板**左缘**，宽度 = 面板右缘（dock 左边缘）到指针的距离 ──
const dragRef = ref<HTMLElement | null>(null)
const dragging = ref(false)

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
  if (!settings.outlineRightExpanded) return
  const panel = dragRef.value
  if (!panel) return
  // 面板右侧是 dock（不是窗口右缘）：用面板自己的右缘算，拖拽才不会差 40px
  const rightEdge = panel.getBoundingClientRect().right
  dragging.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const move = (ev: MouseEvent): void => {
    width.value = rightEdge - ev.clientX
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
    v-show="settings.outlineRightExpanded"
    ref="dragRef"
    data-outline-panel
    data-right-dock-panel
    data-sidebar
    data-sidebar-collapsed="false"
    class="relative flex h-full flex-none flex-col border-l border-edge bg-app"
    :style="{ '--outline-w': settings.outlineRightWidth + 'px' }"
  >
    <!-- 左缘拖拽手柄（5px 热区，悬停显色；键盘方向键调宽） -->
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

    <!-- 面板内容常驻 DOM，只切显隐：大纲滚动位置在收起/再打开之间保留。 -->
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        id="right-dock-panel-outline"
        class="min-h-0 flex-1 px-1.5 pt-1"
        role="region"
        :aria-label="t('sidebar.outline')"
      >
        <Outline />
      </div>
    </div>
  </aside>
</template>
