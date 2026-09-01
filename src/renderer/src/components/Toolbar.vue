<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useExport } from '../composables/useExport'
import Icon from './Icon.vue'

const ui = useUiStore()
const files = useFilesStore()
const settings = useSettingsStore()
const router = useRouter()
const { runExport } = useExport()

const exportOpen = ref(false)
const exportRef = ref<HTMLElement | null>(null)

function onDocClick(e: MouseEvent): void {
  if (exportOpen.value && exportRef.value && !exportRef.value.contains(e.target as Node)) {
    exportOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))

function fmt(action: Parameters<typeof ui.sendFormat>[0]): void {
  ui.sendFormat(action)
}

function toggleSidebar(): void {
  ui.sidebarVisible = !ui.sidebarVisible
  settings.set('sidebarVisible', ui.sidebarVisible)
}

function setMode(mode: 'wysiwyg' | 'source'): void {
  ui.editorMode = mode
  settings.set('editorMode', mode)
}

function doExport(format: 'pdf' | 'html' | 'word' | 'epub'): void {
  exportOpen.value = false
  void runExport(format)
}

const inlineButtons: { icon: string; action: string; title: string }[] = [
  { icon: 'bold', action: 'bold', title: '加粗' },
  { icon: 'italic', action: 'italic', title: '斜体' },
  { icon: 'strike', action: 'strike', title: '删除线' },
  { icon: 'code', action: 'inlineCode', title: '行内代码' }
]
const blockButtons: { icon: string; action: string; title: string }[] = [
  { icon: 'heading', action: 'heading', title: '标题' },
  { icon: 'quote', action: 'quote', title: '引用' },
  { icon: 'list', action: 'ul', title: '无序列表' },
  { icon: 'list-ordered', action: 'ol', title: '有序列表' },
  { icon: 'list-checks', action: 'task', title: '任务列表' },
  { icon: 'braces', action: 'codeBlock', title: '代码块' }
]
const insertButtons: { icon: string; action: string; title: string }[] = [
  { icon: 'link', action: 'link', title: '链接' },
  { icon: 'image', action: 'image', title: '图片' },
  { icon: 'table', action: 'table', title: '表格' },
  { icon: 'hr', action: 'hr', title: '分割线' },
  { icon: 'sigma', action: 'math', title: '公式' }
]

const exportItems: { icon: string; label: string; format: 'pdf' | 'html' | 'word' | 'epub' }[] = [
  { icon: 'file', label: '导出为 PDF', format: 'pdf' },
  { icon: 'code', label: '导出为 HTML', format: 'html' },
  { icon: 'file', label: '导出为 Word', format: 'word' },
  { icon: 'book', label: '导出为 EPUB', format: 'epub' }
]
</script>

<template>
  <div
    class="flex h-11 shrink-0 items-center gap-0.5 border-b border-edge bg-panel/80 px-3 backdrop-blur-md"
    @mousedown.prevent
  >
    <!-- 侧边栏开关 -->
    <button class="icon-btn" :title="'切换侧边栏 (Ctrl+Shift+B)'" @click="toggleSidebar">
      <Icon name="panel-left" :size="16" />
    </button>

    <div class="mx-1.5 h-5 w-px bg-edge" />

    <!-- 模式切换 -->
    <div class="flex items-center rounded-lg bg-panel-2 p-0.5">
      <button
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-all duration-200"
        :class="ui.editorMode === 'wysiwyg' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'"
        @click="setMode('wysiwyg')"
      >
        <Icon name="eye" :size="13" />
        实时渲染
      </button>
      <button
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-all duration-200"
        :class="ui.editorMode === 'source' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'"
        @click="setMode('source')"
      >
        <Icon name="source" :size="13" />
        源码
      </button>
    </div>

    <div class="mx-1.5 h-5 w-px bg-edge" />

    <!-- 格式按钮组 -->
    <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      <button v-for="b in inlineButtons" :key="b.action" class="icon-btn" :title="b.title" @click="fmt(b.action as never)">
        <Icon :name="b.icon" :size="15" />
      </button>
      <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />
      <button v-for="b in blockButtons" :key="b.action" class="icon-btn" :title="b.title" @click="fmt(b.action as never)">
        <Icon :name="b.icon" :size="15" />
      </button>
      <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />
      <button v-for="b in insertButtons" :key="b.action" class="icon-btn" :title="b.title" @click="fmt(b.action as never)">
        <Icon :name="b.icon" :size="15" />
      </button>
    </div>

    <div class="min-w-2 flex-1" />

    <!-- 右侧操作 -->
    <button
      class="icon-btn"
      :class="{ active: ui.focusMode }"
      :title="'专注模式 (Ctrl+Shift+F)'"
      @click="ui.focusMode = !ui.focusMode"
    >
      <Icon name="maximize" :size="15" />
    </button>
    <button
      class="icon-btn"
      :class="{ active: ui.typewriterMode }"
      :title="'打字机模式 (Ctrl+Shift+T)'"
      @click="ui.typewriterMode = !ui.typewriterMode"
    >
      <Icon name="align-center" :size="15" />
    </button>

    <div class="mx-1.5 h-5 w-px bg-edge" />

    <!-- 导出 -->
    <div ref="exportRef" class="relative">
      <button class="icon-btn" :class="{ active: exportOpen }" title="导出" @click="exportOpen = !exportOpen">
        <Icon name="download" :size="15" />
      </button>
      <Transition name="pop">
        <div
          v-if="exportOpen"
          class="absolute right-0 top-9 z-50 w-[190px] rounded-xl border border-edge bg-elevate p-1.5 shadow-xl"
          :style="{ boxShadow: 'var(--shadow-2)' }"
        >
          <button
            v-for="item in exportItems"
            :key="item.format"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-panel-2"
            @click="doExport(item.format)"
          >
            <Icon :name="item.icon" :size="14" class="text-ink-3" />
            {{ item.label }}
          </button>
        </div>
      </Transition>
    </div>

    <button class="icon-btn" title="设置" @click="router.push('/settings')">
      <Icon name="settings" :size="15" />
    </button>

    <!-- 文档信息 -->
    <div v-if="files.current" class="ml-2 hidden items-center gap-2 xl:flex">
      <div class="h-4 w-px bg-edge" />
      <Icon name="file" :size="13" class="text-ink-3" />
      <span class="max-w-[200px] truncate text-[12.5px] text-ink-2">{{ files.current.name }}</span>
      <span
        v-if="files.dirty"
        class="h-1.5 w-1.5 rounded-full"
        :class="files.saving ? 'bg-warning' : 'bg-accent'"
      />
    </div>
  </div>
</template>
