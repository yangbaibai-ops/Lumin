<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useFindStore } from '../stores/find'
import { useNotificationsStore } from '../stores/notifications'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import { errorReason } from '../lib/errors'
import { highlightSegments } from '../lib/highlight'
import { parseLossyReason } from '../../../shared/workspaceReplace.ts'
import type {
  IndexStatus,
  SearchResult,
  WorkspaceReplaceRequest,
  WorkspaceReplaceResult
} from '../../../shared/types'
import Icon from './Icon.vue'

const ui = useUiStore()
const files = useFilesStore()
const find = useFindStore()
const notifications = useNotificationsStore()
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

// ─── 跨文件（工作区级）替换：审计缺口「全局搜索能列出命中、却没有 replace」────────
//
// 之前只有「点结果 → 跳到那篇 → 自己在查找栏里改」这一条路：搜到 20 篇命中就要手工改 20 遍。
// 这里补的是**批量**替换，而批量改盘是不可逆的（Ctrl+Z 只管当前编辑器里的那一次），
// 所以流程刻意分成两趟：
//   ① **干跑**：主进程读盘、按同一套匹配口径算「会影响 N 个文件 / M 处」，一个字节都不写；
//   ② 用户在确认框里看到 N/M 与「不可撤销」后点确认 → 才真的写盘。
// 真正动盘的是主进程 `services/workspaceReplace`（读磁盘正文、按每篇自己的编码/行尾/BOM
// 走 `fileOps` 的原子写、逐文件报告失败）；这里只负责"问一次"和"把结果说清楚"。
const replaceOpen = ref(false)
const replaceText = ref('')
const replaceCase = ref(false)
const replaceRegex = ref(false)
/** 写盘进行中：按钮必须失效（同时再来一次会与刚写完的文件打架） */
const replacing = ref(false)
const replaceInput = ref<HTMLInputElement | null>(null)

/** 不可执行的原因 → 一句本地化提示（键在 globalSearch / find 里，见语言包） */
const INVALID_TEXT: Record<'empty-query' | 'invalid-regex' | 'no-workspace', string> = {
  'empty-query': 'globalSearch.replaceNothing',
  'invalid-regex': 'find.invalidRegex',
  'no-workspace': 'globalSearch.replaceNoWorkspace'
}

/**
 * 本窗口「已打开且有未保存修改」的文档。
 *
 * 这批文档的磁盘版本与用户屏幕上看到的东西**不是同一份**：写盘等于把他正在编辑的内容
 * 从眼皮底下换掉，而且下一次 Ctrl+S 会把旧内容再覆盖回来。所以只提醒、绝不写。
 * （主进程看不到脏标记 —— 它只见过"哪个窗口开着哪个文档"，见 services/openDocs。）
 */
function dirtyOpenPaths(): string[] {
  return files.dirty && files.current?.path ? [files.current.path] : []
}

function toggleReplaceRow(): void {
  replaceOpen.value = !replaceOpen.value
  if (replaceOpen.value) void nextTick(() => replaceInput.value?.focus())
}

/** 确认框的正文：说清「改什么、影响多少、不可撤销」，以及会跳过哪些文档 */
function confirmBody(req: WorkspaceReplaceRequest, preview: WorkspaceReplaceResult): string {
  const parts = [
    t('globalSearch.replaceConfirmBody', {
      query: req.query,
      replacement: req.replacement,
      files: preview.files,
      n: preview.occurrences
    })
  ]
  if (preview.skippedDirty.length) {
    parts.push(t('globalSearch.replaceConfirmSkip', { list: preview.skippedDirty.join('; ') }))
  }
  // 索引还没跑完 = 候选集不全：宁可提前说"这次会漏掉尚未索引的文档"，也不要让用户
  // 把"没搜到"当成"没有"（同 workspaceIndex 的注释口径）
  if (indexStatus.value.running) {
    parts.push(t('globalSearch.replaceConfirmIndexing'))
  }
  if (preview.failures.length) {
    parts.push(
      t('globalSearch.replaceConfirmErrors', {
        n: preview.failures.length,
        list: preview.failures.map((f) => f.path).join('; ')
      })
    )
  }
  return parts.join(' ')
}

/** 「跳过 / 失败」的清单行（通知体的多行文本）。没有跳过的就返回空数组。 */
function skippedLines(result: WorkspaceReplaceResult): string[] {
  const lines: string[] = []
  if (result.skippedDirty.length) {
    lines.push(t('globalSearch.replaceSkippedList', { list: result.skippedDirty.join('\n') }))
  }
  if (result.failures.length) {
    lines.push(
      t('globalSearch.replaceFailureList', {
        list: result.failures.map((f) => `${f.path} — ${failureText(f.reason)}`).join('\n')
      })
    )
  }
  return lines
}

