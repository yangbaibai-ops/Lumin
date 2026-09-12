<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import Icon from './Icon.vue'
import ToolbarTableButton from './ToolbarTableButton.vue'
import ToolbarCodeBlockButton from './ToolbarCodeBlockButton.vue'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'

// ─── 编辑器工具栏：命令通过 editor store 桥接 Tiptap 内核（解耦）────────────
const { t } = useI18n()
const ui = useUiStore()
const files = useFilesStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport } = useExport()
const { setMode } = useEditorMode()
const modeOptions: { mode: 'wysiwyg' | 'source' | 'split'; icon: string; labelKey: string; titleKey: string }[] = [
  { mode: 'wysiwyg', icon: 'eye', labelKey: 'editor.wysiwyg', titleKey: 'editor.wysiwyg' },
  { mode: 'split', icon: 'columns', labelKey: 'editor.split', titleKey: 'editor.split' },
  { mode: 'source', icon: 'source', labelKey: 'editor.source', titleKey: 'editor.source' }
]

const exportOpen = ref(false)
const exportRef = ref<HTMLElement | null>(null)
const exportPos = ref({ x: 0, y: 0 })

function toggleExport(): void {
  if (!exportOpen.value) {
    const rect = exportRef.value?.getBoundingClientRect()
    if (rect) {
      exportPos.value = { x: Math.max(8, rect.right - 190), y: rect.bottom + 8 }
    }
  }
  exportOpen.value = !exportOpen.value
}

function onDocClick(e: MouseEvent): void {
  if (exportOpen.value && exportRef.value && !exportRef.value.contains(e.target as Node)) {
    const panel = (e.target as HTMLElement).closest?.('.fixed.z-\\[100\\]')
    if (!panel) exportOpen.value = false
  }
}
/** 滚动/缩放收起导出菜单：菜单内部滚动不收起（见 lib/popoverClose.ts） */
function onWindowScrollOrResize(e: Event): void {
  if (!exportOpen.value) return
  const panel = document.querySelector<HTMLElement>('.export-pop')
  if (!shouldCloseOnScrollOrResize(e, panel)) return
  exportOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('scroll', onWindowScrollOrResize, true)
  window.addEventListener('resize', onWindowScrollOrResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('scroll', onWindowScrollOrResize, true)
  window.removeEventListener('resize', onWindowScrollOrResize)
})

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
  if (cmd === 'bold') chain.toggleMdBold().run()
  else if (cmd === 'italic') chain.toggleMdItalic().run()
  else if (cmd === 'underline') chain.toggleUnderline().run()
  else if (cmd === 'strike') chain.toggleMdStrike().run()
  else chain.toggleMdCode().run()
}

/** 行内样式激活态（真实文本标记模型：mdStyle mark） */
function isMdActive(cmd: 'bold' | 'italic' | 'underline' | 'strike' | 'code'): boolean {
  void editorStore.tick
  const ed = editorStore.instance
  if (!ed) return false
  if (cmd === 'underline') return ed.isActive('underline')
  const kind = cmd === 'bold' ? 'bold' : cmd === 'italic' ? 'italic' : cmd === 'strike' ? 'strike' : 'code'
  try {
    return ed.isActive('mdStyle', { style: kind })
  } catch {
    return false
  }
}

function toggleHeading(level: 1 | 2 | 3): void {
  editorStore.instance?.chain().focus().toggleHeading({ level }).run()
}

function runBlock(cmd: 'quote' | 'ul' | 'ol' | 'task'): void {
  const ed = editorStore.instance
  if (!ed) return
  const chain = ed.chain().focus()
  if (cmd === 'quote') chain.toggleBlockquote().run()
  else if (cmd === 'ul') chain.toggleBulletList().run()
  else if (cmd === 'ol') chain.toggleOrderedList().run()
  else chain.toggleTaskList().run()
}

function insertHr(): void {
  editorStore.instance?.chain().focus().setHorizontalRule().run()
}

