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
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFindStore } from '../stores/find'
// 零依赖桥：本组件在 App.vue 的静态依赖链上，直接 import 编辑器内核会把 PM 拖进首屏
import { setFindHit } from '../lib/editor/findBridge'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const { t } = useI18n()
const find = useFindStore()
const ui = useUiStore()

const queryRef = ref<HTMLInputElement | null>(null)

/**
 * 浮条贴的是**写作区顶边**，而不是写死的 62px。
 *
 * 用户报的 bug：查找栏会压住快捷工具栏。原来 `top: 62px` 是拍脑袋的常数，而顶部的
 * 菜单栏（32px）+ 工具栏（44px）= 76px —— 62 正好落在工具栏里。工具栏还能被设置隐藏，
 * 菜单栏在 Windows 上也可能不显示，所以**必须量实际位置**：
 * 写作区内核（`[data-editor-kernel]`，三种编辑模式下都是同一个矩形）的顶边 + 10px。
 * 量不到时退回「工具栏下沿 + 10」，再退回 76。
 */
const barTop = ref(76)

function placeBar(): void {
  const kernel = document.querySelector<HTMLElement>('[data-editor-kernel]')
  let top = kernel?.getBoundingClientRect().top ?? 0
  if (!top) {
    const chrome = document.querySelector<HTMLElement>('.editor-scroll, div.h-11')
    top = chrome?.getBoundingClientRect().top ?? 66
  }
  barTop.value = Math.max(40, Math.round(top + 10))
}

onMounted(() => {
  placeBar()
  window.addEventListener('resize', placeBar)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', placeBar)
})

// 打开那一刻再量一次（工具栏显隐、窗口尺寸都可能刚变过；等一帧让布局落定）
watch(
  () => find.open,
  async (open) => {
    if (!open) return
    await nextTick()
    placeBar()
    queryRef.value?.focus()
    queryRef.value?.select()
  }
)

/**
 * 切到源码面 ⇒ 摘掉渲染面的命中高亮。
 * 高亮是**文档位置**（文档坐标），源码模式那个位置对应的是另一套字符偏移；
 * 而渲染面板在源码模式下 `display: none` 仍常驻，装饰不清会在切回来时留下旧位置。
 */
watch(
  () => find.surface,
  (surface) => {
    if (surface !== 'wysiwyg') setFindHit(null, -1)
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
      :style="{ top: barTop + 'px' }"
      @keydown="onBarKeydown"
      @keydown.esc.prevent="find.hide()"
    >
      <div class="find-row">
        <!-- 折叠三角：只负责展开/收起「替换」那一行。
             旋转用 scoped 样式里的 transform（模板上的 Tailwind `rotate-90` 写的是 rotate
             长属性，配 `transition-transform` 不会动 —— 这个坑在 style.css 里记过） -->
        <button
          class="find-btn find-disclosure"
          :class="{ active: find.replaceExpanded }"
          :title="find.replaceExpanded ? t('find.collapseReplace') : t('find.expandReplace')"
          :aria-label="find.replaceExpanded ? t('find.collapseReplace') : t('find.expandReplace')"
          :aria-expanded="find.replaceExpanded"
          data-find-disclosure
          @click="toggleReplace()"
        >
          <Icon name="chevron-right" :size="13" />
        </button>
        <!-- 输入「组」：放大镜 + 输入框 + 命中计数同处一块软底里（计数不再是浮在右边
             一个 46px 宽的孤零零数字），焦点环与侧栏搜索一致（3px accent-soft 柔光） -->
        <div class="find-field" :class="{ 'is-invalid': !find.queryValid }" data-find-field>
          <Icon name="search" :size="13" class="find-field-icon" />
          <input
            ref="queryRef"
            :value="find.query"
            class="find-input"
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
        </div>
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
        <span class="find-sep" aria-hidden="true" />
        <button
          class="find-btn find-chip find-case"
          :class="{ active: find.caseSensitive }"
          :title="t('find.caseSensitive')"
          :aria-pressed="find.caseSensitive"
          @click="find.toggleCase()"
        >
          Aa
        </button>
        <button
          class="find-btn find-chip find-regex"
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

      <!-- 替换行：折叠三角展开（Ctrl+H 直接展开）。
           左侧留出与「三角 + 间隙」等宽的空档，于是**两个输入框左缘对齐**。 -->
      <div v-if="find.replaceExpanded" class="find-row find-row-replace" data-find-replace-row>
        <span class="find-gutter" aria-hidden="true" />
        <div class="find-field">
          <Icon name="pencil" :size="13" class="find-field-icon" />
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
        </div>
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
/* ── 查找/替换栏 ──────────────────────────────────────────────────────────────
   尺寸与间距口径（与侧栏底部那排工具对齐，改完不再「生硬」）：
     * 控件高 28px、按钮 26px、圆角 8–12px（条 12 / 输入组 9 / 按钮 7）；
     * 行内间隙 6px、条内边距 8px、两行之间 8px + 1px 发丝线（不是靠 gap 硬挤）；
     * **输入框不再是「带边框的灰块」**：输入组自己是一块 `--panel-2` 软底，
       里面的 input 全透明，聚焦时给整组 3px `--accent-soft` 柔光环 —— 与侧栏搜索同一套语言；
     * 命中计数搬进输入组右端（原来是浮在行中间一个 46px 定宽数字，把视觉节奏切断了）；
     * 「Aa」「.*」做成等宽小芯片，动作组与开关组之间一条 1px×16px 竖线分隔。 */
.find-bar {
  position: fixed;
  top: 62px;
  right: 18px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-width: 384px;
  max-width: min(560px, 92vw);
  padding: 8px;
  background: var(--elevate);
  border: 1px solid var(--edge);
  border-radius: 12px;
  box-shadow: var(--shadow-2);
}
.find-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
}
/* 第二行：靠 1px 发丝线 + 对称留白分层，而不是再加一个 gap */
.find-row-replace {
  height: auto;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--edge);
}
/* 与「折叠三角(22px) + 间隙(6px)」等宽 ⇒ 两行输入框左缘对齐 */
.find-gutter {
  flex: none;
  width: 22px;
}

