<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { LANGUAGE_OPTIONS, nextLanguage } from '../i18n'
import { encodingOf } from '../../../shared/encodings'
import { eolLabel } from '../../../shared/eol'
import Icon from './Icon.vue'
import type { ThemeMode } from '../../../shared/types'

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()

const langShort = computed(
  () => LANGUAGE_OPTIONS.find((o) => o.value === settings.language)?.short ?? 'EN'
)

/** 当前文档的编码名（专有名，不走 i18n；文档本身没打开时整块不渲染） */
const currentEncodingLabel = computed(() => {
  const id = files.current?.encoding
  return id ? (encodingOf(id)?.label ?? String(id)) : ''
})

/** 当前文档的行尾标记（LF / CRLF）——点一下就在两者间切换并写回 */
const currentEolLabel = computed(() => eolLabel(files.current?.eol ?? 'lf'))

const themeOpen = ref(false)
const themeRef = ref<HTMLElement | null>(null)
const saveOpen = ref(false)
const saveRef = ref<HTMLElement | null>(null)
const version = ref('')

function onDocClick(e: MouseEvent): void {
  if (themeOpen.value && themeRef.value && !themeRef.value.contains(e.target as Node)) {
    themeOpen.value = false
  }
  if (saveOpen.value && saveRef.value && !saveRef.value.contains(e.target as Node)) {
    saveOpen.value = false
  }
}
onMounted(async () => {
  document.addEventListener('mousedown', onDocClick)
  version.value = await window.luminAPI.app.getVersion()
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))

/**
 * 状态栏最左那格的文字：**只显示「文档状态」，不再显示保存方式**（用户口径）。
 *
 * 原来手动模式会一直写着「手动保存」——那是模式名，不是状态，选过一次之后就是重复噪音。
 * 现在两种模式都只说状态（保存中 / 未保存的更改 / 已保存），
 * 保存方式本身放在点击后弹出的那一层里（那里仍然写着「自动保存 / 手动保存」）。
 */
const saveLabel = computed(() => {
  if (!files.current) return ''
  if (files.saving) return t('editor.saving')
  if (files.dirty) return t('editor.unsaved')
  return t('editor.saved')
})

/** 弹层与无障碍名：格子上的可见文字只剩状态，保存方式要在这里说清楚 */
const saveModeLabel = computed(() =>
  settings.autoSave ? t('statusbar.autoSave') : t('statusbar.manualSave')
)
const saveTriggerLabel = computed(() => `${t('statusbar.saveMode')}：${saveModeLabel.value}`)

/** 选择保存方式：自动保存（开）或手动保存（关） */
function chooseSaveMode(manual: boolean): void {
  saveOpen.value = false
  if (settings.autoSave === !manual) return
  settings.set('autoSave', !manual)
  if (manual) files.cancelAutoSave()
  // 不发通知：状态栏这一格与菜单里的勾选态会立刻变成新值，结果已在界面上
}

/**
 * 保存方式弹层里点「打开设置…」：先关弹层再进设置。
 * 写成方法而不是模板内联多语句：prettier 会把内联多语句的分号吃掉（变成 `a = 1 b()`），
 * Vue 模板编译器随即报 "Error parsing JavaScript expression"。逻辑进脚本是更稳、更好测的写法。
 */
function openGeneralSettings(): void {
  saveOpen.value = false
  ui.openSettings('general')
}

/** 主题弹层里选一种主题 */
function pickTheme(mode: ThemeMode): void {
  settings.setTheme(mode)
  themeOpen.value = false
}

