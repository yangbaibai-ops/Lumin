<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import FileTree from './FileTree.vue'
import Outline from './Outline.vue'
import Icon from './Icon.vue'

const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

const workspaceName = computed(() => files.root?.split(/[\\/]/).filter(Boolean).pop() || '')

// ── 拖拽调整宽度 ──
const dragging = ref(false)
const width = computed({
  get: () => settings.sidebarWidth,
  set: (v) => settings.set('sidebarWidth', Math.max(200, Math.min(420, v)))
})

function onDragStart(e: MouseEvent): void {
  dragging.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const move = (ev: MouseEvent): void => {
    width.value = ev.clientX
  }
  const up = (): void => {
    dragging.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  e.preventDefault()
}
</script>

<template>
  <aside
    class="relative z-10 flex h-full flex-none flex-col border-r border-edge bg-panel/70 backdrop-blur-md"
    :style="{ width: width + 'px', transition: dragging ? 'none' : 'width .28s cubic-bezier(.4,0,.2,1)' }"
    :class="ui.focusMode ? 'opacity-40 saturate-50' : ''"
  >
    <!-- 头部 -->
    <div class="flex h-11 flex-none items-center gap-2 border-b border-edge px-3">
      <div class="flex items-center gap-2">
        <span class="text-[13.5px] font-semibold tracking-wide text-ink">Lumin</span>
      </div>
      <div class="flex-1" />
      <button class="icon-btn !h-6.5 !w-6.5" title="新建文件" @click="files.newDocInWorkspace()">
        <Icon name="file-plus" :size="14" />
      </button>
      <button class="icon-btn !h-6.5 !w-6.5" title="打开文件夹" @click="files.openFolder()">
        <Icon name="folder-plus" :size="14" />
      </button>
    </div>

    <!-- 工作区名 -->
    <div v-if="files.root" class="flex flex-none items-center gap-1.5 px-3 pb-0.5 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
      <Icon name="folder" :size="11" />
      <span class="max-w-[150px] truncate" :title="files.root">{{ workspaceName }}</span>
      <div class="flex-1" />
      <button class="text-ink-3 transition-colors hover:text-ink" title="刷新" @click="files.refreshDir(files.root!)">
        <Icon name="refresh" :size="11" />
      </button>
    </div>

    <!-- 标签页 -->
    <div class="flex flex-none gap-1 px-2.5 pt-2">
      <button
        v-for="tab in (['files', 'outline'] as const)"
        :key="tab"
        class="relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12.5px] font-medium transition-all duration-200"
        :class="ui.sidebarTab === tab ? 'text-ink' : 'text-ink-3 hover:text-ink-2'"
        @click="ui.sidebarTab = tab"
      >
        <Icon :name="tab === 'files' ? 'file' : 'list'" :size="13" />
        {{ tab === 'files' ? '文件' : '大纲' }}
        <span
          v-if="ui.sidebarTab === tab"
          class="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-gradient-to-r from-accent to-accent-2"
          style="animation: lm-fade-in 0.25s ease"
        />
      </button>
    </div>

    <!-- 内容 -->
    <div class="mt-1.5 min-h-0 flex-1">
      <Transition name="fade" mode="out-in">
        <FileTree v-if="ui.sidebarTab === 'files'" key="files" />
        <Outline v-else key="outline" />
      </Transition>
    </div>

    <!-- 底部 -->
    <div class="flex flex-none items-center gap-0.5 border-t border-edge px-2 py-1.5">
      <button
        class="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
        @click="ui.openSettings()"
      >
        <Icon name="settings" :size="13" />
        设置
      </button>
      <button
        class="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
        @click="router.push('/about')"
      >
        <Icon name="info" :size="13" />
        关于
      </button>
      <button
        class="icon-btn !h-6.5 !w-6.5"
        title="收起侧边栏 (Ctrl+Shift+B)"
        @click="
          () => {
            ui.sidebarVisible = false
            settings.set('sidebarVisible', false)
          }
        "
      >
        <Icon name="panel-left" :size="14" />
      </button>
    </div>

    <!-- 拖拽手柄 -->
    <div
      class="absolute -right-[3px] top-0 z-20 h-full w-[5px] cursor-col-resize opacity-0 transition-opacity hover:opacity-100"
      :class="dragging ? 'opacity-100' : ''"
      @mousedown="onDragStart"
    >
      <div class="mx-auto h-full w-px transition-colors" :class="dragging ? 'bg-accent' : 'bg-transparent'" />
    </div>
  </aside>
</template>
