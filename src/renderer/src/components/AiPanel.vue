<script setup lang="ts">
// ─── AI 面板（摘要 / 改写共用）────────────────────────────────────────────────
//
// 只负责**预览**：流式输出写在这里，文档在用户点按钮之前一个字节都不动。
// 摘要：插入到光标处 / 复制 / 取消。
// 改写：diff 预览（原文 vs 新文）/ 替换选区 / 插入到下方 / 取消；
//       替换与插入都由 store 以**单事务** dispatch（Ctrl+Z 一步还原）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '../stores/ai'
import { useUiStore } from '../stores/ui'
import { AI_ERROR_KEY } from '../../../shared/ai'
import { diffLines, type AiDiffRow } from '../../../shared/aiDiff'
import Icon from './Icon.vue'

const { t } = useI18n()
const ai = useAiStore()
const ui = useUiStore()

const cardRef = ref<HTMLElement | null>(null)
const instructionRef = ref<HTMLTextAreaElement | null>(null)

const title = computed(() => (ai.kind === 'summary' ? t('ai.titleSummary') : t('ai.titleRewrite')))
const sourceLabel = computed(() =>
  ai.sourceKind === 'selection' ? t('ai.sourceSelection') : t('ai.sourceDocument')
)
const errorText = computed(() => (ai.errorCode ? t(AI_ERROR_KEY[ai.errorCode]) : ''))
const canRetry = computed(
  () =>
    !!ai.errorCode &&
    ai.errorCode !== 'no-editor' &&
    ai.errorCode !== 'no-selection' &&
    ai.errorCode !== 'document-changed'
)
const busy = computed(() => ai.phase === 'starting' || ai.phase === 'streaming')
const rows = computed<AiDiffRow[]>(() =>
  ai.kind === 'rewrite' && ai.phase === 'done' ? diffLines(ai.sourceText, ai.output) : []
)
const beforeRows = computed(() => rows.value.filter((r) => r.kind !== 'add'))
const afterRows = computed(() => rows.value.filter((r) => r.kind !== 'del'))
const showOutput = computed(() => ai.kind === 'summary' || ai.phase !== 'done')

function onKeydown(e: KeyboardEvent): void {
  if (!ai.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    ai.close()
  }
}

