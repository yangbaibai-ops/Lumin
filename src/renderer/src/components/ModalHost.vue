<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
const { t } = useI18n()
const inputEl = ref<HTMLInputElement | null>(null)
const promptValue = ref('')

watch(
  () => ui.promptState,
  (v) => {
    if (v) {
      promptValue.value = v.value
      nextTick(() => {
        inputEl.value?.focus()
        inputEl.value?.select()
      })
    }
  }
)

function closeByEscape(confirmResult = false, promptResult: string | null = null): void {
  if (ui.confirmState) ui.resolveConfirm(confirmResult)
  else if (ui.promptState) ui.resolvePrompt(promptResult)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeByEscape()
}

/**
 * Esc 关对话框：监听器挂在 **document** 上，不是模板里那层 `@keydown`。
 *
 * 原来写在遮罩 div 上（`@keydown="onKeydown"`），而那个 div **不可聚焦**、内容里也没有
 * 初始焦点元素（prompt 的输入框要等 `nextTick` 才 focus），于是按键事件永远不会冒泡到它
 * —— 那条 Escape 一直是失效的（审计 R9）。挂 document 之后，无论焦点在遮罩、输入框还是
 * 按钮上都能收到；`ui.resolve*` 在无对话框时是空操作，不会误伤。
 */
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.confirmState || ui.promptState"
        class="fixed inset-0 z-[150] flex items-center justify-center bg-scrim backdrop-blur-[2px]"
        role="dialog"
        aria-modal="true"
        :aria-label="ui.confirmState?.title ?? ui.promptState?.title ?? t('common.confirm')"
        @click.self="ui.confirmState ? ui.resolveConfirm(false) : ui.resolvePrompt(null)"
      >
        <Transition name="pop" appear>
          <div
            class="w-[380px] max-w-[90vw] rounded-2xl border border-edge bg-elevate p-6 shadow-2xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
          >
            <!-- 确认对话框 -->
            <template v-if="ui.confirmState">
              <div class="mb-3 flex items-center gap-3">
                <div
                  class="flex h-9 w-9 items-center justify-center rounded-full"
                  :class="
                    ui.confirmState.danger
                      ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger'
                      : 'bg-accent-soft text-accent'
                  "
                >
                  <Icon :name="ui.confirmState.danger ? 'trash' : 'info'" :size="17" />
                </div>
                <h3 class="text-[15px] font-semibold text-ink">{{ ui.confirmState.title }}</h3>
              </div>
              <p class="mb-6 text-[13px] leading-relaxed text-ink-2">{{ ui.confirmState.body }}</p>
              <div class="flex justify-end gap-2">
                <button class="btn btn-ghost px-4 py-2" @click="ui.resolveConfirm(false)">
                  {{ t('common.cancel') }}
                </button>
                <button
                  class="btn px-4 py-2"
                  :class="
                    ui.confirmState.danger
                      ? '!bg-danger text-white hover:brightness-110'
                      : 'btn-primary'
                  "
                  @click="ui.resolveConfirm(true)"
                >
                  {{ t('common.confirm') }}
                </button>
              </div>
            </template>

            <!-- 输入对话框 -->
            <template v-else-if="ui.promptState">
              <h3 class="mb-4 text-[15px] font-semibold text-ink">{{ ui.promptState.title }}</h3>
              <input
                ref="inputEl"
                v-model="promptValue"
                class="input mb-6"
                data-prompt-input
                :placeholder="ui.promptState.placeholder"
                @keydown.enter="ui.resolvePrompt(promptValue.trim() || null)"
              />
              <div class="flex justify-end gap-2">
                <button class="btn btn-ghost px-4 py-2" @click="ui.resolvePrompt(null)">
                  {{ t('common.cancel') }}
                </button>
                <button
                  class="btn btn-primary px-4 py-2"
                  @click="ui.resolvePrompt(promptValue.trim() || null)"
                >
                  {{ t('common.confirm') }}
                </button>
              </div>
            </template>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
