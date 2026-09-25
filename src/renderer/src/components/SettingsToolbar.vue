<script setup lang="ts">
// ─── 设置 · 快捷工具栏（调整工具项）──────────────────────────────────────────
// 与工具栏空白区右键菜单里的「调整工具项」是**同一个界面**：右键菜单只是把设置
// 打开到编辑器分组并把这个区块高亮一下（ui.toolbarAdjustFocus），不再另起模态浮层
// —— 模态套模态会让 Esc 与遮罩层级的语义变得含糊。
//
// 数据模型：settings.toolbarItems 是「已显示项目的顺序」列表（目录见
// shared/toolbarItems.ts），所以「隐藏一项」= 从列表里删掉，「显示一项」= 插回去。
// 顺序调整只在同组内进行：分组决定工具栏上的分隔线位置，跨组换序会把分隔线搅乱。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import {
  DEFAULT_TOOLBAR_ITEMS,
  TOOLBAR_ITEMS,
  insertToolbarItemByOrder,
  moveToolbarItem,
  sanitizeToolbarItems,
  sameToolbarGroup,
  toolbarItemDef,
  type ToolbarItemDef
} from '../../../shared/toolbarItems'
import Icon from './Icon.vue'
import SettingSwitch from './SettingSwitch.vue'

const { t } = useI18n()
const settings = useSettingsStore()
const ui = useUiStore()

const sectionRef = ref<HTMLElement | null>(null)
/** 高亮边框（从右键菜单进来时闪一下，让用户知道该看哪一块） */
const highlight = ref(false)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

/** 当前已显示的项目（顺序即工具栏上的顺序） */
const shown = computed<ToolbarItemDef[]>(() =>
  sanitizeToolbarItems(settings.toolbarItems)
    .map((id) => toolbarItemDef(id))
    .filter((d): d is ToolbarItemDef => !!d)
)
/** 当前未显示的项目（按目录顺序） */
const hidden = computed<ToolbarItemDef[]>(() => {
  const ids = new Set(shown.value.map((d) => d.id))
  return TOOLBAR_ITEMS.filter((d) => !ids.has(d.id))
})

function write(next: string[]): void {
  settings.set('toolbarItems', next)
}

/** 同组内上/下移一格；到组边界时是 no-op（按钮在那儿本就是禁用的） */
function move(id: string, dir: -1 | 1): void {
  write(moveToolbarItem(sanitizeToolbarItems(settings.toolbarItems), id, dir))
}

/** 该项能否向上/向下移动（同组边界判定，供按钮禁用态） */
function canMove(id: string, dir: -1 | 1): boolean {
  const list = sanitizeToolbarItems(settings.toolbarItems)
  const at = list.indexOf(id)
  if (at < 0) return false
  const to = at + dir
  if (to < 0 || to >= list.length) return false
  return sameToolbarGroup(id, list[to])
}

/** 隐藏一项：从顺序列表里删掉 */
function hide(id: string): void {
  write(sanitizeToolbarItems(settings.toolbarItems).filter((x) => x !== id))
}

/** 显示一项：按出厂顺序插到「它前面最近的已显示项」之后 */
function show(id: string): void {
  write(insertToolbarItemByOrder(sanitizeToolbarItems(settings.toolbarItems), id))
}

function reset(): void {
  write([...DEFAULT_TOOLBAR_ITEMS])
}

/** 文案：标题带序号，其余用项目自己的 i18n key */
function labelOf(d: ToolbarItemDef): string {
  return d.level ? `${t(d.labelKey)} ${d.level}` : t(d.labelKey)
}

/** 分组名（仅用于列表里的分组小标题，让「同组才能换序」这件事可见） */
const groupLabelKeys: Record<ToolbarItemDef['group'], string> = {
  history: 'toolbar.groupHistory',
  heading: 'toolbar.groupHeading',
  inline: 'toolbar.groupInline',
  block: 'toolbar.groupBlock',
  insert: 'toolbar.groupInsert'
}

/** 工具栏整体被关掉时，下面的排序/显隐控件一并置灰（它们此刻没有可观察的效果） */
const toolbarOff = computed(() => !settings.toolbarVisible)

/**
 * 从右键菜单进来：滚到本区块 + 闪一下高亮。
 * 监听的是 ui.toolbarAdjustFocus，且只在设置已经打开时处理——用户此刻就在编辑器页。
 */
watch(
  () => [ui.settingsOpen, ui.toolbarAdjustFocus] as const,
  ([open, focus]) => {
    if (!open || !focus) return
    void nextTick(() => {
      sectionRef.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flash()
      ui.clearToolbarAdjustFocus()
    })
  },
  { immediate: true }
)

function flash(): void {
  if (highlightTimer) clearTimeout(highlightTimer)
  highlight.value = true
  highlightTimer = setTimeout(() => {
    highlightTimer = null
    highlight.value = false
  }, 1600)
}

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer)
})
</script>

