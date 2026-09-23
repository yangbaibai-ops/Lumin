<script setup lang="ts">
// 右侧大纲面板（三栏模式）：设置里打开「大纲放在编辑区右侧」后，它出现在编辑区右侧，
// 于是左侧文件树与大纲可以同时看到。面板本身支持折叠/展开：
//   * 展开 = 220px，顶部一行「大纲 + 收起箭头」+ 大纲列表（复用 `Outline.vue`）；
//   * 折叠 = 34px 窄轨，只留一个展开箭头 —— 不用浮层把手，是为了「永远看得见、点得到」，
//     也不需要额外的指针热区逻辑。
// 折叠状态落在设置里（kv），重启后保持。
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import Outline from './Outline.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const settings = useSettingsStore()

function toggle(): void {
  settings.set('outlineRightExpanded', !settings.outlineRightExpanded)
}
</script>

<template>
  <aside
    data-outline-panel
    class="flex h-full flex-none flex-col border-l border-edge bg-app transition-[width] duration-200"
    :class="settings.outlineRightExpanded ? 'w-[220px]' : 'w-[34px]'"
  >
    <div
      class="flex flex-none items-center gap-1 border-b border-edge py-1.5"
      :class="settings.outlineRightExpanded ? 'justify-between pl-3 pr-1.5' : 'justify-center px-1'"
    >
      <span
        v-if="settings.outlineRightExpanded"
        class="truncate text-[12px] font-medium text-ink-3"
        >{{ t('sidebar.outline') }}</span
      >
      <button
        class="icon-btn !h-6.5 !w-6.5"
        data-outline-toggle
        :title="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-label="settings.outlineRightExpanded ? t('outline.collapse') : t('outline.expand')"
        :aria-expanded="settings.outlineRightExpanded"
        @click="toggle"
      >
        <Icon :name="settings.outlineRightExpanded ? 'chevron-right' : 'chevron-left'" :size="15" />
      </button>
    </div>

    <!-- 展开时才有列表；折叠态只留那条窄轨（`v-if` 而不是 v-show：
         折叠后列表没有意义，隐藏即可，也不必保留滚动位置） -->
    <div v-if="settings.outlineRightExpanded" class="min-h-0 flex-1 px-1.5 pt-1">
      <Outline />
    </div>
  </aside>
</template>
