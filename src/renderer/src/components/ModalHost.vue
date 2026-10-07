<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const ui = useUiStore()
const { t } = useI18n()
const inputEl = ref<HTMLInputElement | null>(null)
/** 提示卡片（焦点落点 + Tab 循环的范围）。样式见 overlays.css 的 `.lm-prompt__card` */
const cardEl = ref<HTMLElement | null>(null)
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

/**
 * ─── 焦点：打开提示时落进卡片**容器**（不是某个按钮）────────────────────────────
 *
 * 用户口径：「此时聚焦在提示上，不能对其他内容进行修改」。三选一/二选一这两种形态改前
 * **谁都不聚焦**（焦点留在正文/工具栏上，按键还能走到编辑区），所以本轮把焦点交给卡片
 * （容器是 `tabindex="-1"`，`[tabindex='-1']:focus-visible` 在 base.css 里没有描边）。
 *
 * 为什么不是"默认按钮"：**回车语义必须与改前完全一致**。焦点一旦落在按钮上，回车就会
 * 激活它（`<button>` 的默认行为）—— 改前回车什么也不做，那是数据安全路径上的语义
 * （关窗场景"回车=保存"是最危险的一种意外）。落在容器上则：焦点在提示内（Tab 也进得来），
 * 而回车依旧不激活任何东西。输入框（`ui.promptState`）本来就是"回车=提交"，
 * 它自己的 watcher 会聚焦输入框，这里不许抢。
 */
watch(
  () => ui.tripleState || ui.confirmState,
  (v) => {
    if (v) void nextTick(() => cardEl.value?.focus())
  }
)

function closeByEscape(confirmResult = false, promptResult: string | null = null): void {
  // 三选一对话框的 Esc = **取消**（关窗场景里"取消"是唯一安全的默认：窗口留着、改动还在）
  if (ui.tripleState) ui.resolveTriple('cancel')
  else if (ui.confirmState) ui.resolveConfirm(confirmResult)
  else if (ui.promptState) ui.resolvePrompt(promptResult)
}

/** 提示里当前可聚焦的元素（Tab 只在它们之间循环，见 trapTab） */
function focusables(): HTMLElement[] {
  const root = cardEl.value
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0)
}

/**
 * Tab 序被限制在提示内（用户口径）：
 *   * 焦点不在提示里（理论上不该发生）→ 拉回第一个/最后一个；
 *   * 在提示里 → 在**提示自己的**可聚焦元素之间循环（末尾回车首）。
 * 手动 focus 而不是靠浏览器默认，是因为提示里可能只有一个输入框/两枚按钮，而 DOM 里
 * 跟在提示后面的元素（工具栏、菜单…）都在同一个 body 下，交给浏览器就会跑出去。
 */