.find-field {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  background: var(--panel-2);
  border-radius: 9px;
  transition: box-shadow 0.16s ease;
}
.find-field:focus-within {
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 正则写错：整组描一圈红（比只把边框染色更容易注意到） */
.find-field.is-invalid {
  box-shadow: 0 0 0 1px var(--danger);
}
.find-field-icon {
  flex: none;
  color: var(--ink-3);
}

.find-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-size: 12.5px;
  color: var(--ink);
  background: transparent;
  border: none;
  outline: none;
}
.find-input::placeholder {
  color: var(--ink-3);
}

.find-count {
  flex: none;
  font-size: 11.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.find-count.empty {
  color: var(--danger);
}

.find-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-width: 26px;
  padding: 0 3px;
  color: var(--ink-2);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}
.find-btn:hover:not(:disabled) {
  background: var(--panel-2);
  color: var(--ink);
}
.find-btn:disabled {
  opacity: 0.35;
}
.find-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 「表达式无效」时正则按钮跟着变红（提示是哪个开关导致的） */
.find-btn.is-invalid {
  color: var(--danger);
}

/* 折叠三角：悬停不变底色（它只是个指示器），展开时图形转 90°（transform 可动画） */
.find-disclosure {
  min-width: 22px;
  padding: 0;
  color: var(--ink-3);
}
.find-disclosure:hover:not(:disabled) {
  background: transparent;
  color: var(--ink-2);
}
.find-disclosure.active {
  background: transparent;
  color: var(--ink-2);
}
.find-disclosure :deep(svg) {
  transition: transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.find-disclosure.active :deep(svg) {
  transform: rotate(90deg);
}

/* 动作组 / 开关组之间的竖分隔（1px × 16px，只用边线色） */
.find-sep {
  flex: none;
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--edge);
}

.find-chip {
  min-width: 28px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

/* 「替换 / 全部替换」：带 1px 描边的幽灵按钮，比裸文字更像按钮，又不抢输入框 */
.find-text {
  height: 26px;
  padding: 0 9px;
  font-size: 11.5px;
  white-space: nowrap;
  border: 1px solid var(--edge);
}
.find-text:hover:not(:disabled) {
  background: var(--panel-2);
}

@media (prefers-reduced-motion: reduce) {
  .find-field,
  .find-btn,
  .find-disclosure :deep(svg) {
    transition: none;
  }
}
</style>
