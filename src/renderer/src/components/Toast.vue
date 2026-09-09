<script setup lang="ts">
import { useUiStore } from '../stores/ui'
import type { ToastItem } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()

// ── 通知样式（按类型着色：左色条 + 淡色图标底）──
const BAR: Record<ToastItem['type'], string> = {
  success: 'bg-ok',
  error: 'bg-danger',
  info: 'bg-accent'
}
const ICON_BG: Record<ToastItem['type'], string> = {
  success: 'bg-[color-mix(in_srgb,var(--ok)_16%,transparent)]',
  error: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]',
  info: 'bg-[color-mix(in_srgb,var(--accent)_13%,transparent)]'
}
const ICON: Record<ToastItem['type'], string> = {
  success: 'text-ok',
  error: 'text-danger',
  info: 'text-accent'
}
const NAME: Record<ToastItem['type'], string> = {
  success: 'check',
  error: 'x',
  info: 'info'
}
</script>

<template>
  <div class="pointer-events-none fixed bottom-12 right-4 z-[200] flex flex-col items-end gap-2">
    <TransitionGroup name="slide">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="relative flex w-[min(360px,calc(100vw-2rem))] items-start gap-2.5 overflow-hidden rounded-xl border border-edge bg-elevate py-2.5 pl-4 pr-3.5 text-[12.5px] shadow-lg backdrop-blur-md"
        :style="{ boxShadow: 'var(--shadow-2)', background: 'color-mix(in srgb, var(--elevate) 92%, transparent)' }"
      >
        <!-- 左侧类型色条 -->
        <span class="absolute inset-y-0 left-0 w-[3px]" :class="BAR[t.type]" />
        <!-- 类型图标（淡色圆底） -->
        <span class="mt-px flex h-6 w-6 flex-none items-center justify-center rounded-lg" :class="ICON_BG[t.type]">
          <Icon :name="NAME[t.type]" :size="14" :class="ICON[t.type]" />
        </span>
        <!-- 消息：允许换行（导出路径等较长文本），超宽处断词 -->
        <span class="min-w-0 flex-1 py-0.5 leading-snug text-ink [overflow-wrap:anywhere]">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>
