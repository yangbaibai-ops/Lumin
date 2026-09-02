<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useExport } from '../composables/useExport'
import Icon from './Icon.vue'

// ─── 编辑器工具栏：命令通过 editor store 桥接 Tiptap 内核（解耦）────────────
const ui = useUiStore()
const files = useFilesStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
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

function toggleSidebar(): void {
  ui.sidebarVisible = !ui.sidebarVisible
  settings.set('sidebarVisible', ui.sidebarVisible)
}

function doExport(format: 'pdf' | 'html' | 'word' | 'epub'): void {
  exportOpen.value = false
  void runExport(format)
}

/** 工具栏激活态（依赖 editor store 的 tick 驱动重渲染） */
function isActive(name: string, attrs?: Record<string, unknown>): boolean {
  void editorStore.tick
  const ed = editorStore.instance
  if (!ed) return false
  try {
    return ed.isActive(name, attrs)
  } catch {
    return false
  }
}

function canUndo(): boolean {
  void editorStore.tick
  return editorStore.instance?.can().undo() ?? false
}
function canRedo(): boolean {
  void editorStore.tick
  return editorStore.instance?.can().redo() ?? false
}

function runInline(cmd: 'bold' | 'italic' | 'underline' | 'strike' | 'code'): void {
  const ed = editorStore.instance
  if (!ed) return
  const chain = ed.chain().focus()
  if (cmd === 'bold') chain.toggleBold().run()
  else if (cmd === 'italic') chain.toggleItalic().run()
  else if (cmd === 'underline') chain.toggleUnderline().run()
  else if (cmd === 'strike') chain.toggleStrike().run()
  else chain.toggleCode().run()
}

function toggleHeading(level: 1 | 2 | 3): void {
  editorStore.instance?.chain().focus().toggleHeading({ level }).run()
}

function runBlock(cmd: 'quote' | 'ul' | 'ol' | 'task' | 'codeBlock'): void {
  const ed = editorStore.instance
  if (!ed) return
  const chain = ed.chain().focus()
  if (cmd === 'quote') chain.toggleBlockquote().run()
  else if (cmd === 'ul') chain.toggleBulletList().run()
  else if (cmd === 'ol') chain.toggleOrderedList().run()
  else if (cmd === 'task') chain.toggleTaskList().run()
  else chain.toggleCodeBlock().run()
}

function insertTable(): void {
  editorStore.instance
    ?.chain()
    .focus()
    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    .run()
}

function insertHr(): void {
  editorStore.instance?.chain().focus().setHorizontalRule().run()
}

function addLink(): void {
  const ed = editorStore.instance
  if (!ed) return
  void ui.prompt('插入链接', 'https://example.com').then((href) => {
    if (href === null) return
    if (href.trim() === '') {
      ed.chain().focus().unsetLink().run()
      return
    }
    ed.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
  })
}

function addImage(): void {
  const ed = editorStore.instance
  if (!ed) return
  void ui.prompt('插入图片', '图片地址 / 相对路径').then((src) => {
    if (!src) return
    ed.chain().focus().setImage({ src: src.trim() }).run()
  })
}

const inlineButtons: { icon: string; cmd: 'bold' | 'italic' | 'underline' | 'strike' | 'code'; name: string; title: string }[] = [
  { icon: 'bold', cmd: 'bold', name: 'bold', title: '加粗' },
  { icon: 'italic', cmd: 'italic', name: 'italic', title: '斜体' },
  { icon: 'underline', cmd: 'underline', name: 'underline', title: '下划线' },
  { icon: 'strike', cmd: 'strike', name: 'strike', title: '删除线' },
  { icon: 'code', cmd: 'code', name: 'code', title: '行内代码' }
]
const blockButtons: { icon: string; cmd: 'quote' | 'ul' | 'ol' | 'task' | 'codeBlock'; name: string; title: string }[] = [
  { icon: 'quote', cmd: 'quote', name: 'blockquote', title: '引用' },
  { icon: 'list', cmd: 'ul', name: 'bulletList', title: '无序列表' },
  { icon: 'list-ordered', cmd: 'ol', name: 'orderedList', title: '有序列表' },
  { icon: 'list-checks', cmd: 'task', name: 'taskList', title: '任务列表' },
  { icon: 'braces', cmd: 'codeBlock', name: 'codeBlock', title: '代码块' }
]

