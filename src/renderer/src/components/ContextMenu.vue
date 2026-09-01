<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
const menuRef = ref<HTMLElement | null>(null)

function onDocClick(e: MouseEvent): void {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    ui.closeContextMenu()
  }
}
function onResize(): void {
  ui.closeContextMenu()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('resize', onResize)
})

function pick(action: string): void {
  const handler = ui.contextMenu?.onSelect
  ui.closeContextMenu()
  handler?.(action)
}

function menuStyle(): { left: string; top: string } {
  const c = ui.contextMenu
  if (!c) return { left: '0px', top: '0px' }
  return {
    left: Math.min(c.x, window.innerWidth - 190) + 'px',
    top: Math.min(c.y, window.innerHeight - 260) + 'px'
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="ui.contextMenu"
        ref="menuRef"
        class="fixed z-[160] min-w-[172px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
        :style="{ ...menuStyle(), boxShadow: 'var(--shadow-2)' }"
      >
        <button
          v-for="item in ui.contextMenu.items"
          :key="item.action"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100"
          :class="
            item.danger
              ? 'text-danger hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
              : 'text-ink hover:bg-panel-2'
          "
          :disabled="item.disabled"
          @click="pick(item.action)"
        >
          <Icon v-if="item.icon" :name="item.icon" :size="14" />
          <span class="flex-1">{{ item.label }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