/** 结果通知：成功说清"改了几篇几处"，部分成功如实说"N 个成功、M 个失败 + 逐个原因" */
async function reportReplace(result: WorkspaceReplaceResult): Promise<void> {
  // 刷新结果区与索引计数：被替换掉的命中不该还挂在列表里（索引也已由主进程更新）
  await runSearch()
  void window.luminAPI.db.stats().then((s) => {
    ui.globalSearch.docs = s.docs
    ui.globalSearch.fts = s.fts
  })
  indexStatus.value = await window.luminAPI.workspace.indexStatus().catch(() => indexStatus.value)

  const lines = skippedLines(result)
  if (!result.written && !result.failures.length) {
    // 确认之后文件又被外部改动成不匹配了（罕见）：如实说"什么都没改"，而不是报成功
    if (!lines.length) {
      ui.toast(t('globalSearch.replaceNothing'), 'info')
      return
    }
    await notifications.notify({
      level: 'warning',
      title: t('globalSearch.replaceNothing'),
      body: lines.join('\n'),
      mergeKey: 'global-search-replace'
    })
    return
  }
  const failed = result.failures.length
  await notifications.notify({
    level: failed ? (result.written ? 'warning' : 'error') : 'success',
    title: failed
      ? t('globalSearch.replacePartial', { ok: result.written, failed })
      : t('globalSearch.replaceDone', { files: result.written, n: result.writtenOccurrences }),
    body: lines.join('\n'),
    // 反复替换更新同一张卡，而不是叠出一摞"已替换 N 处"
    mergeKey: 'global-search-replace'
  })
}

/**
 * 主进程的失败原因 → 一句给用户看的话。
 *
 * 「编码表示不了新正文」有自己的码值（`ENCODING_LOSSY:<编码>`，见 shared/workspaceReplace.ts）：
 * 它对应的不是系统错误，而是我们**主动不写**这一篇，复用既有的「编码有损」文案说清怎么处理。
 * 其余交给 `errorReason`（它会剥掉 Electron 的 IPC 前缀，并把 `PARENT_MISSING` 这类稳定码本地化）。
 */
function failureText(reason: string): string {
  const enc = parseLossyReason(reason)
  return enc ? t('toast.encodingLossySave', { enc }) : errorReason(reason)
}

