<script setup lang="ts">
// ─── 命令面板（Ctrl+Shift+P）───────────────────────────────────────────────────
//
// 打开 / 关闭的入口有两个：
//   * 快捷键服务（`useKeymap.ts` 的 `app.commandPalette`，默认 Mod+Shift+P）—— 写 store 旗标；
//   * 面板内的 Esc / 遮罩点击 —— 自己调 `ui.closeCommandPalette()`。
// 面板只**读**那个旗标，于是"谁打开的"和"谁关的"不会各持一份状态。
//
// 过滤与排序**全部**在 `lib/commandPalette.ts`（纯函数，有单测）：这里只负责
// 把 i18n 标题喂进去、把键盘事件翻译成"移动/执行/关闭"。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useAppActions } from '../composables/useAppActions'
import { buildPaletteCommands } from '../composables/useCommandPalette'
import { filterCommands, moveSelection, type CommandPaletteItem } from '../lib/commandPalette'
import { currentKeymap } from '../lib/keymap/service'
import Icon from './Icon.vue'

const { t } = useI18n()
const ui = useUiStore()
const actions = useAppActions()

const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/**
 * 「打开面板时焦点在谁身上」：关掉之后要还回去（`lastFocusedElement`）。
 * 取的是打开那一刻的 `document.activeElement`（可能是编辑区的 `.ProseMirror`、
 * 源码 textarea、或者用户刚才点的某个按钮）—— Esc 之后"焦点回到编辑器或原来那个元素"
 * 这条 a11y 要求靠它落地；元素已经不在 DOM 里（切了路由等）就退到编辑面。
 */
const lastFocusedElement = ref<Element | null>(null)

/** 命令表 + 生效键位：标题从语言包解析，键位从快捷键服务读（展示用，不参与过滤） */
const commands = computed<CommandPaletteItem[]>(() => {
  const handle = currentKeymap()
  return buildPaletteCommands(actions).map((c) => ({
    ...c,
    keys: handle?.get(c.id)?.keys ?? null
  }))
})

const visible = computed(() => filterCommands(commands.value, query.value, (c) => t(c.labelKey)))

/** 列表里渲染的一项：标题与分组标题都在这里解析好（模板里不再拼 key） */
const rows = computed(() =>
  visible.value.map((c) => ({
    item: c,
    label: t(c.labelKey),
    group: c.groupKey ? t(c.groupKey) : '',
    keys: c.keys ?? ''
  }))
)

/**
 * 高亮项的元素 id：`aria-activedescendant` 指向它（输入框保持焦点，读屏器念这一行）。
 * 用自增序号而不是命令 id：id 里有 `.`，放进 DOM id 合法但不好选。
 */
const optionId = (index: number): string => `command-palette-option-${index}`

watch(
  () => ui.commandPaletteOpen,
  (open) => {
    if (open) {
      lastFocusedElement.value = typeof document === 'undefined' ? null : document.activeElement
      query.value = ''
      activeIndex.value = 0
      void nextTick(() => inputEl.value?.focus())
    } else {
      // 焦点还原：优先给"打开前那个元素"（还在 DOM 里的话），否则退到编辑面。
      // 两者都没有（比如欢迎页）就把焦点留在原处 —— 不要硬抢到 body 上。
      const el = lastFocusedElement.value as HTMLElement | null
      if (el && document.contains(el) && typeof el.focus === 'function') el.focus()
      else {
        const surface = document.querySelector<HTMLElement>('.ProseMirror, .source-editor')
        surface?.focus()
      }
      lastFocusedElement.value = null
    }
  }
)

