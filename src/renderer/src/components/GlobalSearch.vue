<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useFindStore } from '../stores/find'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import { highlightSegments } from '../lib/highlight'
import type { IndexStatus, SearchResult } from '../../../shared/types'
import Icon from './Icon.vue'

const ui = useUiStore()
const files = useFilesStore()
const find = useFindStore()
const router = useRouter()
const { t } = useI18n()

/**
 * 全文索引进度（审计 §7 第 17 条）：打开工作区后主进程在**后台**把「从未打开过」的
 * 文档也收进搜索。这里把"还在索引"如实显示出来 —— 否则用户会把"搜不到"当成"没有"。
 */
const indexStatus = ref<IndexStatus>({ root: null, scanned: 0, indexed: 0, running: false })
let offIndexProgress: (() => void) | null = null

const inputEl = ref<HTMLInputElement | null>(null)
const activeIdx = ref(0)
let debounce: ReturnType<typeof setTimeout> | null = null

async function runSearch(): Promise<void> {
  const q = ui.globalSearch.query.trim()
  if (!q) {
    ui.globalSearch.results = []
    ui.globalSearch.loading = false
    return
  }
  ui.globalSearch.loading = true
  try {
    const results = await window.luminAPI.db.search(q, 30)
    ui.globalSearch.results = results
    activeIdx.value = 0
  } finally {
    ui.globalSearch.loading = false
  }
}

watch(
  () => ui.globalSearch.query,
  () => {
    clearTimeout(debounce as never)
    debounce = setTimeout(() => void runSearch(), 180)
  }
)

watch(
  () => ui.globalSearch.open,
  (open) => {
    if (open) void nextTick(() => inputEl.value?.focus())
  }
)

