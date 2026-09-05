<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'
import type { ThemeMode } from '../../../shared/types'

const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()

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
  if (!settings.autoSave) return '未开启自动保存'
  if (files.saving) return '保存中…'
  if (files.dirty) return '未保存的更改'
  return '已保存'
})

const saveNeutral = computed(() => !!files.current && !settings.autoSave)

/** 选择保存方式：自动保存（开）或手动保存（关） */
function chooseSaveMode(manual: boolean): void {
  saveOpen.value = false
  if (settings.autoSave === !manual) return
  settings.set('autoSave', !manual)
  if (manual) files.cancelAutoSave()
  ui.toast(manual ? '已切换为手动保存' : '已开启自动保存', manual ? 'info' : 'success')
}

const themes: { mode: ThemeMode; icon: string; label: string }[] = [
  { mode: 'auto', icon: 'monitor', label: '跟随系统' },
  { mode: 'light', icon: 'sun', label: '浅色' },
  { mode: 'dark', icon: 'moon', label: '深色' },
  { mode: 'sepia', icon: 'book', label: '羊皮纸' }
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
          class="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors hover:bg-panel-2"
          :title="settings.autoSave ? '自动保存已开启，点击选择保存方式' : '未开启自动保存，点击选择保存方式'"
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
          <Icon name="chevron-up" :size="10" class="opacity-60 transition-transform duration-150" :class="saveOpen ? 'rotate-180' : ''" />
        </button>

        <Transition name="pop">
          <div
            v-if="saveOpen"
            class="absolute bottom-7 left-0 z-50 w-[236px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
            :style="{ boxShadow: 'var(--shadow-2)' }"
          >
            <p class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">保存方式</p>
            <button
              class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100"
              :class="settings.autoSave ? 'bg-accent-soft' : 'hover:bg-panel-2'"
              @click="chooseSaveMode(false)"
            >
              <Icon name="refresh" :size="14" :class="settings.autoSave ? 'mt-0.5 text-accent' : 'mt-0.5 text-ink-3'" />
              <span class="min-w-0 flex-1">
                <span class="block text-[12.5px] font-medium" :class="settings.autoSave ? 'text-accent' : 'text-ink'">自动保存</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3">自动保存（间隔 {{ settings.autoSaveInterval }} 秒）</span>
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
                <span class="block text-[12.5px] font-medium" :class="!settings.autoSave ? 'text-accent' : 'text-ink'">手动保存</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-ink-3">Ctrl+S 保存</span>
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
              打开设置…
            </button>
          </div>
        </Transition>
      </div>
      <span class="h-3 w-px bg-edge" />
      <span class="max-w-[260px] truncate" :title="files.current.path || files.current.name">
        {{ files.current.name }}
      </span>
    </template>
    <span v-else>Lumin — Write in Light.</span>

    <div class="flex-1" />

    <!-- 中间：统计 -->
    <template v-if="files.current">
      <span class="tabular-nums">{{ files.wordCount }} 字</span>
      <span class="tabular-nums">{{ files.lineCount }} 行</span>
      <span class="hidden tabular-nums sm:inline">{{ files.charCount }} 字符</span>
      <span class="h-3 w-px bg-edge" />
      <span class="tabular-nums">行 {{ ui.cursor.line }}，列 {{ ui.cursor.col }}</span>
    </template>

    <div class="flex-1" />

    <!-- 右侧：主题 / 语言 -->
    <div ref="themeRef" class="relative flex items-center">
      <button
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
        @click="themeOpen = !themeOpen"
      >
        <Icon :name="themes.find((t) => t.mode === settings.theme)?.icon || 'monitor'" :size="13" />
        <span>{{ themes.find((t) => t.mode === settings.theme)?.label }}</span>
        <Icon name="chevron-down" :size="11" :class="themeOpen ? 'rotate-180 transition-transform' : 'transition-transform'" />
      </button>
      <Transition name="pop">
        <div
          v-if="themeOpen"
          class="absolute bottom-8 right-0 z-50 w-[160px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
          :style="{ boxShadow: 'var(--shadow-2)' }"
        >
          <button
            v-for="t in themes"
            :key="t.mode"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
            :class="settings.theme === t.mode ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-panel-2'"
            @click="
              () => {
                settings.setTheme(t.mode)
                themeOpen = false
              }
            "
          >
            <Icon :name="t.icon" :size="14" />
            {{ t.label }}
            <Icon v-if="settings.theme === t.mode" name="check" :size="13" class="ml-auto" />
          </button>
        </div>
      </Transition>
    </div>

    <button
      class="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-ink-2"
      :title="'切换语言 / Switch language'"
      @click="settings.setLanguage(settings.language === 'zh-CN' ? 'en-US' : 'zh-CN')"
    >
      <Icon name="globe" :size="13" />
      <span>{{ settings.language === 'zh-CN' ? '中文' : 'EN' }}</span>
    </button>

    <span class="text-ink-3/70">v{{ version }}</span>
  </div>
</template>