// 候选集变了：高亮回到第一项（否则会停在一个已经不存在的下标上）
watch(visible, () => {
  activeIndex.value = 0
})
// 高亮跟着键盘走：滚进视口，但不抢输入框的焦点
watch(activeIndex, () => {
  void nextTick(() => {
    const box = listEl.value
    if (!box) return
    const el = box.querySelector<HTMLElement>(`[data-command-palette-index="${activeIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
})

async function runAt(index: number): Promise<void> {
  const cmd = visible.value[index]
  if (!cmd) return
  ui.closeCommandPalette()
  try {
    await cmd.run()
  } catch {
    /* 动作内部自行提示错误（与菜单/快捷键同一口径） */
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    ui.closeCommandPalette()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = moveSelection(
      activeIndex.value,
      e.key === 'ArrowDown' ? 1 : -1,
      visible.value.length
    )
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    void runAt(activeIndex.value)
    return
  }
  if (e.key === 'Home' || e.key === 'End') {
    // 结果可能上百条：键盘用户到两端不该靠按住方向键
    e.preventDefault()
    activeIndex.value = e.key === 'Home' ? 0 : Math.max(0, visible.value.length - 1)
  }
}

// 遮罩点击即关闭；但点面板内部不关（@click.self 只认遮罩自己）
function onScrimDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) ui.closeCommandPalette()
}

onBeforeUnmount(() => {
  lastFocusedElement.value = null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.commandPaletteOpen"
        class="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center bg-scrim pt-[12vh] backdrop-blur-[2px]"
        role="dialog"
        aria-modal="true"
        :aria-label="t('commandPalette.title')"
        data-command-palette
        @mousedown="onScrimDown"
      >
        <Transition name="pop" appear>
          <div
            class="flex w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-edge bg-elevate shadow-2xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
            @keydown="onKeydown"
          >
            <!-- 输入行：焦点环挂在**行**上（输入框本身 outline-none 是为了干掉浏览器默认描边），
                 与查找栏 / 全局搜索同一做法 —— 键盘用户看得见的那圈描边在这里 -->
            <div
              class="flex items-center gap-3 border-b border-edge px-4 py-3.5 transition-colors focus-within:border-accent"
            >
              <Icon name="search" :size="17" class="text-accent" />
              <input
                ref="inputEl"
                v-model="query"
                class="flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-2b"
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="command-palette-listbox"
                :aria-expanded="true"
                :aria-activedescendant="rows.length ? optionId(activeIndex) : undefined"
                :aria-label="t('commandPalette.title')"
                :placeholder="t('commandPalette.placeholder')"
                spellcheck="false"
                data-command-palette-input
              />
              <span
                v-if="rows.length"
                class="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] tabular-nums text-ink-2b"
                data-command-palette-count
              >
                {{ t('commandPalette.resultCount', { n: rows.length }) }}
              </span>
            </div>

            <!-- 结果列表：listbox + option（焦点始终在输入框上，用 aria-activedescendant 表达高亮） -->
            <div
              id="command-palette-listbox"
              ref="listEl"
              class="max-h-[52vh] overflow-y-auto overscroll-contain p-1.5"
              role="listbox"
              :aria-label="t('commandPalette.title')"
              data-command-palette-list
            >
              <div
                v-if="!rows.length"
                class="px-3 py-6 text-center text-ui text-ink-2b"
                data-command-palette-empty
              >
                {{ t('commandPalette.empty') }}
              </div>
              <button
                v-for="(row, i) in rows"
                :id="optionId(i)"
                :key="row.item.id"
                type="button"
                role="option"
                :aria-selected="i === activeIndex ? 'true' : 'false'"
                :data-command-palette-item="row.item.id"
                :data-command-palette-index="i"
                class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
                :class="
                  i === activeIndex ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-panel-2'
                "
                @mousemove="activeIndex = i"
                @click="runAt(i)"
              >
                <span class="flex h-4 w-4 flex-none items-center justify-center text-ink-2b">
                  <Icon v-if="row.item.icon" :name="row.item.icon" :size="13" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                <span v-if="row.group" class="flex-none text-[11px] text-ink-2b">{{
                  row.group
                }}</span>
                <kbd
                  v-if="row.keys"
                  class="flex-none rounded border border-edge bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2b"
                  data-command-palette-keys
                >
                  {{ row.keys }}
                </kbd>
              </button>
            </div>

            <div
              class="flex items-center gap-2 border-t border-edge px-4 py-2 text-[11px] text-ink-2b"
            >
              {{ t('commandPalette.hint') }}
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
