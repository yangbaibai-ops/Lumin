<script setup lang="ts">
// ─── 查找 / 替换栏（编辑器右上角浮条）────────────────────────────────────────
// 两个编辑面共用：模式决定「在哪儿找」（见 stores/find.ts 的 surface）。
//
// 结构（本轮改）：**查找 + 一个折叠三角** 是常驻部分，替换那一行由三角展开。
//   * Ctrl+F：只出现查找（三角朝右，收起）；
//   * Ctrl+H：直接连替换一起出现（等同于点开三角）。
// 为什么这样分：绝大多数查找都不替换，常驻两行会一直占着右上角。
//
// 交互对齐主流编辑器：
//   Enter 下一个 · Shift+Enter 上一个 · Esc 关闭 · 「区分大小写」开关 ·
//   「.*」正则开关（默认关，字面量搜索）· 替换只动当前命中 · 全部替换一次改完（可 Ctrl+Z 整体撤销）。
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

/**
 * 栏内 Ctrl+H：展开替换行（并把焦点送进替换输入框）。
 *
 * 全局 keymap 里 Ctrl+H 绑定的是 `edit.replace`（打开查找栏 + 展开替换），但全局监听是
 * **捕获阶段**且装在 window 上：在本栏展开时它仍会先跑一遍。这里让栏在**自己已打开**时
 * 就地展开并 `preventDefault`，全局那份看到 `defaultPrevented` 就会让行 —— 于是
 * 「栏开着 → 就展开，栏没开 → 才新开并展开」，两处不打架。
 */
function onBarKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault()
    if (!find.replaceExpanded) find.toggleReplace()
    void nextTick(() => replaceRef.value?.focus())
  }
}

const replaceRef = ref<HTMLInputElement | null>(null)

/** 折叠三角：展开时转 90°（与「点一下把那行拉出来」的直觉一致） */
function toggleReplace(): void {
  find.toggleReplace()
  if (find.replaceExpanded) void nextTick(() => replaceRef.value?.focus())
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
      @keydown="onBarKeydown"
      @keydown.esc.prevent="find.hide()"
    >
      <div class="find-row">
        <!-- 折叠三角：只负责展开/收起「替换」那一行 -->
        <button
          class="find-btn find-disclosure"
          :class="{ active: find.replaceExpanded }"
          :title="find.replaceExpanded ? t('find.collapseReplace') : t('find.expandReplace')"
          :aria-label="find.replaceExpanded ? t('find.collapseReplace') : t('find.expandReplace')"
          :aria-expanded="find.replaceExpanded"
          data-find-disclosure
          @click="toggleReplace()"
        >
          <Icon
            name="chevron-right"
            :size="13"
            class="transition-transform duration-150"
            :class="find.replaceExpanded ? 'rotate-90' : ''"
          />
        </button>
        <Icon name="search" :size="13" class="text-ink-3" />
        <input
          ref="queryRef"
          :value="find.query"
          class="find-input"
          :class="{ 'is-invalid': !find.queryValid }"
          type="text"
          spellcheck="false"
          :placeholder="t('find.placeholder')"
          :aria-label="t('find.placeholder')"
          :aria-invalid="!find.queryValid"
          data-find-input
          @input="find.setQuery(($event.target as HTMLInputElement).value)"
          @keydown="onQueryKeydown"
        />
        <span
          class="find-count"
          :class="{ empty: !find.queryValid || (find.query !== '' && find.count === 0) }"
          data-find-count
        >
          {{
            !find.queryValid
              ? t('find.invalidRegex')
              : find.query === ''
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
        <button
          class="find-btn find-case"
          :class="{ active: find.regex, 'is-invalid': !find.queryValid }"
          :title="t('find.regexMode')"
          :aria-label="t('find.regexMode')"
          :aria-pressed="find.regex"
          data-find-regex
          @click="find.toggleRegex()"
        >
          .*
        </button>
        <button class="find-btn" :title="t('find.close')" @click="find.hide()">
          <Icon name="x" :size="13" />
        </button>
      </div>

      <!-- 替换行：折叠三角展开（Ctrl+H 直接展开） -->
      <div v-if="find.replaceExpanded" class="find-row" data-find-replace-row>
        <Icon name="pencil" :size="13" class="text-ink-3" />
        <input
          ref="replaceRef"
          :value="find.replacement"
          class="find-input"
          type="text"
          spellcheck="false"
          :placeholder="
            find.regex ? t('find.replacePlaceholderRegex') : t('find.replacePlaceholder')
          "
          :aria-label="t('find.replacePlaceholder')"
          data-find-replace-input
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
/* 正则表达式写错时把输入框也标红：只有右侧那行小字容易被忽略 */
.find-input.is-invalid {
  border-color: var(--danger);
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
/* 「表达式无效」时正则按钮跟着变红（提示是哪个开关导致的） */
.find-btn.is-invalid {
  color: var(--danger);
}
.find-disclosure {
  padding: 0 2px;
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
