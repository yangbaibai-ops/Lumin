<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { LANGUAGE_OPTIONS, nextLanguage } from '../i18n'
import Icon from './Icon.vue'
import type { ThemeMode } from '../../../shared/types'

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()

const langShort = computed(
  () => LANGUAGE_OPTIONS.find((o) => o.value === settings.language)?.short ?? 'EN'
)

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

const saveLabel = computed(() => {
  if (!files.current) return ''
  // 手动保存模式：明确提示“未开启自动保存”（点击此区域可选择保存方式）
  if (!settings.autoSave) return t('statusbar.manualSave')
  if (files.saving) return t('editor.saving')
  if (files.dirty) return t('editor.unsaved')
  return t('editor.saved')
})

const saveNeutral = computed(() => !!files.current && !settings.autoSave)

/** 选择保存方式：自动保存（开）或手动保存（关） */
function chooseSaveMode(manual: boolean): void {
  saveOpen.value = false
  if (settings.autoSave === !manual) return
  settings.set('autoSave', !manual)
  if (manual) files.cancelAutoSave()
  ui.toast(manual ? t('toast.manualSave') : t('toast.autoSaveOn'), manual ? 'info' : 'success')
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
    class="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-panel/80 px-3 text-[11.5px] text-ink-3 backdrop-blur-md"
  >
    <!-- 左侧：文档状态 + 保存方式（点击弹出竖向选择） -->
    <template v-if="files.current">
      <div ref="saveRef" class="relative flex items-center">
        <button
          class="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors hover:bg-panel-2"
          :title="saveLabel"
          @click="saveOpen = !saveOpen"
        >
          <!-- 手动保存模式：不显示状态圆点；文字不加强调色（沿用底部默认色） -->
          <span v-if="!saveNeutral" class="relative flex h-1.5 w-1.5">
            <span
              v-if="files.saving"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60"
            />
            <span
              class="relative inline-flex h-1.5 w-1.5 rounded-full"
              :class="files.saving ? 'bg-warning' : files.dirty ? 'bg-warning' : 'bg-ok'"
            />
          </span>
          <span :class="saveNeutral ? '' : files.saving ? 'text-warning' : files.dirty ? 'text-warning' : 'text-ok'">
            {{ saveLabel }}
          </span>
          <!-- <Icon name="chevron-up" :size="10" class="opacity-60 transition-transform duration-150" :class="saveOpen ? 'rotate-180' : ''" /> -->
        </button>

        <Transition name="pop">
          <div
            v-if="saveOpen"
            class="absolute bottom-7 left-0 z-50 w-[236px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
          >
            <p class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">{{ t('statusbar.saveMode') }}</p>
            <button
              class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100"
              :class="settings.autoSave ? 'bg-accent-soft' : 'hover:bg-panel-2'"
              @click="chooseSaveMode(false)"
            >
              <Icon name="refresh" :size="14" :class="settings.autoSave ? 'mt-0.5 text-accent' : 'mt-0.5 text-ink-3'" />
              <span class="min-w-0 flex-1">
                <span class="block text-[12.5px] font-medium" :class="settings.autoSave ? 'text-accent' : 'text-ink'">{{ t('statusbar.autoSave') }}</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3">{{ t('settings.autoSaveDesc', { sec: settings.autoSaveInterval }) }}</span>
              </span>
              <span v-if="settings.autoSave" class="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent">
                <Icon name="check" :size="10" class="text-white" />
              </span>
            </button>
            <button
              class="mt-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100"
              :class="!settings.autoSave ? 'bg-accent-soft' : 'hover:bg-panel-2'"
              @click="chooseSaveMode(true)"
            >
              <Icon name="save" :size="14" :class="!settings.autoSave ? 'mt-0.5 text-accent' : 'mt-0.5 text-ink-3'" />
              <span class="min-w-0 flex-1">
                <span class="block text-[12.5px] font-medium" :class="!settings.autoSave ? 'text-accent' : 'text-ink'">{{ t('statusbar.manualSave') }}</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3">Ctrl+S {{ t('common.save') }}</span>
              </span>
              <span v-if="!settings.autoSave" class="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent">
                <Icon name="check" :size="10" class="text-white" />
              </span>
            </button>
            <div class="my-1 border-t border-edge" />
            <button
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink-2"
              @click="
                () => {
                  saveOpen = false
                  ui.openSettings('general')
                }
              "
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
      <span class="hidden tabular-nums sm:inline">{{ files.charCount }} {{ t('editor.chars') }}</span>
      <span class="h-3 w-px bg-edge" />
      <span class="tabular-nums">{{ t('editor.cursor', { line: ui.cursor.line, col: ui.cursor.col }) }}</span>
    </template>

    <div class="flex-1" />

    <!-- 右侧：主题 / 语言 -->
    <div ref="themeRef" class="relative flex items-center">
      <button
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        @click="themeOpen = !themeOpen"
      >
        <Icon :name="themes.find((th) => th.mode === settings.theme)?.icon || 'monitor'" :size="13" />
        <span>{{ t(themes.find((th) => th.mode === settings.theme)?.labelKey || 'settings.themeAuto') }}</span>
        <Icon name="chevron-down" :size="11" :class="themeOpen ? 'rotate-180 transition-transform' : 'transition-transform'" />
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
            :class="settings.theme === th.mode ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-panel-2'"
            @click="
              () => {
                settings.setTheme(th.mode)
                themeOpen = false
              }
            "
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
