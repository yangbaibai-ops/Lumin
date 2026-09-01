<script setup lang="ts">
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
</script>

<template>
  <div class="pointer-events-none fixed top-4 left-1/2 z-[200] -translate-x-1/2 flex flex-col items-center gap-2">
    <TransitionGroup name="slide">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[13px] font-medium shadow-lg border backdrop-blur-md"
        :class="[
          t.type === 'success'
            ? 'bg-[color-mix(in_srgb,var(--ok)_14%,var(--elevate))] border-[color-mix(in_srgb,var(--ok)_40%,transparent)] text-ok'
            : t.type === 'error'
              ? 'bg-[color-mix(in_srgb,var(--danger)_12%,var(--elevate))] border-[color-mix(in_srgb,var(--danger)_40%,transparent)] text-danger'
              : 'bg-elevate border-edge text-ink'
        ]"
        :style="{ boxShadow: 'var(--shadow-2)', background: 'var(--elevate)' }"
      >
        <Icon
          :name="t.type === 'success' ? 'check' : t.type === 'error' ? 'x' : 'info'"
          :size="15"
          :class="t.type === 'success' ? 'text-ok' : t.type === 'error' ? 'text-danger' : 'text-accent'"
        />
        <span class="text-ink max-w-[520px] truncate">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>
