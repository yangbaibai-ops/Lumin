<script setup lang="ts">
// ─── 查找 / 替换栏（编辑器右上角浮条）────────────────────────────────────────
// 两个编辑面共用：模式决定「在哪儿找」（见 stores/find.ts 的 surface）。
// 交互对齐主流编辑器：
//   Ctrl+F 打开（再按一次关闭）· Enter 下一个 · Shift+Enter 上一个 · Esc 关闭 ·
//   「区分大小写」开关 · 「替换」只动当前命中 · 「全部替换」一次改完（可 Ctrl+Z 整体撤销）。
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFindStore } from '../stores/find'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const { t } = useI18n()
const find = useFindStore()
const ui = useUiStore()

const queryRef = ref<HTMLInputElement | null>(null)

watch(
  () => find.open,
  async (open) => {
    if (!open) return
    await nextTick()
    queryRef.value?.focus()
    queryRef.value?.select()
  }
)

/** 输入框里的回车：Enter=下一个，Shift+Enter=上一个 */
function onQueryKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    find.step(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    find.hide()
  }
}

function onReplaceKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey || e.metaKey || e.ctrlKey) doReplaceAll()
    else find.replaceCurrent()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    find.hide()
  }
}

function doReplaceAll(): void {
  const n = find.replaceAll()
  if (n > 0) ui.toast(t('find.replaced', { count: n }), 'success')
}
</script>

<template>
  <Transition name="pop">
    <div
      v-if="find.open"
      class="find-bar"
      role="search"
      :aria-label="t('find.title')"
      @keydown.esc.prevent="find.hide()"
    >
      <div class="find-row">
        <Icon name="search" :size="13" class="text-ink-3" />
        <input
          ref="queryRef"
          :value="find.query"
          class="find-input"
          type="text"
          spellcheck="false"
          :placeholder="t('find.placeholder')"
          :aria-label="t('find.placeholder')"
          @input="find.setQuery(($event.target as HTMLInputElement).value)"
          @keydown="onQueryKeydown"
        />
        <span class="find-count" :class="{ empty: find.query !== '' && find.count === 0 }">
          {{
            find.query === ''
              ? ''
              : find.count === 0
                ? t('find.noResults')
                : `${find.index + 1}/${find.count}`
          }}
        </span>
        <button
          class="find-btn"
          :title="t('find.prev')"
          :disabled="find.count === 0"
          @click="find.step(-1)"
        >
          <Icon name="chevron-up" :size="13" />
        </button>
        <button
          class="find-btn"
          :title="t('find.next')"
          :disabled="find.count === 0"
          @click="find.step(1)"
        >
          <Icon name="chevron-down" :size="13" />
        </button>
        <button
          class="find-btn find-case"
          :class="{ active: find.caseSensitive }"
          :title="t('find.caseSensitive')"
          :aria-pressed="find.caseSensitive"
          @click="find.toggleCase()"
        >
          Aa
        </button>
        <button class="find-btn" :title="t('find.close')" @click="find.hide()">
          <Icon name="x" :size="13" />
        </button>
      </div>

      <div class="find-row">
        <Icon name="pencil" :size="13" class="text-ink-3" />
        <input
          :value="find.replacement"
          class="find-input"
          type="text"
          spellcheck="false"
          :placeholder="t('find.replacePlaceholder')"
          :aria-label="t('find.replacePlaceholder')"
          @input="find.setReplacement(($event.target as HTMLInputElement).value)"
          @keydown="onReplaceKeydown"
        />
        <button
          class="find-btn find-text find-replace-btn"
          :title="t('find.replace')"
          @click="find.replaceCurrent()"
        >
          {{ t('find.replace') }}
        </button>
        <button
          class="find-btn find-text find-replace-all-btn"
          :title="t('find.replaceAll')"
          @click="doReplaceAll()"
        >
          {{ t('find.replaceAll') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.find-bar {
  position: fixed;
  top: 62px;
  right: 18px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  min-width: 330px;
  background: var(--elevate);
  border: 1px solid var(--edge);
  border-radius: 10px;
  box-shadow: var(--shadow-2);
}
.find-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.find-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--panel-2);
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
}
.find-input:focus {
  border-color: var(--accent);
}
.find-count {
  min-width: 46px;
  text-align: right;
  font-size: 11.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.find-count.empty {
  color: var(--danger);
}
.find-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 6px;
  color: var(--ink-2);
  border-radius: 6px;
  transition: background 0.12s ease;
}
.find-btn:hover:not(:disabled) {
  background: var(--panel-2);
  color: var(--ink);
}
.find-btn:disabled {
  opacity: 0.4;
}
.find-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.find-case {
  font-size: 11.5px;
  font-weight: 600;
}
.find-text {
  font-size: 11.5px;
  white-space: nowrap;
}
</style>
