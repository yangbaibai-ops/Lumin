<script setup lang="ts">
// ─── 侧栏「最近文档」按钮：位于「新建文件」左侧 ──────────────────────────────
// 点击展开最近文档列表（RecentList 共用组件）；点条目在**新窗口**打开该文档
// （不打扰当前窗口的编辑）。打开文件/打开文件夹仍由顶栏「文件」菜单与侧栏空态承担。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'
import { openInWindowOrFocus } from '../lib/openFile'
import RecentList from './RecentList.vue'
import Icon from './Icon.vue'

const { t } = useI18n()

const POP_WIDTH = 300
const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const open = ref(false)
const pos = ref({ x: 0, y: 0 })

function toggle(): void {
  if (open.value) {
    open.value = false
    return
  }
  const r = rootRef.value?.getBoundingClientRect()
  if (r) {
    pos.value = {
      x: Math.max(8, Math.min(r.left, window.innerWidth - POP_WIDTH - 8)),
      y: r.bottom + 6
    }
  }
  open.value = true
}

/**
 * 最近文档 → 打开：若该文件已经开在某个窗口（含本窗口）就聚焦那个窗口，
 * 否则**新窗口打开**（不替换当前窗口的文档，因此无需脏数据确认）。
 * 判定与落点统一在 lib/openFile.ts。
 */
function openDoc(path: string): void {
  open.value = false
  void openInWindowOrFocus(path)
}

function onDocMouseDown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) return
  open.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) open.value = false
}

/**
 * 滚动/缩放：**菜单内部滚动不关闭**。最近文档列表自带滚动条，滚动它时 scroll
 * 事件会冒到 window；若不加区分就会把菜单关掉——表现为「菜单里有滚动条却滚不动，
 * 一滚就消失」。外部滚动 / 缩放才关闭（见 lib/popoverClose.ts）。
 */
function onWindowScrollOrResize(e: Event): void {
  if (!open.value) return
  if (!shouldCloseOnScrollOrResize(e, panelRef.value)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('scroll', onWindowScrollOrResize, true)
  window.addEventListener('resize', onWindowScrollOrResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('scroll', onWindowScrollOrResize, true)
  window.removeEventListener('resize', onWindowScrollOrResize)
})
</script>

<template>
  <div ref="rootRef" class="shrink-0">
    <button
      class="icon-btn !h-6.5 !w-6.5"
      :class="{ active: open }"
      :title="t('open.recent')"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="clock" :size="14" />
    </button>
  </div>

  <Teleport to="body">
    <Transition name="pop">
      <div
        v-if="open"
        ref="panelRef"
        class="topmenu-drop fixed z-[120] rounded-xl border border-edge bg-elevate p-1.5"
        :style="{
          boxShadow: 'var(--shadow-2)',
          width: POP_WIDTH + 'px',
          left: pos.x + 'px',
          top: pos.y + 'px'
        }"
      >
        <p
          class="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3"
        >
          {{ t('open.recent') }}
        </p>
        <RecentList kind="files" :max="10" @select="openDoc" />
      </div>
    </Transition>
  </Teleport>
</template>