watch(
  () => ai.open,
  (open) => {
    if (!open) return
    void nextTick(() => {
      if (ai.kind === 'rewrite' && ai.phase === 'ready') instructionRef.value?.focus()
      else cardRef.value?.focus()
    })
  }
)

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="ai.open" class="ai-modal" data-ai-panel>
        <div
          ref="cardRef"
          class="ai-card"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
        >
          <header class="ai-head">
            <span class="ai-head__icon"><Icon name="sparkles" :size="16" /></span>
            <div class="ai-head__meta">
              <h2 class="ai-title">{{ title }}</h2>
              <p class="ai-sub">
                <span data-ai-source>{{ sourceLabel }}</span>
                <span class="ai-dot">·</span>
                <span data-ai-chars>{{
                  t('ai.charCount', { count: ai.sentChars || ai.originalChars })
                }}</span>
                <span v-if="ai.model" class="ai-dot">·</span>
                <span v-if="ai.model" class="ai-model">{{ ai.model }}</span>
              </p>
            </div>
            <button
              class="ai-icon-btn"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              data-ai-close
              @click="ai.close()"
            >
              <Icon name="x" :size="14" />
            </button>
          </header>

          <p v-if="ai.truncated" class="ai-note" data-ai-truncated>
            {{ t('ai.truncatedHint', { original: ai.originalChars, sent: ai.sentChars }) }}
          </p>

          <!-- 改写：先写指令（默认「润色，保持 Markdown 结构」），点生成才开始流式 -->
          <section v-if="ai.kind === 'rewrite' && ai.phase === 'ready'" class="ai-ready">
            <label class="ai-label" for="ai-instruction">{{ t('ai.instructionLabel') }}</label>
            <textarea
              id="ai-instruction"
              ref="instructionRef"
              v-model="ai.instruction"
              class="ai-instruction"
              rows="3"
              spellcheck="false"
              data-ai-instruction
              @keydown.enter.exact.prevent="ai.generateRewrite()"
            />
            <p class="ai-hint">{{ t('ai.instructionHint') }}</p>
            <div class="ai-actions">
              <button class="btn btn-ghost px-4 py-2" @click="ai.close()">
                {{ t('common.cancel') }}
              </button>
              <button
                class="btn btn-primary px-4 py-2"
                :disabled="!ai.instruction.trim()"
                data-ai-generate
                @click="ai.generateRewrite()"
              >
                {{ t('ai.generate') }}
              </button>
            </div>
          </section>

          <!-- 错误：可重试的留在面板里重试；缺 Key 直接开设置 -->
          <section v-else-if="ai.phase === 'error'" class="ai-error-wrap">
            <p class="ai-error" data-ai-error>{{ errorText }}</p>
            <div class="ai-actions">
              <button class="btn btn-ghost px-4 py-2" @click="ai.close()">
                {{ t('common.close') }}
              </button>
              <button
                v-if="ai.errorCode === 'missing-key' || ai.errorCode === 'key-unavailable'"
                class="btn btn-outline px-4 py-2"
                data-ai-open-settings
                @click="ui.openSettings('ai')"
              >
                {{ t('ai.openSettings') }}
              </button>
              <button
                v-if="canRetry"
                class="btn btn-primary px-4 py-2"
                data-ai-retry
                @click="ai.retry()"
              >
                {{ t('ai.retry') }}
              </button>
            </div>
          </section>

          <!-- 改写完成：左右两栏 diff（del 在左、add 在右；same 两边都显示） -->
          <section
            v-else-if="ai.kind === 'rewrite' && ai.phase === 'done'"
            class="ai-diff"
            data-ai-diff
          >
            <div class="ai-diff__col">
              <h3 class="ai-diff__title">{{ t('ai.diffOriginal') }}</h3>
              <div class="ai-diff__body">
                <div
                  v-for="(row, i) in beforeRows"
                  :key="'b' + i"
                  class="ai-line"
                  :class="{ 'is-del': row.kind === 'del' }"
                >
                  {{ row.text || '\u00a0' }}
                </div>
              </div>
            </div>
            <div class="ai-diff__col">
              <h3 class="ai-diff__title">{{ t('ai.diffResult') }}</h3>
              <div class="ai-diff__body">
                <div
                  v-for="(row, i) in afterRows"
                  :key="'a' + i"
                  class="ai-line"
                  :class="{ 'is-add': row.kind === 'add' }"
                >
                  {{ row.text || '\u00a0' }}
                </div>
              </div>
            </div>
          </section>

          <!-- 摘要完成 / 改写进行中：输出预览（流式逐字追加） -->
          <section v-else-if="showOutput" class="ai-preview">
            <pre class="ai-output" data-ai-output>{{ ai.output }}</pre>
            <span v-if="busy" class="ai-caret" aria-hidden="true" />
            <p v-if="busy" class="ai-status">{{ t('ai.streaming') }}</p>
            <p v-else-if="ai.phase === 'aborted'" class="ai-status">{{ t('ai.aborted') }}</p>
          </section>

          <footer class="ai-actions ai-actions--footer">
            <template v-if="ai.kind === 'summary' && ai.phase === 'done'">
              <button class="btn btn-ghost px-4 py-2" @click="ai.close()">
                {{ t('common.cancel') }}
              </button>
              <button class="btn btn-outline px-4 py-2" data-ai-copy @click="ai.copyOutput()">
                {{ t('ai.copy') }}
              </button>
              <button
                class="btn btn-primary px-4 py-2"
                data-ai-insert
                @click="ai.insertSummaryAtCursor()"
              >
                {{ t('ai.insertAtCursor') }}
              </button>
            </template>
            <template v-else-if="ai.kind === 'rewrite' && ai.phase === 'done'">
              <button class="btn btn-ghost px-4 py-2" @click="ai.close()">
                {{ t('common.cancel') }}
              </button>
              <button
                class="btn btn-outline px-4 py-2"
                data-ai-insert-below
                @click="ai.insertBelow()"
              >
                {{ t('ai.insertBelow') }}
              </button>
              <button
                class="btn btn-primary px-4 py-2"
                data-ai-replace
                @click="ai.replaceSelection()"
              >
                {{ t('ai.replaceSelection') }}
              </button>
            </template>
            <template v-else-if="busy">
              <button class="btn btn-ghost px-4 py-2" data-ai-cancel @click="ai.cancel()">
                {{ t('ai.stop') }}
              </button>
            </template>
            <template v-else-if="ai.phase === 'aborted'">
              <button class="btn btn-ghost px-4 py-2" @click="ai.close()">
                {{ t('common.close') }}
              </button>
              <button class="btn btn-primary px-4 py-2" data-ai-retry @click="ai.retry()">
                {{ t('ai.retry') }}
              </button>
            </template>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