function trapTab(e: KeyboardEvent): void {
  const list = focusables()
  if (!list.length) return
  const active = document.activeElement as HTMLElement | null
  const inside = !!active && !!cardEl.value?.contains(active)
  const idx = active ? list.indexOf(active) : -1
  e.preventDefault()
  if (!inside || idx === -1) {
    ;(e.shiftKey ? list[list.length - 1] : list[0]).focus()
    return
  }
  list[(idx + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus()
}

function onKeydown(e: KeyboardEvent): void {
  // 只有提示开着才接管 Tab（其它浮层有自己的 Tab 语义）
  if (e.key === 'Tab' && (ui.tripleState || ui.confirmState || ui.promptState)) {
    trapTab(e)
    return
  }
  if (e.key === 'Escape') closeByEscape()
}

/**
 * Esc 关对话框：监听器挂在 **document** 上，不是模板里那层 `@keydown`。
 *
 * 原来写在遮罩 div 上（`@keydown="onKeydown"`），而那个 div **不可聚焦**、内容里也没有
 * 初始焦点元素（prompt 的输入框要等 `nextTick` 才 focus），于是按键事件永远不会冒泡到它
 * —— 那条 Escape 一直是失效的（审计 R9）。挂 document 之后，无论焦点在遮罩、输入框还是
 * 按钮上都能收到；`ui.resolve*` 在无对话框时是空操作，不会误伤。
 * （Tab 的循环处理也一并挂这里：焦点在卡片容器上时，模板里的 `@keydown` 收不到，
 *   只有 document 这一层能兜住。）
 */
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <!-- ── 提示条本体（顶部，不是居中弹窗）───────────────────────────────────────
           改前：`fixed inset-0` + `bg-scrim backdrop-blur-[2px]` + `items-center` ——
           压暗并模糊整个主界面、卡片在正中。现在去掉遮罩与模糊（`.lm-prompt` 里
           background 透明、两个 filter 都按死），卡片贴窗口上沿居中（`.lm-prompt__card`）。
           这一层仍是 `inset: 0` 的**透明命中目标**：提示开着时点正文打不到编辑器上
           （背景 inert），而 `@click.self` 的「点提示之外 = 取消」语义一行没改。
           ⚠️ `data-top-prompt` 是给套件用的语义锚点（两个提示共用同一套形态）；
           `z-[var(--z-modal)]` 这个类名被 `_verify-zorder.js` 按字符串找，别改写法。 -->
      <div
        v-if="ui.tripleState || ui.confirmState || ui.promptState"
        class="lm-prompt z-[var(--z-modal)]"
        data-top-prompt
        role="dialog"
        aria-modal="true"
        :aria-label="
          ui.tripleState?.title ??
          ui.confirmState?.title ??
          ui.promptState?.title ??
          t('common.confirm')
        "
        :data-triple="ui.tripleState ? 'true' : undefined"
        @click.self="
          ui.tripleState
            ? ui.resolveTriple('cancel')
            : ui.confirmState
              ? ui.resolveConfirm(false)
              : ui.resolvePrompt(null)
        "
      >
        <Transition name="lm-prompt-drop" appear>
          <div ref="cardEl" class="lm-prompt__card" tabindex="-1">
            <!-- 三选一确认对话框（关窗「保存 / 不保存 / 取消」）：
                 三个按钮从左到右 = 取消 / 不保存 / 保存，主按钮在最右（Windows 对话框的通行顺序）。
                 数据类型钩子：`data-triple-*`，套件按它定位（文案会随语言变）。 -->
            <template v-if="ui.tripleState">
              <div class="mb-2 flex items-center gap-3">
                <div
                  class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent-ink"
                >
                  <Icon name="save" :size="17" />
                </div>
                <h3 class="min-w-0 text-[15px] font-semibold break-words text-ink">
                  {{ ui.tripleState.title }}
                </h3>
              </div>
              <p class="mb-4 text-[13px] leading-relaxed break-words text-ink-2">
                {{ ui.tripleState.body }}
              </p>
              <div class="flex justify-end gap-2">
                <button
                  class="btn btn-ghost px-4 py-2"
                  data-triple-cancel
                  @click="ui.resolveTriple('cancel')"
                >
                  {{ t('common.cancel') }}
                </button>
                <button
                  class="btn btn-ghost px-4 py-2"
                  data-triple-alt
                  @click="ui.resolveTriple('alt')"
                >
                  {{ ui.tripleState.altLabel }}
                </button>
                <button
                  class="btn btn-primary px-4 py-2"
                  data-triple-confirm
                  @click="ui.resolveTriple('confirm')"
                >
                  {{ ui.tripleState.confirmLabel }}
                </button>
              </div>
            </template>

            <!-- 确认对话框 -->
            <template v-else-if="ui.confirmState">
              <div class="mb-2 flex items-center gap-3">
                <div
                  class="flex h-9 w-9 flex-none items-center justify-center rounded-full"
                  :class="
                    ui.confirmState.danger
                      ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger-ink'
                      : 'bg-accent-soft text-accent-ink'
                  "
                >
                  <Icon :name="ui.confirmState.danger ? 'trash' : 'info'" :size="17" />
                </div>
                <h3 class="min-w-0 text-[15px] font-semibold break-words text-ink">
                  {{ ui.confirmState.title }}
                </h3>
              </div>
              <p class="mb-4 text-[13px] leading-relaxed break-words text-ink-2">
                {{ ui.confirmState.body }}
              </p>
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
              <h3 class="mb-3 text-[15px] font-semibold break-words text-ink">
                {{ ui.promptState.title }}
              </h3>
              <input
                ref="inputEl"
                v-model="promptValue"
                class="input mb-4"
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