const themes: { mode: ThemeMode; icon: string; labelKey: string }[] = [
  { mode: 'auto', icon: 'monitor', labelKey: 'settings.themeAuto' },
  { mode: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { mode: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
  { mode: 'sepia', icon: 'book', labelKey: 'settings.themeSepia' }
]
</script>

<template>
  <div
    class="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-app px-3 text-[11.5px] text-ink-3"
  >
    <!-- 左侧：文档状态 + 保存方式（点击弹出竖向选择） -->
    <template v-if="files.current">
      <div ref="saveRef" class="relative flex items-center">
        <button
          class="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors hover:bg-panel-2"
          data-save-cell
          :title="saveTriggerLabel"
          :aria-label="saveTriggerLabel"
          @click="saveOpen = !saveOpen"
        >
          <!-- 状态文字：**一律与状态栏同色**（用户口径：不要强调色、不要前面的小圆点）。
               保存中/未保存的更改/已保存 三态只靠文字区分；保存方式在弹层里说。
               `aria-live="polite"`：读屏器用户按 Ctrl+S 后需要**听到**结果
               （审计 §8：全仓此前没有一处 live region，保存/出错都不会被播报）。 -->
          <span aria-live="polite">{{ saveLabel }}</span>
          <!-- <Icon name="chevron-up" :size="10" class="opacity-60 transition-transform duration-150" :class="saveOpen ? 'rotate-180' : ''" /> -->
        </button>

        <Transition name="pop">
          <div
            v-if="saveOpen"
            class="absolute bottom-7 left-0 z-50 w-[236px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
          >
            <p
              class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3"
            >
              {{ t('statusbar.saveMode') }}
            </p>
            <button
              class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100"
              :class="settings.autoSave ? 'bg-accent-soft' : 'hover:bg-panel-2'"
              @click="chooseSaveMode(false)"
            >
              <Icon
                name="refresh"
                :size="14"
                :class="settings.autoSave ? 'mt-0.5 text-accent' : 'mt-0.5 text-ink-3'"
              />
              <span class="min-w-0 flex-1">
                <span
                  class="block text-[12.5px] font-medium"
                  :class="settings.autoSave ? 'text-accent' : 'text-ink'"
                  >{{ t('statusbar.autoSave') }}</span
                >
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3">{{
                  t('settings.autoSaveDesc', { sec: settings.autoSaveInterval })
                }}</span>
              </span>
              <span
                v-if="settings.autoSave"
                class="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent"
              >
                <Icon name="check" :size="10" class="text-white" />
              </span>
            </button>
            <button
              class="mt-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100"
              :class="!settings.autoSave ? 'bg-accent-soft' : 'hover:bg-panel-2'"
              @click="chooseSaveMode(true)"
            >
              <Icon
                name="save"
                :size="14"
                :class="!settings.autoSave ? 'mt-0.5 text-accent' : 'mt-0.5 text-ink-3'"
              />
              <span class="min-w-0 flex-1">
                <span
                  class="block text-[12.5px] font-medium"
                  :class="!settings.autoSave ? 'text-accent' : 'text-ink'"
                  >{{ t('statusbar.manualSave') }}</span
                >
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3"
                  >Ctrl+S {{ t('common.save') }}</span
                >
              </span>
              <span
                v-if="!settings.autoSave"
                class="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent"
              >
                <Icon name="check" :size="10" class="text-white" />
              </span>
            </button>
            <div class="my-1 border-t border-edge" />
            <button
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink-2"
              @click="openGeneralSettings"
            >
              <Icon name="settings" :size="12" />
              {{ t('statusbar.openSettings') }}
            </button>
          </div>
        </Transition>
      </div>
    </template>
    <span v-else>Lumin — Write in Light.</span>

    <div class="flex-1" />

    <!-- 中间：统计 -->
    <template v-if="files.current">
      <span class="tabular-nums">{{ files.wordCount }} {{ t('editor.words') }}</span>
      <span class="tabular-nums">{{ files.lineCount }} {{ t('editor.lines') }}</span>
      <span class="hidden tabular-nums sm:inline"
        >{{ files.charCount }} {{ t('editor.chars') }}</span
      >
      <span class="h-3 w-px bg-edge" />
      <span class="tabular-nums">{{
        t('editor.cursor', { line: ui.cursor.line, col: ui.cursor.col })
      }}</span>
    </template>

    <div class="flex-1" />

    <!-- 当前文档编码（次要信息：夹在统计与主题切换之间，只读展示 + tooltip） -->
    <span
      v-if="files.current"
      class="flex items-center gap-1 tabular-nums"
      :title="t('statusbar.encodingTooltip')"
      data-status-encoding
    >
      <Icon name="globe" :size="12" />
      <span>{{ currentEncodingLabel }}</span>
    </span>

    <!--
      行尾：**可点**（LF ⇄ CRLF，点击即按新行尾写回）。
      为什么放状态栏而不只放菜单：行尾是「打开→保存会不会整文件 diff」的直接原因，
      用户需要一眼看到它、并且一键改掉（见 shared/eol.ts 与 stores/files.setEol）。
    -->
    <button
      v-if="files.current"
      class="flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="t('statusbar.eolTooltip', { eol: currentEolLabel })"
      data-status-eol
      @click="files.toggleEol()"
    >
      <Icon name="align-left" :size="12" />
      <span>{{ currentEolLabel }}</span>
    </button>

    <!-- 右侧：主题 / 语言 -->
    <div ref="themeRef" class="relative flex items-center">
      <button
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        @click="themeOpen = !themeOpen"
      >
        <Icon
          :name="themes.find((th) => th.mode === settings.theme)?.icon || 'monitor'"
          :size="13"
        />
        <span>{{
          t(themes.find((th) => th.mode === settings.theme)?.labelKey || 'settings.themeAuto')
        }}</span>
        <Icon
          name="chevron-down"
          :size="11"
          :class="themeOpen ? 'rotate-180 transition-transform' : 'transition-transform'"
        />
      </button>
      <Transition name="pop">
        <div
          v-if="themeOpen"
          class="absolute bottom-8 right-0 z-50 w-[160px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
          :style="{ boxShadow: 'var(--shadow-2)' }"
        >
          <button
            v-for="th in themes"
            :key="th.mode"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
            :class="
              settings.theme === th.mode
                ? 'bg-accent-soft text-accent'
                : 'text-ink hover:bg-panel-2'
            "
            @click="pickTheme(th.mode)"
          >
            <Icon :name="th.icon" :size="14" />
            {{ t(th.labelKey) }}
            <Icon v-if="settings.theme === th.mode" name="check" :size="13" class="ml-auto" />
          </button>
        </div>
      </Transition>
    </div>

    <button
      class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="langShort + ' · ' + t('statusbar.switchLanguage')"
      @click="settings.setLanguage(nextLanguage(settings.language))"
    >
      <Icon name="globe" :size="13" />
      <span>{{ langShort }}</span>
    </button>

    <span class="text-ink-3/70">v{{ version }}</span>
  </div>
</template>