async function openResult(r: SearchResult): Promise<void> {
  const query = ui.globalSearch.query.trim()
  ui.closeGlobalSearch()
  if (!(await confirmIfDirty())) return
  if (await files.openPath(r.path)) {
    await router.push('/editor')
    // 定位到命中处（审计 §7 第 17 条：点结果不该只把文件打开、还得让用户再 Ctrl+F 一次）：
    // 把查询串填进查找栏并选中第一处命中 —— 这复用**已验收的**查找替换机制
    // （两个编辑面都支持高亮与滚动定位），而不是另写一套"文本偏移 → 编辑器位置"的映射。
    if (query) {
      find.setQuery(query)
      find.show()
    }
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    ui.closeGlobalSearch()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = Math.min(activeIdx.value + 1, ui.globalSearch.results.length - 1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
    return
  }
  if (e.key === 'Enter' && ui.globalSearch.results[activeIdx.value]) {
    e.preventDefault()
    void openResult(ui.globalSearch.results[activeIdx.value])
  }
}

function onDocKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    ui.openGlobalSearch()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onDocKeydown)
  offIndexProgress = window.luminAPI.workspace.onIndexProgress((s) => {
    indexStatus.value = s
  })
  indexStatus.value = await window.luminAPI.workspace.indexStatus().catch(() => indexStatus.value)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocKeydown)
  offIndexProgress?.()
  offIndexProgress = null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.globalSearch.open"
        class="fixed inset-0 z-[var(--z-search)] flex items-start justify-center bg-scrim pt-[12vh] backdrop-blur-[2px]"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('menu.globalSearch')"
        @click.self="ui.closeGlobalSearch()"
      >
        <Transition name="pop" appear>
          <div
            class="flex w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-edge bg-elevate shadow-2xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
            @keydown="onKeydown"
          >
            <!-- 输入区 -->
            <div class="flex items-center gap-3 border-b border-edge px-4 py-3.5">
              <Icon name="search" :size="17" class="text-accent" />
              <input
                ref="inputEl"
                v-model="ui.globalSearch.query"
                class="flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-2b"
                :placeholder="$t('common.searchPlaceholder')"
                spellcheck="false"
              />
              <!-- 索引态：正在索引时如实说"还在索引"，否则用户会把"搜不到"当成"没有" -->
              <span
                v-if="indexStatus.running"
                class="flex items-center gap-1 rounded-md bg-panel-2 px-2 py-0.5 text-[11px] tabular-nums text-ink-2b"
                data-index-status
              >
                <Icon
                  name="refresh"
                  :size="11"
                  class="animate-spin"
                  style="animation-duration: 1.4s"
                />
                {{ t('globalSearch.indexing', { n: indexStatus.scanned }) }}
              </span>
              <span
                v-else-if="indexStatus.root"
                class="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] tabular-nums text-ink-2b"
                data-index-status
              >
                {{ t('globalSearch.indexReady', { n: indexStatus.indexed }) }}
              </span>
              <span
                v-else-if="ui.globalSearch.docs"
                class="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] tabular-nums text-ink-2b"
              >
                {{ t('globalSearch.indexedCount', { n: ui.globalSearch.docs }) }}
              </span>
              <button
                class="icon-btn !h-7 !w-7"
                :title="`${t('common.close')} (Esc)`"
                @click="ui.closeGlobalSearch()"
              >
                <Icon name="x" :size="14" />
              </button>
            </div>

            <!-- 结果区 -->
            <div class="max-h-[46vh] overflow-y-auto p-2">
              <div
                v-if="ui.globalSearch.loading"
                class="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-2b"
              >
                <span class="h-1.5 w-1.5 animate-ping rounded-full bg-accent" />
                {{ t('globalSearch.searching') }}
              </div>

              <TransitionGroup v-else-if="ui.globalSearch.results.length" name="list">
                <button
                  v-for="(r, i) in ui.globalSearch.results"
                  :key="r.path"
                  class="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-100"
                  :class="i === activeIdx ? 'bg-accent-soft' : 'hover:bg-panel-2'"
                  data-search-result
                  @mouseenter="activeIdx = i"
                  @click="openResult(r)"
                >
                  <span
                    class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-panel-2 text-ink-2b"
                  >
                    <Icon name="file" :size="14" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline gap-2">
                      <span class="truncate text-[13.5px] font-medium text-ink">{{ r.title }}</span>
                      <span
                        v-if="r.titleSnippet"
                        class="truncate text-[12px]"
                        :class="i === activeIdx ? 'text-accent' : 'text-ink-2b'"
                      >
                        <template v-for="(seg, si) in highlightSegments(r.titleSnippet)" :key="si"
                          ><em v-if="seg.hit" class="gs-hl">{{ seg.text }}</em
                          ><template v-else>{{ seg.text }}</template></template
                        >
                      </span>
                    </span>
                    <span
                      v-if="r.bodySnippet"
                      class="mt-0.5 block truncate text-[12px] leading-relaxed text-ink-2"
                    >
                      <template v-for="(seg, si) in highlightSegments(r.bodySnippet)" :key="si"
                        ><em v-if="seg.hit" class="gs-hl">{{ seg.text }}</em
                        ><template v-else>{{ seg.text }}</template></template
                      >
                    </span>
                    <span class="mt-0.5 block truncate text-[11px] text-ink-2b">{{ r.path }}</span>
                  </span>
                  <Icon name="chevron-right" :size="14" class="mt-2 flex-none text-ink-3" />
                </button>
              </TransitionGroup>

              <div
                v-else-if="ui.globalSearch.query.trim()"
                class="flex flex-col items-center gap-2 py-12 text-center"
              >
                <Icon name="search" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
                <p class="text-[13px] text-ink-2b">{{ t('globalSearch.noMatch') }}</p>
              </div>

              <div v-else class="flex flex-col items-center gap-2 py-12 text-center">
                <Icon name="sparkles" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
                <p class="text-[13px] text-ink-2b">
                  {{
                    t(ui.globalSearch.docs ? 'globalSearch.hintIndexed' : 'globalSearch.hintEmpty')
                  }}
                </p>
              </div>
            </div>

            <!-- 底部提示 -->
            <div
              class="flex items-center gap-3 border-t border-edge px-4 py-2 text-[11px] text-ink-2b"
            >
              <span class="flex items-center gap-1"
                ><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">↑↓</kbd>
                {{ t('globalSearch.hintSelect') }}</span
              >
              <span class="flex items-center gap-1"
                ><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">Enter</kbd>
                {{ t('common.open') }}</span
              >
              <span class="flex items-center gap-1"
                ><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">Esc</kbd>
                {{ t('common.close') }}</span
              >
              <div class="flex-1" />
              <span class="flex items-center gap-1.5">
                <Icon name="dot" :size="8" class="text-ok" />
                {{ t('globalSearch.engine') }}
              </span>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
