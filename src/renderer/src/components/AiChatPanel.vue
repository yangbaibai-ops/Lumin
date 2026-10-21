<script setup lang="ts">
// ─── 右侧栏「AI 对话」面板 ─────────────────────────────────────────────────────
//
// 只负责呈现与输入：消息、流式增量、上下文开关、工具栏动作。
// 会话状态在 `stores/ai.ts`（内存最多 100 条，不落库）；网络只在主进程。
//
// 交互口径：
//   * Enter / Ctrl+Enter / Cmd+Enter 发送，Shift+Enter 换行（输入法组合期间不拦截）；
//   * 用户上滚后**不强制跟随**，右下出现「回到底部」；
//   * 生成中显示「停止」；失败显示可读文案 + 重试；
//   * 未配置 Key 时只显示引导卡（不渲染输入框）。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore, type ChatUiMessage } from '../stores/ai'
import { useUiStore } from '../stores/ui'
import { AI_ERROR_KEY, AI_MAX_INPUT_CHARS, type AiErrorCode } from '../../../shared/ai'
import Icon from './Icon.vue'
import AiMarkdown from './AiMarkdown.vue'

const props = defineProps<{ active: boolean }>()

const { t } = useI18n()
const ai = useAiStore()
const ui = useUiStore()

const scrollRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
/** 用户是否停在底部（false = 上滚过，出现「回到底部」） */
const atBottom = ref(true)

const busy = computed(() => ai.chatBusy)
const lastAssistant = computed<ChatUiMessage | null>(() => ai.lastChatAssistant)
const contextTotal = computed(
  () =>
    (ai.chatIncludeDocument ? ai.chatDocChars : 0) +
    (ai.chatIncludeSelection ? ai.chatSelectionChars : 0)
)
const contextOver = computed(() => contextTotal.value > AI_MAX_INPUT_CHARS)
const streamTick = computed(() => ai.chatMessages.reduce((n, m) => n + m.content.length, 0))

const SUGGESTIONS = [
  'ai.chat.suggestionSummary',
  'ai.chat.suggestionExplain',
  'ai.chat.suggestionOutline',
  'ai.chat.suggestionPolish'
] as const

function errorText(code: AiErrorCode | null, status?: number | null): string {
  if (!code) return ''
  const base = t(AI_ERROR_KEY[code])
  return status ? `${base} ${t('ai.chat.errorStatus', { status })}` : base
}

function messageError(m: ChatUiMessage): string {
  return errorText(m.errorCode ?? null, m.errorStatus ?? null)
}

function truncationText(m: ChatUiMessage): string {
  const stats = m.stats
  if (!stats?.truncated) return ''
  return t('ai.chat.truncated', { original: stats.originalChars, sent: stats.sentChars })
}

function onScroll(): void {
  const el = scrollRef.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scrollRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
}

function focusInput(): void {
  inputRef.value?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  // Enter 发送；Ctrl/Cmd+Enter 也发送；只有 Shift+Enter 交给输入框换行。
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void ai.chatSend()
  }
}

function pickSuggestion(key: (typeof SUGGESTIONS)[number]): void {
  ai.chatInput = t(key)
  void nextTick(focusInput)
}

function copyLast(): void {
  if (lastAssistant.value) void ai.copyChatMessage(lastAssistant.value.id)
}

function insertLast(): void {
  if (lastAssistant.value) ai.insertChatMessage(lastAssistant.value.id)
}

/** 切换页签 / 首次出现时：刷新 Key 状态与字符数，滚到底并把焦点放进输入框。 */
async function activate(): Promise<void> {
  await ai.refreshChat()
  await nextTick()
  await scrollToBottom()
  if (!ai.hasKey) return
  focusInput()
}

watch(
  () => props.active,
  (on) => {
    if (on) void activate()
  }
)

// 新内容到达：只有原本就在底部时才跟随（用户上滚后不抢滚动位置）。
watch(streamTick, () => {
  if (atBottom.value) void scrollToBottom()
})

onMounted(() => {
  if (props.active) void activate()
})
</script>