async function replaceAcrossWorkspace(): Promise<void> {
  const query = ui.globalSearch.query.trim()
  if (!query || replacing.value) return
  const req: WorkspaceReplaceRequest = {
    query,
    replacement: replaceText.value,
    caseSensitive: replaceCase.value,
    regex: replaceRegex.value,
    dirtyPaths: dirtyOpenPaths()
  }
  replacing.value = true
  try {
    const preview = await window.luminAPI.workspace.replaceAll(req, true)
    if (preview.invalid) {
      ui.toast(t(INVALID_TEXT[preview.invalid]), 'warning')
      return
    }
    if (!preview.files) {
      // 一篇都改不了要分清两种情况：**真的没有匹配** vs **有匹配但全被跳过**（编码表示不了、
      // 读不到、或者唯一命中的就是那个有未保存修改的当前文档）。后者只说"没有可替换的内容"
      // 等于把"被跳过"说成"没有" —— 通知体把清单摆出来。
      const lines = skippedLines(preview)
      if (!lines.length) {
        ui.toast(t('globalSearch.replaceNothing'), 'info')
        return
      }
      await notifications.notify({
        level: 'warning',
        title: t('globalSearch.replaceNothing'),
        body: lines.join('\n'),
        mergeKey: 'global-search-replace'
      })
      return
    }
    const ok = await ui.confirm({
      title: t('globalSearch.replaceConfirmTitle'),
      body: confirmBody(req, preview),
      danger: true
    })
    if (!ok) return
    await reportReplace(await window.luminAPI.workspace.replaceAll(req, false))
  } catch (err) {
    // 通道级失败（工作区刚被关掉、主进程拒绝等）：把原因说出来，别静默
    ui.toast(errorReason(err), 'error')
  } finally {
    replacing.value = false
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
            <!-- 输入区：焦点环挂在**这一行**（输入框本身 `outline-none` 是为了干掉浏览器默认描边，
                 行上的 focus-within 描边才是键盘用户能看见的那个环；同 .settings-search 的做法） -->
            <div
              class="flex items-center gap-3 border-b border-edge px-4 py-3.5 transition-colors focus-within:border-accent"
            >
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
              <!-- 跨文件替换的入口（审计缺口：全局搜索只有"找到并跳过去"）：
                   点它展开下面那一行「替换为…」。用 `aria-expanded` 而不是 `aria-pressed`：
                   它控制的是"多出来一行"，不是一个开关状态 -->
              <button
                class="icon-btn !h-7 !w-7"
                :class="{ active: replaceOpen }"
                :title="t('find.replace')"
                :aria-label="t('find.replace')"
                :aria-expanded="replaceOpen"
                data-global-replace-toggle
                @click="toggleReplaceRow()"
              >
                <Icon name="pencil" :size="14" />
              </button>
              <button
                class="icon-btn !h-7 !w-7"
                :title="`${t('common.close')} (Esc)`"
                @click="ui.closeGlobalSearch()"
              >
                <Icon name="x" :size="14" />
              </button>
            </div>

            <!-- 替换区（默认收起）：输入替换文本 + 两个开关 + 「全部替换」。
                 开关与编辑器里的查找栏**同一套语义**（默认按字面量、Aa 区分大小写），
                 因为后端用的就是同一份实现（shared/findReplace.ts）—— 界面不该让用户猜。
                 焦点环同样挂在**行**上：输入框的 `outline-none` 只干掉浏览器默认描边，
                 `focus-within:border-accent` 才是键盘用户能看见的那个环（同上面输入行）。 -->
            <div
              v-if="replaceOpen"
              class="flex items-center gap-2 border-b border-edge px-4 py-2.5 transition-colors focus-within:border-accent"
              data-global-replace-row
            >
              <Icon name="pencil" :size="15" class="flex-none text-ink-3" />
              <input
                ref="replaceInput"
                v-model="replaceText"
                class="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-2b"
                :placeholder="t('globalSearch.replacePlaceholder')"
                :aria-label="t('globalSearch.replacePlaceholder')"
                spellcheck="false"
                data-global-replace-input
                @keydown.enter.prevent="replaceAcrossWorkspace()"
              />
              <button
                class="h-6 w-7 flex-none rounded-md px-1.5 text-xs font-semibold"
                :class="
                  replaceCase ? 'bg-accent-soft text-accent-ink' : 'text-ink-2b hover:bg-panel-2'
                "
                :title="t('find.caseSensitive')"
                :aria-label="t('find.caseSensitive')"
                :aria-pressed="replaceCase"
                data-global-replace-case
                @click="replaceCase = !replaceCase"
              >
                Aa
              </button>
              <button
                class="h-6 w-7 flex-none rounded-md px-1.5 text-xs font-semibold"
                :class="
                  replaceRegex ? 'bg-accent-soft text-accent-ink' : 'text-ink-2b hover:bg-panel-2'
                "
                :title="t('find.regexMode')"
                :aria-label="t('find.regexMode')"
                :aria-pressed="replaceRegex"
                data-global-replace-regex
                @click="replaceRegex = !replaceRegex"
              >
                .*
              </button>
              <button
                class="btn btn-primary flex-none px-3 py-1"
                :disabled="replacing || !ui.globalSearch.query.trim()"
                :title="t('find.replaceAll')"
                data-global-replace-all
                @click="replaceAcrossWorkspace()"
              >
                {{ replacing ? t('globalSearch.replaceRunning') : t('find.replaceAll') }}
              </button>
            </div>

            <!-- 命中数播报（审计 §8 P1「无 `aria-live`」）：结果**看得见**，但读屏器不知道
                 "这次搜到几条"。`sr-only` 不占视觉位置，只在结果数变化时播报一次。 -->
            <span class="sr-only" role="status" aria-live="polite">{{
              t('globalSearch.hits', { n: ui.globalSearch.results.length })
            }}</span>

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
                        class="truncate text-ui-sm"
                        :class="i === activeIdx ? 'text-accent-ink' : 'text-ink-2b'"
                      >
                        <template v-for="(seg, si) in highlightSegments(r.titleSnippet)" :key="si"
                          ><em v-if="seg.hit" class="gs-hl">{{ seg.text }}</em
                          ><template v-else>{{ seg.text }}</template></template
                        >
                      </span>
                    </span>
                    <span
                      v-if="r.bodySnippet"
                      class="mt-0.5 block truncate text-ui-sm leading-relaxed text-ink-2"
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
