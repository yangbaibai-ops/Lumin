<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import Toolbar from '../components/Toolbar.vue'
import StatusBar from '../components/StatusBar.vue'
import TyporaEditor from '../components/editor/TyporaEditor.vue'
import Icon from '../components/Icon.vue'

// ─── 编辑器页面：工具栏 + 实时渲染/分屏对比/源码三模式 + 状态栏 ────────────
const files = useFilesStore()
const ui = useUiStore()
const editorStore = useEditorStore()
const settings = useSettingsStore()

function onEditorUpdate(md: string): void {
  files.setContent(md)
}

// ─── 源码面板（textarea 原始 Markdown，绝不渲染样式）──
const sourceRef = ref<HTMLTextAreaElement | null>(null)

function onSourceInput(e: Event): void {
  files.setContent((e.target as HTMLTextAreaElement).value)
}

/** 源码模式 Tab 插入两个空格（textarea 默认 Tab 会移出焦点，写作语义不符） */
function onSourceTab(e: KeyboardEvent): void {
  e.preventDefault()
  const ta = e.target as HTMLTextAreaElement
  const { selectionStart, selectionEnd, value } = ta
  ta.value = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
  ta.selectionStart = ta.selectionEnd = selectionStart + 2
  files.setContent(ta.value)
  scheduleSplitSync()
}

