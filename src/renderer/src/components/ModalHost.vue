<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
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

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    ui.resolveConfirm(false)
    ui.resolvePrompt(null)
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.confirmState || ui.promptState"
        class="fixed inset-0 z-[150] flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
        @click.self="ui.confirmState ? ui.resolveConfirm(false) : ui.resolvePrompt(null)"
        @keydown="onKeydown"
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
                  取消
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
                  确定
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
                :placeholder="ui.promptState.placeholder"
                @keydown.enter="ui.resolvePrompt(promptValue.trim() || null)"
              />
              <div class="flex justify-end gap-2">
                <button class="btn btn-ghost px-4 py-2" @click="ui.resolvePrompt(null)">
                  取消
                </button>
                <button
                  class="btn btn-primary px-4 py-2"
                  @click="ui.resolvePrompt(promptValue.trim() || null)"
                >
                  确定
                </button>
              </div>
            </template>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