/** 在光标处插入文档目录 */
function insertToc(): void {
  const ed = editorStore.instance
  if (!ed) return
  // 光标在段落中间时先落到块首，再插入独立的目录块
  ed.chain().focus().insertTableOfContents().run()
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

const inlineButtons: { icon: string; cmd: 'bold' | 'italic' | 'underline' | 'strike' | 'code'; name: string; titleKey: string }[] = [
  { icon: 'bold', cmd: 'bold', name: 'bold', titleKey: 'editor.bold' },
  { icon: 'italic', cmd: 'italic', name: 'italic', titleKey: 'editor.italic' },
  { icon: 'underline', cmd: 'underline', name: 'underline', titleKey: 'editor.underline' },
  { icon: 'strike', cmd: 'strike', name: 'strike', titleKey: 'editor.strike' },
  { icon: 'code', cmd: 'code', name: 'code', titleKey: 'editor.inlineCode' }
]
const blockButtons: { icon: string; cmd: 'quote' | 'ul' | 'ol' | 'task'; name: string; titleKey: string }[] = [
  { icon: 'quote', cmd: 'quote', name: 'blockquote', titleKey: 'editor.quote' },
  { icon: 'list', cmd: 'ul', name: 'bulletList', titleKey: 'editor.ul' },
  { icon: 'list-ordered', cmd: 'ol', name: 'orderedList', titleKey: 'editor.ol' },
  { icon: 'list-checks', cmd: 'task', name: 'taskList', titleKey: 'editor.task' }
]

const exportItems: { icon: string; labelKey: string; format: 'pdf' | 'html' | 'word' | 'epub' }[] = [
  { icon: 'file', labelKey: 'editor.exportPdf', format: 'pdf' },
  { icon: 'code', labelKey: 'editor.exportHtml', format: 'html' },
  { icon: 'file', labelKey: 'editor.exportWord', format: 'word' },
  { icon: 'book', labelKey: 'editor.exportEpub', format: 'epub' }
]

const docName = computed(() => files.current?.name ?? '')
</script>

<template>
  <div
    class="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge bg-panel/80 px-3 backdrop-blur-md"
    @mousedown.prevent
  >
    <!-- 侧边栏开关 -->
    <button class="icon-btn" :title="t('menu.toggleSidebar') + ' (Ctrl+Shift+B)'" @click="toggleSidebar">
      <Icon name="panel-left" :size="16" />
    </button>

    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

    <!-- 撤销 / 重做 -->
    <button class="icon-btn" :class="{ 'opacity-40': !canUndo() }" :title="t('editor.undo')" @click="editorStore.instance?.chain().focus().undo().run()">
      <Icon name="undo" :size="15" />
    </button>
    <button class="icon-btn" :class="{ 'opacity-40': !canRedo() }" :title="t('editor.redo')" @click="editorStore.instance?.chain().focus().redo().run()">
      <Icon name="redo" :size="15" />
    </button>

    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

    <!-- 行内格式 -->
    <button
      v-for="b in inlineButtons"
      :key="b.cmd"
      class="icon-btn"
      :class="{ active: isMdActive(b.cmd) }"
      :title="t(b.titleKey)"
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
      :title="t('editor.heading') + ' ' + l"
      @click="toggleHeading(l)"
    >
      <Icon name="heading" :size="15" />
      <span class="ml-0.5 text-[10px] font-bold">{{ l }}</span>
    </button>

    <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />

    <!-- 块级（代码块按钮自带「行号」悬停弹层，见 ToolbarCodeBlockButton） -->
    <button
      v-for="b in blockButtons"
      :key="b.cmd"
      class="icon-btn"
      :class="{ active: isActive(b.name) }"
      :title="t(b.titleKey)"
      @click="runBlock(b.cmd)"
    >
      <Icon :name="b.icon" :size="15" />
    </button>
    <ToolbarCodeBlockButton />

    <div class="mx-0.5 h-4 w-px shrink-0 bg-edge" />

    <!-- 插入 -->
    <ToolbarTableButton />
    <button class="icon-btn" :title="t('editor.hr')" @click="insertHr">
      <Icon name="hr" :size="15" />
    </button>
    <button class="icon-btn" :title="t('editor.link')" @click="addLink">
      <Icon name="link" :size="15" />
    </button>
    <button class="icon-btn" :title="t('editor.image')" @click="addImage">
      <Icon name="image" :size="15" />
    </button>
    <button class="icon-btn" :title="t('editor.toc')" @click="insertToc">
      <Icon name="list" :size="15" />
    </button>

    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

    <!-- 编辑器模式：实时渲染 / 分屏对比 / 源码。
         主控控件放左侧主功能区：右侧文档信息区在窄窗口会被
         overflow-x-auto 裁掉，模式切换必须永远可见 -->
    <div class="mode-seg" role="tablist" aria-label="编辑器模式">
      <button
        v-for="m in modeOptions"
        :key="m.mode"
        class="mode-seg-btn"
        :class="{ active: ui.editorMode === m.mode }"
        role="tab"
        :aria-selected="ui.editorMode === m.mode"
        :title="t(m.titleKey) + ' (Ctrl+/)'"
        @click="setMode(m.mode)"
      >
        <Icon :name="m.icon" :size="13.5" />
        <span>{{ t(m.labelKey) }}</span>
      </button>
    </div>

    <div class="min-w-2 flex-1" />

    <!-- 文档信息 -->
    <div class="hidden items-center gap-2 xl:flex">
      <Icon name="file" :size="13" class="text-ink-3" />
      <span class="max-w-[180px] truncate text-[12.5px] text-ink-2">{{ docName }}</span>
      <span v-if="files.dirty" class="h-1.5 w-1.5 rounded-full" :class="files.saving ? 'bg-warning' : 'bg-accent'" />
    </div>

    <!-- 专注模式 -->
    <button
      class="icon-btn"
      :class="{ active: ui.focusMode }"
      :title="t('editor.focus') + ' (Ctrl+Shift+F)'"
      @click="ui.focusMode = !ui.focusMode"
    >
      <Icon name="maximize" :size="15" />
    </button>

    <div class="mx-1 h-5 w-px shrink-0 bg-edge" />

    <!-- 导出 -->
    <div ref="exportRef" class="relative shrink-0">
      <button class="icon-btn" :class="{ active: exportOpen }" :title="t('editor.export')" @click="toggleExport">
        <Icon name="download" :size="15" />
      </button>
    </div>

    <button class="icon-btn" :title="t('settings.title')" @click="ui.openSettings()">
      <Icon name="settings" :size="15" />
    </button>

    <!-- 导出弹层：Teleport 到 body 固定定位。
         工具栏是 overflow-x-auto 滚动容器，普通 absolute 弹层会被裁剪
         （层级/裁切错乱），与表格选择器同款的 body 传送方案 -->
    <Teleport to="body">
      <Transition name="pop">
        <div
          v-if="exportOpen"
          class="export-pop fixed z-[100] w-[190px] rounded-xl border border-edge bg-elevate p-1.5"
          :style="{ boxShadow: 'var(--shadow-2)', left: exportPos.x + 'px', top: exportPos.y + 'px' }"
        >
          <button
            v-for="item in exportItems"
            :key="item.format"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-panel-2"
            @click="doExport(item.format)"
          >
            <Icon :name="item.icon" :size="14" class="text-ink-3" />
            {{ t(item.labelKey) }}
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
