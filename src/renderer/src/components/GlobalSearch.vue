<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import type { SearchResult } from '../../../shared/types'
import Icon from './Icon.vue'

const ui = useUiStore()
const files = useFilesStore()
const router = useRouter()

const inputEl = ref<HTMLInputElement | null>(null)
const activeIdx = ref(0)
let debounce: ReturnType<typeof setTimeout> | null = null

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function snippetHtml(raw: string): string {
  return esc(raw).replace(/&lt;em&gt;/g, '<em class="gs-hl">').replace(/&lt;\/em&gt;/g, '</em>')
}

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
  ui.closeGlobalSearch()
  if (!(await confirmIfDirty())) return
  if (await files.openPath(r.path)) {
    await router.push('/editor')
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

onMounted(() => document.addEventListener('keydown', onDocKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.globalSearch.open"
        class="fixed inset-0 z-[140] flex items-start justify-center bg-black/30 pt-[12vh] backdrop-blur-[2px]"
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
                class="flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-3"
                :placeholder="$t('common.searchPlaceholder')"
                spellcheck="false"
              />
              <span
                v-if="ui.globalSearch.docs"
                class="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] tabular-nums text-ink-3"
              >
                {{ ui.globalSearch.docs }} 篇索引
              </span>
              <button class="icon-btn !h-7 !w-7" title="关闭 (Esc)" @click="ui.closeGlobalSearch()">
                <Icon name="x" :size="14" />
              </button>
            </div>

            <!-- 结果区 -->
            <div class="max-h-[46vh] overflow-y-auto p-2">
              <div v-if="ui.globalSearch.loading" class="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-3">
                <span class="h-1.5 w-1.5 animate-ping rounded-full bg-accent" />
                搜索中…
              </div>

              <TransitionGroup v-else-if="ui.globalSearch.results.length" name="list">
                <button
                  v-for="(r, i) in ui.globalSearch.results"
                  :key="r.path"
                  class="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-100"
                  :class="i === activeIdx ? 'bg-accent-soft' : 'hover:bg-panel-2'"
                  @mouseenter="activeIdx = i"
                  @click="openResult(r)"
                >
                  <span class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-panel-2 text-ink-3">
                    <Icon name="file" :size="14" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline gap-2">
                      <span class="truncate text-[13.5px] font-medium text-ink">{{ r.title }}</span>
                      <span
                        v-if="r.titleSnippet"
                        class="truncate text-[12px]"
                        :class="i === activeIdx ? 'text-accent' : 'text-ink-3'"
                        v-html="snippetHtml(r.titleSnippet)"
                      />
                    </span>
                    <span v-if="r.bodySnippet" class="mt-0.5 block truncate text-[12px] leading-relaxed text-ink-2" v-html="snippetHtml(r.bodySnippet)" />
                    <span class="mt-0.5 block truncate text-[11px] text-ink-3">{{ r.path }}</span>
                  </span>
                  <Icon name="chevron-right" :size="14" class="mt-2 flex-none text-ink-3" />
                </button>
              </TransitionGroup>

              <div
                v-else-if="ui.globalSearch.query.trim()"
                class="flex flex-col items-center gap-2 py-12 text-center"
              >
                <Icon name="search" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
                <p class="text-[13px] text-ink-3">未找到匹配内容</p>
              </div>

              <div v-else class="flex flex-col items-center gap-2 py-12 text-center">
                <Icon name="sparkles" :size="24" :stroke-width="1.3" class="text-ink-3/50" />
                <p class="text-[13px] text-ink-3">
                  {{ ui.globalSearch.docs ? '全局搜索已索引的文档内容' : '打开或保存文档后即可全文搜索' }}
                </p>
              </div>
            </div>

            <!-- 底部提示 -->
            <div class="flex items-center gap-3 border-t border-edge px-4 py-2 text-[11px] text-ink-3">
              <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">↑↓</kbd> 选择</span>
              <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">Enter</kbd> 打开</span>
              <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-panel-2 px-1 py-px">Esc</kbd> 关闭</span>
              <div class="flex-1" />
              <span class="flex items-center gap-1.5">
                <Icon name="dot" :size="8" class="text-ok" />
                SQLite FTS5 全文索引
              </span>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
