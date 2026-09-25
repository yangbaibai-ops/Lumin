<script setup lang="ts">
// ─── 本地历史浮层（Wave 2 数据安全）──────────────────────────────────────────
// 列出当前文档**保存前**的快照（每写盘一次留一份「即将被覆盖的那一版」），
// 点击载入编辑器（不直接写盘 —— 用户看清了再 Ctrl+S，见 files.restoreHistory 的取舍）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useFilesStore } from '../stores/files'
import Icon from './Icon.vue'
import type { HistoryEntryMeta } from '../../../shared/types'

const { t } = useI18n()
const ui = useUiStore()
const files = useFilesStore()

const loadingId = ref<number | null>(null)

const open = computed(() => ui.localHistory.open)
const entries = computed(() => ui.localHistory.entries)
const fileName = computed(() => ui.localHistory.path?.split(/[\\/]/).pop() ?? '')

function formatTime(savedAt: number): string {
  const d = new Date(savedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 载入某一条到编辑器（关掉浮层，让用户直接看到正文） */
async function restore(entry: HistoryEntryMeta): Promise<void> {
  loadingId.value = entry.id
  try {
    const full = await window.luminAPI.history.get(entry.id)
    if (!full) return
    await files.restoreHistory(full)
    ui.closeLocalHistory()
  } finally {
    loadingId.value = null
  }
}

async function clearAll(): Promise<void> {
  const path = ui.localHistory.path
  if (!path) return
  const ok = await ui.confirm({
    title: t('history.clearTitle'),
    body: t('history.clearBody'),
    danger: true
  })
  if (!ok) return
  await window.luminAPI.history.clear(path)
  ui.localHistory.entries = []
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) ui.closeLocalHistory()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// 打开时聚焦面板，方便 Esc 关闭
const panelRef = ref<HTMLElement | null>(null)
watch(open, (v) => {
  if (v) requestAnimationFrame(() => panelRef.value?.focus())
})
</script>

<template>
  <Transition name="pop">
    <div
      v-if="open"
      class="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-[12vh]"
      data-local-history
      role="dialog"
      aria-modal="true"
      :aria-label="t('history.title')"
      @click.self="ui.closeLocalHistory()"
    >
      <div
        ref="panelRef"
        tabindex="-1"
        class="surface flex max-h-[70vh] w-[620px] flex-col overflow-hidden shadow-2xl outline-none"
      >
        <header class="flex items-center gap-2 border-b border-edge px-4 py-3">
          <Icon name="clock" :size="15" />
          <h2 class="text-[13.5px] font-semibold text-ink">{{ t('history.title') }}</h2>
          <span class="truncate text-[12px] text-ink-3">{{ fileName }}</span>
          <div class="flex-1" />
          <button
            v-if="entries.length"
            class="btn btn-ghost px-2 py-1 text-[12px]"
            data-history-clear
            @click="clearAll"
          >
            {{ t('history.clear') }}
          </button>
          <button
            class="btn btn-ghost px-2 py-1"
            :title="t('common.close')"
            @click="ui.closeLocalHistory()"
          >
            <Icon name="x" :size="13" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <p v-if="ui.localHistory.loading" class="px-3 py-6 text-center text-[12.5px] text-ink-3">
            {{ t('common.loading') }}
          </p>
          <p
            v-else-if="!entries.length"
            class="px-3 py-8 text-center text-[12.5px] leading-relaxed text-ink-3"
            data-history-empty
          >
            {{ t('history.empty') }}
          </p>
          <ul v-else class="flex flex-col gap-1">
            <li v-for="e in entries" :key="e.id">
              <button
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-panel-2"
                :data-history-item="e.id"
                :disabled="loadingId === e.id"
                @click="restore(e)"
              >
                <Icon name="clock" :size="13" class="shrink-0 text-ink-3" />
                <span class="w-[150px] shrink-0 tabular-nums text-[12.5px] text-ink-2">
                  {{ formatTime(e.savedAt) }}
                </span>
                <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink">{{
                  e.preview || t('history.blankSnapshot')
                }}</span>
                <span class="shrink-0 tabular-nums text-[11.5px] text-ink-3">{{
                  formatSize(e.size)
                }}</span>
                <Icon name="undo" :size="13" class="shrink-0 text-ink-3" />
              </button>
            </li>
          </ul>
        </div>

        <footer class="border-t border-edge px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
          {{ t('history.hint') }}
        </footer>
      </div>
    </div>
  </Transition>
</template>