const exportItems: { icon: string; label: string; format: 'pdf' | 'html' | 'word' | 'epub' }[] = [
  { icon: 'file', label: '导出为 PDF', format: 'pdf' },
  { icon: 'code', label: '导出为 HTML', format: 'html' },
  { icon: 'file', label: '导出为 Word', format: 'word' },
  { icon: 'book', label: '导出为 EPUB', format: 'epub' }
]

const docName = computed(() => files.current?.name ?? '')
</script>

<template>
  <div
    class="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge bg-panel/80 px-3 backdrop-blur-md"
    @mousedown.prevent
  >
    <!-- 侧边栏开关 -->
    <button class="icon-btn" :title="'切换侧边栏 (Ctrl+Shift+B)'" @click="toggleSidebar">
      <Icon name="panel-left" :size="16" />
    </button>

    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

    <!-- 撤销 / 重做 -->
    <button class="icon-btn" :class="{ 'opacity-40': !canUndo() }" title="撤销" @click="editorStore.instance?.chain().focus().undo().run()">
      <Icon name="undo" :size="15" />
    </button>
    <button class="icon-btn" :class="{ 'opacity-40': !canRedo() }" title="重做" @click="editorStore.instance?.chain().focus().redo().run()">
      <Icon name="redo" :size="15" />
    </button>

    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

    <!-- 行内格式 -->
    <button
      v-for="b in inlineButtons"
      :key="b.cmd"
      class="icon-btn"
      :class="{ active: isActive(b.name) }"
      :title="b.title"
      @click="runInline(b.cmd)"
    >
      <Icon :name="b.icon" :size="15" />
    </button>

    <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />

    <!-- 标题 -->
    <button
      v-for="l in [1, 2, 3]"
      :key="'h' + l"
      class="icon-btn"
      :class="{ active: isActive('heading', { level: l }) }"
      :title="'标题 ' + l"
      @click="toggleHeading(l)"
    >
      <Icon name="heading" :size="15" />
      <span class="ml-0.5 text-[10px] font-bold">{{ l }}</span>
    </button>

    <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />

    <!-- 块级 -->
    <button
      v-for="b in blockButtons"
      :key="b.cmd"
      class="icon-btn"
      :class="{ active: isActive(b.name) }"
      :title="b.title"
      @click="runBlock(b.cmd)"
    >
      <Icon :name="b.icon" :size="15" />
    </button>

    <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />

    <!-- 插入 -->
    <button class="icon-btn" title="表格" @click="insertTable">
      <Icon name="table" :size="15" />
    </button>
    <button class="icon-btn" title="分割线" @click="insertHr">
      <Icon name="hr" :size="15" />
    </button>
    <button class="icon-btn" title="链接" @click="addLink">
      <Icon name="link" :size="15" />
    </button>
    <button class="icon-btn" title="图片" @click="addImage">
      <Icon name="image" :size="15" />
    </button>

    <div class="min-w-2 flex-1" />

    <!-- 文档信息 -->
    <div class="hidden items-center gap-2 xl:flex">
      <Icon name="file" :size="13" class="text-ink-3" />
      <span class="max-w-[180px] truncate text-[12.5px] text-ink-2">{{ docName }}</span>
      <span v-if="files.dirty" class="h-1.5 w-1.5 rounded-full" :class="files.saving ? 'bg-warning' : 'bg-accent'" />
    </div>

    <button
      class="icon-btn"
      :class="{ active: ui.focusMode }"
      :title="'专注模式 (Ctrl+Shift+F)'"
      @click="ui.focusMode = !ui.focusMode"
    >
      <Icon name="maximize" :size="15" />
    </button>

    <div class="mx-1 h-5 w-px shrink-0 bg-edge" />

    <!-- 导出 -->
    <div ref="exportRef" class="relative shrink-0">
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
  </div>
</template>