<template>
  <section class="ai-chat" data-ai-chat>
    <header class="ai-chat__head">
      <span class="ai-chat__title">
        <Icon name="sparkles" :size="14" />
        {{ t('ai.chat.title') }}
      </span>
      <button
        class="ai-chat__model"
        type="button"
        data-ai-chat-model
        :title="t('ai.chat.modelHint')"
        @click="ui.openSettings('ai')"
      >
        {{ ai.model || t('ai.chat.modelUnset') }}
      </button>
    </header>

    <!-- 未配置 Key：引导卡（不渲染输入区） -->
    <div v-if="!ai.hasKey" class="ai-chat__guide" data-ai-chat-no-key>
      <span class="ai-chat__guide-icon"><Icon name="info" :size="18" /></span>
      <h3 class="ai-chat__guide-title">{{ t('ai.chat.noKeyTitle') }}</h3>
      <p class="ai-chat__guide-body">{{ t('ai.chat.noKeyBody') }}</p>
      <button
        class="btn btn-primary px-4 py-2"
        type="button"
        data-ai-chat-open-settings
        @click="ui.openSettings('ai')"
      >
        {{ t('ai.chat.openSettings') }}
      </button>
    </div>

    <template v-else>
      <div
        ref="scrollRef"
        class="ai-chat__messages"
        data-ai-chat-messages
        @scroll.passive="onScroll"
      >
        <!-- 空状态：几条灵感提示，点一下填进输入框 -->
        <div v-if="!ai.chatMessages.length" class="ai-chat__empty" data-ai-chat-empty>
          <p class="ai-chat__empty-title">{{ t('ai.chat.emptyTitle') }}</p>
          <p class="ai-chat__empty-hint">{{ t('ai.chat.emptyHint') }}</p>
          <div class="ai-chat__chips">
            <button
              v-for="key in SUGGESTIONS"
              :key="key"
              class="ai-chat__chip"
              type="button"
              :data-ai-chat-suggestion="key"
              @click="pickSuggestion(key)"
            >
              {{ t(key) }}
            </button>
          </div>
        </div>

        <div
          v-for="m in ai.chatMessages"
          :key="m.id"
          class="ai-msg"
          :class="m.role === 'user' ? 'ai-msg--user' : 'ai-msg--assistant'"
          :data-ai-chat-message="m.role"
        >
          <span class="ai-msg__role">{{
            m.role === 'user' ? t('ai.chat.you') : t('ai.chat.assistant')
          }}</span>
          <div class="ai-msg__bubble">
            <AiMarkdown v-if="m.role === 'assistant' && m.content" :source="m.content" />
            <p v-else-if="m.role === 'user'" class="ai-msg__text">{{ m.content }}</p>
            <p v-else-if="m.status === 'streaming'" class="ai-msg__typing">
              {{ t('ai.streaming') }}
            </p>
            <p v-if="m.status === 'stopped'" class="ai-msg__note" data-ai-chat-stopped>
              {{ t('ai.chat.stopped') }}
            </p>
            <p
              v-if="m.stats?.truncated"
              class="ai-msg__note ai-msg__note--warn"
              data-ai-chat-truncated
            >
              {{ truncationText(m) }}
            </p>
            <div v-if="m.status === 'error'" class="ai-msg__error" data-ai-chat-error>
              <span>{{ messageError(m) }}</span>
              <button
                class="ai-chat__link-btn"
                type="button"
                data-ai-chat-message-retry
                @click="ai.chatRetry()"
              >
                {{ t('ai.chat.retry') }}
              </button>
            </div>
          </div>
          <div
            v-if="m.role === 'assistant' && m.content"
            class="ai-msg__actions"
            :class="{
              'ai-msg__actions--static':
                ai.chatReplaceAvailable && m.id === ai.lastChatAssistant?.id
            }"
          >
            <button
              class="ai-chat__mini-btn"
              type="button"
              :title="t('ai.chat.copy')"
              :aria-label="t('ai.chat.copy')"
              data-ai-chat-message-copy
              @click="ai.copyChatMessage(m.id)"
            >
              <Icon name="copy" :size="12" />
            </button>
            <button
              class="ai-chat__mini-btn"
              type="button"
              :title="t('ai.chat.insert')"
              :aria-label="t('ai.chat.insert')"
              data-ai-chat-message-insert
              @click="ai.insertChatMessage(m.id)"
            >
              <Icon name="download" :size="12" />
            </button>
            <!-- 右键 AI 子菜单发起的那一轮：可直接把回答替换回来源选区/段落（单事务、可撤销） -->
            <button
              v-if="
                ai.chatReplaceAvailable &&
                m.role === 'assistant' &&
                m.id === ai.lastChatAssistant?.id
              "
              class="ai-chat__mini-btn ai-chat__mini-btn--text"
              type="button"
              :title="t('ai.chat.replaceSelection')"
              :aria-label="t('ai.chat.replaceSelection')"
              data-ai-chat-message-replace
              @click="ai.replaceChatAnswer(m.id)"
            >
              {{ t('ai.chat.replaceSelection') }}
            </button>
          </div>
        </div>
      </div>

      <button
        v-if="!atBottom"
        class="ai-chat__back-bottom"
        type="button"
        data-ai-chat-back-bottom
        :title="t('ai.chat.backToBottom')"
        :aria-label="t('ai.chat.backToBottom')"
        @click="scrollToBottom"
      >
        <Icon name="chevron-down" :size="14" />
        <span>{{ t('ai.chat.backToBottom') }}</span>
      </button>

      <!-- 上下文开关：默认只附选区、不附全文；字符数一直显示 -->
      <div class="ai-chat__context" data-ai-chat-context>
        <label class="ai-chat__check">
          <input
            type="checkbox"
            class="ai-chat__checkbox"
            data-ai-chat-context-document
            :checked="ai.chatIncludeDocument"
            @change="ai.setChatIncludeDocument(($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t('ai.chat.contextDocument') }}</span>
          <span class="ai-chat__chars">{{ t('ai.chat.chars', { n: ai.chatDocChars }) }}</span>
        </label>
        <label class="ai-chat__check">
          <input
            type="checkbox"
            class="ai-chat__checkbox"
            data-ai-chat-context-selection
            :checked="ai.chatIncludeSelection"
            @change="ai.setChatIncludeSelection(($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t('ai.chat.contextSelection') }}</span>
          <span class="ai-chat__chars">{{ t('ai.chat.chars', { n: ai.chatSelectionChars }) }}</span>
        </label>
      </div>
      <p v-if="contextOver" class="ai-chat__warn" data-ai-chat-context-over>
        {{ t('ai.chat.contextOver', { total: contextTotal, cap: AI_MAX_INPUT_CHARS }) }}
      </p>
      <p v-else-if="ai.chatLastStats?.truncated" class="ai-chat__warn" data-ai-chat-last-truncated>
        {{
          t('ai.chat.truncated', {
            original: ai.chatLastStats.originalChars,
            sent: ai.chatLastStats.sentChars
          })
        }}
      </p>

      <!-- 面板级错误（发送前失败，例如缺 Key / 没有编辑器；消息级错误在气泡里） -->
      <div
        v-if="ai.chatPhase === 'error' && !ai.chatMessages.length"
        class="ai-chat__error-bar"
        data-ai-chat-error-bar
      >
        <span>{{ errorText(ai.chatErrorCode, ai.chatErrorStatus) }}</span>
        <button
          v-if="ai.chatErrorCode !== 'missing-key' && ai.chatErrorCode !== 'no-editor'"
          class="ai-chat__link-btn"
          type="button"
          data-ai-chat-error-retry
          @click="ai.chatRetry()"
        >
          {{ t('ai.chat.retry') }}
        </button>
      </div>

      <div class="ai-chat__composer" data-ai-chat-composer>
        <textarea
          ref="inputRef"
          v-model="ai.chatInput"
          class="ai-chat__input"
          rows="3"
          spellcheck="false"
          data-ai-chat-input
          :placeholder="t('ai.chat.inputPlaceholder')"
          @keydown="onKeydown"
        />
        <div class="ai-chat__composer-foot">
          <span class="ai-chat__hint">{{ t('ai.chat.inputHint') }}</span>
          <button
            v-if="busy"
            class="btn btn-outline ai-chat__send"
            type="button"
            data-ai-chat-stop
            @click="ai.chatStop()"
          >
            {{ t('ai.chat.stop') }}
          </button>
          <button
            v-else
            class="btn btn-primary ai-chat__send"
            type="button"
            data-ai-chat-send
            :disabled="!ai.chatInput.trim()"
            @click="ai.chatSend()"
          >
            {{ t('ai.chat.send') }}
          </button>
        </div>
      </div>

      <!-- 工具栏：新对话 / 停止 / 重试 / 复制回答 / 插入到文档 -->
      <div class="ai-chat__toolbar" data-ai-chat-toolbar>
        <button class="ai-chat__tool" type="button" data-ai-chat-new @click="ai.newChat()">
          <Icon name="plus" :size="12" />
          <span>{{ t('ai.chat.newChat') }}</span>
        </button>
        <button
          class="ai-chat__tool"
          type="button"
          data-ai-chat-stop-toolbar
          :disabled="!busy"
          @click="ai.chatStop()"
        >
          <Icon name="x" :size="12" />
          <span>{{ t('ai.chat.stop') }}</span>
        </button>
        <button
          class="ai-chat__tool"
          type="button"
          data-ai-chat-retry
          :disabled="!ai.canChatRetry"
          @click="ai.chatRetry()"
        >
          <Icon name="refresh" :size="12" />
          <span>{{ t('ai.chat.retry') }}</span>
        </button>
        <button
          class="ai-chat__tool"
          type="button"
          data-ai-chat-copy
          :disabled="!lastAssistant?.content"
          @click="copyLast"
        >
          <Icon name="copy" :size="12" />
          <span>{{ t('ai.chat.copy') }}</span>
        </button>
        <button
          class="ai-chat__tool"
          type="button"
          data-ai-chat-insert
          :disabled="!lastAssistant?.content"
          @click="insertLast"
        >
          <Icon name="download" :size="12" />
          <span>{{ t('ai.chat.insert') }}</span>
        </button>
      </div>
    </template>
  </section>
</template>