<template>
  <section
    ref="sectionRef"
    class="set-card transition-shadow duration-300"
    :class="highlight ? 'ring-2 ring-accent' : ''"
    data-setting-toolbar
  >
    <div class="flex items-start gap-4">
      <div class="min-w-0 flex-1">
        <p class="text-[13.5px] text-ink">{{ t('toolbar.visible') }}</p>
        <p class="mt-0.5 text-[12px] leading-relaxed text-ink-2b">{{ t('toolbar.visibleDesc') }}</p>
      </div>
      <SettingSwitch
        :model-value="settings.toolbarVisible"
        :label="t('toolbar.visible')"
        data-setting-toolbar-switch
        @update:model-value="(v) => settings.set('toolbarVisible', v)"
      />
    </div>

    <!-- 19 项的排序/显隐是**低频**操作（用户口径：该折叠的折叠）⇒ 默认收起，
         只留一行「调整工具项 (19/19)」；展开后才是那一长列。 -->
    <details class="set-fold set-fold--plain mt-2" data-setting-toolbar-fold>
      <summary>
        <Icon name="chevron-right" :size="13" class="set-fold-chevron" />
        {{ t('toolbar.adjust') }}
        <span class="set-fold-hint">{{
          t('toolbar.shownCount', { n: shown.length, total: TOOLBAR_ITEMS.length })
        }}</span>
        <span class="flex-1" />
        <button
          class="btn btn-outline flex-none px-2.5 py-1 text-[12px]"
          :disabled="toolbarOff"
          :title="t('toolbar.reset')"
          data-setting-toolbar-reset
          @click.prevent="reset"
        >
          <Icon name="refresh" :size="12" />
          {{ t('toolbar.reset') }}
        </button>
      </summary>

      <!-- 已显示：顺序即工具栏上的顺序，同组内可上/下移 -->
      <div class="set-fold-body">
        <div class="rounded-xl border border-edge" :class="toolbarOff ? 'opacity-50' : ''">
          <div class="border-b border-edge px-3 py-2 text-[11.5px] text-ink-2b">
            {{ t('toolbar.shownCount', { n: shown.length, total: TOOLBAR_ITEMS.length }) }}
          </div>

          <p
            v-if="!shown.length"
            class="px-3.5 py-5 text-center text-[12.5px] text-ink-2b"
            data-setting-toolbar-empty
          >
            {{ t('toolbar.allHidden') }}
          </p>

          <template v-for="(d, i) in shown" :key="d.id">
            <!-- 分组小标题：让「同组才能换序」这条规则在界面上可见 -->
            <p
              v-if="i === 0 || shown[i - 1].group !== d.group"
              class="px-3 pt-2.5 text-[11px] font-medium text-ink-2b"
            >
              {{ t(groupLabelKeys[d.group]) }}
            </p>
            <div
              class="flex items-center gap-2 px-3 py-1.5"
              :class="i === shown.length - 1 ? '' : 'border-b border-edge/60'"
              :data-setting-toolbar-item="d.id"
            >
              <span class="flex h-6 w-6 flex-none items-center justify-center text-ink-2b">
                <Icon :name="d.icon" :size="14" />
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px] text-ink">{{ labelOf(d) }}</span>
              <button
                class="icon-btn h-6 w-6"
                :disabled="toolbarOff || !canMove(d.id, -1)"
                :title="t('toolbar.moveUp')"
                :aria-label="t('toolbar.moveUp')"
                @click="move(d.id, -1)"
              >
                <Icon name="chevron-up" :size="13" />
              </button>
              <button
                class="icon-btn h-6 w-6"
                :disabled="toolbarOff || !canMove(d.id, 1)"
                :title="t('toolbar.moveDown')"
                :aria-label="t('toolbar.moveDown')"
                @click="move(d.id, 1)"
              >
                <Icon name="chevron-down" :size="13" />
              </button>
              <button
                class="icon-btn h-6 w-6"
                :disabled="toolbarOff"
                :title="t('toolbar.hideItem')"
                :aria-label="t('toolbar.hideItem')"
                @click="hide(d.id)"
              >
                <Icon name="x" :size="13" />
              </button>
            </div>
          </template>
        </div>

        <!-- 未显示：点「加入」即按目录顺序回到工具栏 -->
        <div v-if="hidden.length" class="mt-3 rounded-xl border border-dashed border-edge">
          <div class="border-b border-edge/60 px-3 py-2 text-[11.5px] text-ink-2b">
            {{ t('toolbar.hiddenCount', { n: hidden.length }) }}
          </div>
          <div
            v-for="(d, i) in hidden"
            :key="d.id"
            class="flex items-center gap-2 px-3 py-1.5"
            :class="i === hidden.length - 1 ? '' : 'border-b border-edge/60'"
            :data-setting-toolbar-hidden-item="d.id"
          >
            <span class="flex h-6 w-6 flex-none items-center justify-center text-ink-2b">
              <Icon :name="d.icon" :size="14" />
            </span>
            <span class="min-w-0 flex-1 truncate text-[13px] text-ink-2">{{ labelOf(d) }}</span>
            <button
              class="icon-btn h-6 w-6"
              :disabled="toolbarOff"
              :title="t('toolbar.showItem')"
              :aria-label="t('toolbar.showItem')"
              @click="show(d.id)"
            >
              <Icon name="plus" :size="13" />
            </button>
          </div>
        </div>

        <p class="mt-3 text-[11.5px] leading-relaxed text-ink-2b">{{ t('toolbar.hint') }}</p>
      </div>
    </details>
  </section>
</template>