/** 源码模式光标位置 → 状态栏 */
function updateSourceCursor(ta: HTMLTextAreaElement): void {
  const before = ta.value.slice(0, ta.selectionStart ?? 0)
  const lines = before.split('\n')
  ui.cursor = { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

// ─── 分屏双向同步（IDEA 式对比）──
// 左（实时渲染）→ 右（源码）：TyporaEditor 防抖序列化 → files store →
//   textarea :value 自动刷新（已有管道，零新增代码）。
// 右（源码）→ 左（实时渲染）：输入即写 files store（持久化管道），并防抖
//   200ms 直接 setContent 进左侧 Tiptap——不依赖 modelValue watch（其静默窗
//   会吞掉距上次渲染端 emit 600ms 内的外部更新），保证对比实时且不回路
//   （setContent 带 emitUpdate:false，不触发 onUpdate 回声）。
let splitSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSplitSync(): void {
  if (ui.editorMode !== 'split') return
  clearTimeout(splitSyncTimer as never)
  splitSyncTimer = setTimeout(() => {
    splitSyncTimer = null
    const ed = editorStore.instance
    if (!ed) return
    ed.commands.setContent(files.current?.content ?? '', { emitUpdate: false })
  }, 200)
}

function onSplitSourceInput(e: Event): void {
  onSourceInput(e)
  scheduleSplitSync()
}

// ── 分屏分隔条拖拽（比例 0.25~0.75，SQLite kv 持久化）──
const splitHostRef = ref<HTMLElement | null>(null)
const splitRatio = ref<number>(settings.splitRatio)
const splitDragging = ref(false)

function clampRatio(v: number): number {
  return Math.min(0.75, Math.max(0.25, v))
}

function startSplitDrag(e: MouseEvent): void {
  e.preventDefault()
  const host = splitHostRef.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  splitDragging.value = true
  const move = (ev: MouseEvent): void => {
    splitRatio.value = clampRatio((ev.clientX - rect.left) / rect.width)
  }
  const up = (): void => {
    splitDragging.value = false
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    // 拖拽结束才持久化（拖拽过程高频写 kv 无意义）
    settings.set('splitRatio', splitRatio.value)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// ─── 分屏同步滚动 ───
// scroll 事件不冒泡但可捕获：在分屏容器挂 capture 监听，左右任意一栏滚动
// （含左侧代码块的 CodeMirror 内部滚动）都按「滚动进度比」映射到另一栏。
// 写入 target.scrollTop 后浏览器会回发一次 scroll 事件：busy 旗标 + 比值
// 收敛（同值赋值不再触发 scroll）保证不振荡、无回声回路。
let splitScrollBusy = false
function onSplitScroll(e: Event): void {
  if (!settings.syncScroll || splitScrollBusy) return
  const host = splitHostRef.value
  if (!host) return
  const t = e.target as HTMLElement
  const leftScroll = host.querySelector<HTMLElement>('.editor-scroll')
  const rightScroll = host.querySelector<HTMLElement>('textarea.source-editor')
  const source = t === leftScroll || leftScroll?.contains(t) ? leftScroll : t === rightScroll ? rightScroll : null
  if (!source || !leftScroll || !rightScroll) return
  const target = source === leftScroll ? rightScroll : leftScroll
  const srcRange = source.scrollHeight - source.clientHeight
  if (srcRange <= 0) return
  const ratio = Math.min(1, Math.max(0, source.scrollTop / srcRange))
  splitScrollBusy = true
  target.scrollTop = ratio * Math.max(0, target.scrollHeight - target.clientHeight)
  requestAnimationFrame(() => {
    splitScrollBusy = false
  })
}

function toggleSyncScroll(): void {
  settings.set('syncScroll', !settings.syncScroll)
}

// 模式切换后把焦点还给对应视图（v-if 重建的编辑器需要等实例绑定）
watch(
  () => ui.editorMode,
  async (mode) => {
    await nextTick()
    if (mode === 'source') {
      sourceRef.value?.focus()
    } else if (mode === 'split') {
      editorStore.instance?.commands.focus('end')
    } else {
      if (!editorStore.instance) {
        setTimeout(() => editorStore.instance?.commands.focus('end'), 50)
      } else {
        editorStore.instance.commands.focus('end')
      }
    }
  }
)

// 外部文件拖放打开（文件系统逻辑，与内核无关）
async function onDrop(e: DragEvent): Promise<void> {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const path = window.luminAPI.file.getPathForFile(file)
  if (!path) return
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) {
    ui.toast('仅支持打开 Markdown 文件', 'error')
    return
  }
  if (files.dirty) {
    const ok = await ui.confirm({
      title: '有未保存的更改',
      body: '当前文档有未保存的更改，确定要打开其他文件吗？',
      danger: true
    })
    if (!ok) return
  }
  await files.openPath(path)
}
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

onMounted(() => {
  if (!files.current) void files.openUntitled()
})
onBeforeUnmount(() => {
  clearTimeout(splitSyncTimer as never)
  void files.flushAll()
})
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col"
    :class="{ 'split-dragging': splitDragging }"
    @drop.prevent="onDrop"
    @dragover="onDragOver"
  >
    <Toolbar />

    <!-- 草稿恢复横幅（文件状态逻辑，与内核无关） -->
    <Transition name="slide">
      <div
        v-if="files.draftRestore"
        class="restore-bar mx-4 mt-3 flex items-center gap-3 px-4 py-2.5 text-[13px]"
      >
        <span class="flex-1">检测到未保存的草稿（比磁盘文件更新）</span>
        <button class="btn btn-primary !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(true)">
          恢复
        </button>
        <button class="btn btn-ghost !px-3 !py-1 text-[12px]" @click="files.applyDraftRestore(false)">
          丢弃
        </button>
      </div>
    </Transition>

    <!-- 编辑器内核（按文件重建，避免撤销历史/光标残留） -->
    <div class="relative min-h-0 flex-1">
      <!-- 分屏对比：左实时渲染 + 右源码，拖拽分隔条调比例，双向实时同步 -->
      <div
        v-if="ui.editorMode === 'split'"
        ref="splitHostRef"
        class="relative flex h-full min-h-0"
        @scroll.capture="onSplitScroll"
      >
        <div class="h-full min-w-0" :style="{ width: (splitRatio * 100).toFixed(2) + '%' }">
          <TyporaEditor
            :key="files.current?.path ?? 'untitled'"
            :model-value="files.current?.content ?? ''"
            @update:model-value="onEditorUpdate"
          />
        </div>
        <div
          class="split-divider"
          :class="{ dragging: splitDragging }"
          title="拖动调整左右比例（双击复位）"
          @mousedown="startSplitDrag"
          @dblclick="splitRatio = clampRatio(0.5); settings.set('splitRatio', splitRatio)"
        >
          <span />
        </div>
        <div class="h-full min-w-0 flex-1 overflow-hidden">
          <textarea
            class="source-editor source-editor--split"
            :value="files.current?.content ?? ''"
            spellcheck="false"
            @input="onSplitSourceInput"
            @keydown.tab="onSourceTab"
            @click="updateSourceCursor($event.target as HTMLTextAreaElement)"
            @keyup="updateSourceCursor($event.target as HTMLTextAreaElement)"
            @select="updateSourceCursor($event.target as HTMLTextAreaElement)"
          />
        </div>

        <!-- 同步滚动开关（分屏专属悬浮芯片，SQLite kv 持久化） -->
        <button
          class="split-sync-chip"
          :class="{ active: settings.syncScroll }"
          :title="settings.syncScroll ? '同步滚动已开启（点击关闭）' : '开启同步滚动'"
          @click="toggleSyncScroll"
        >
          <Icon name="sync-scroll" :size="13" />
          <span>同步滚动</span>
          <span v-if="settings.syncScroll" class="split-sync-dot" />
        </button>
      </div>

      <!-- 实时渲染：Tiptap WYSIWYG -->
      <TyporaEditor
        v-else-if="ui.editorMode === 'wysiwyg'"
        :key="files.current?.path ?? 'untitled'"
        :model-value="files.current?.content ?? ''"
        @update:model-value="onEditorUpdate"
      />

      <!-- 源码模式：纯文本 Markdown（无任何渲染样式） -->
      <div v-else class="editor-scroll h-full overflow-y-auto">
        <div
          class="mx-auto h-full transition-all duration-300"
          :class="ui.focusMode ? 'max-w-[1140px]' : 'max-w-[1320px]'"
        >
          <textarea
            ref="sourceRef"
            class="source-editor"
            :value="files.current?.content ?? ''"
            spellcheck="false"
            @input="onSourceInput"
            @keydown.tab="onSourceTab"
            @click="updateSourceCursor($event.target as HTMLTextAreaElement)"
            @keyup="updateSourceCursor($event.target as HTMLTextAreaElement)"
            @select="updateSourceCursor($event.target as HTMLTextAreaElement)"
          />
        </div>
      </div>
    </div>

    <StatusBar />
  </div>
</template>
