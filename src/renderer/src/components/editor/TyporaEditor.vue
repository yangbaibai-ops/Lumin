<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import { editorExtensions } from '../../lib/editor/extensions'
import { getMarkdown } from '../../lib/editor/markdownStorage'
import { useEditorStore } from '../../stores/editor'
import { useUiStore } from '../../stores/ui'
import Icon from '../Icon.vue'

// ─── Typora 式所见即所得编辑器（开发文档「步骤 2」的高阶封装）────────────────
// - Tiptap(ProseMirror) AST 内核 + tiptap-markdown 双向转换
// - onUpdate 防抖序列化回 Markdown 源码（SQLite 持久化管道的源头）
// - 外部数据同步守卫：仅当 MD 不一致才 setContent，避免光标重置与死循环
// - 自绘选区浮动菜单（选中文本时弹出格式工具）
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const editorStore = useEditorStore()
const ui = useUiStore()

let syncTimer: ReturnType<typeof setTimeout> | null = null
// 卸载中标记：切换文件时旧实例销毁会触发 blur/destroy，
// 若不拦截，flushSync 会把旧文档内容回写覆盖新打开的文档（数据竞态）
let unmounting = false

function flushSync(ed: Editor): void {
  if (unmounting) return
  clearTimeout(syncTimer as never)
  syncTimer = null
  try {
    emit('update:modelValue', getMarkdown(ed))
  } catch {
    /* 序列化失败时保持上次状态 */
  }
}

function updateCursor(ed: Editor): void {
  const { $from } = ed.state.selection
  const before = ed.state.doc.textBetween(0, $from.pos, '\n', '\n')
  const line = before.split('\n').length
  ui.cursor = { line, col: $from.parentOffset + 1 }
}

const editor = useEditor({
  content: props.modelValue,
  extensions: editorExtensions,
  editorProps: {
    attributes: {
      class: 'md-preview',
      spellcheck: 'false'
    }
  },
  onUpdate: ({ editor: ed }) => {
    // 防抖 250ms：高频输入合并序列化（开发文档性能建议）
    clearTimeout(syncTimer as never)
    syncTimer = setTimeout(() => flushSync(ed), 250)
  },
  onBlur: ({ editor: ed }) => {
    flushSync(ed)
  },
  onCreate: ({ editor: ed }) => {
    editorStore.bind(ed)
    updateCursor(ed)
  },
  onSelectionUpdate: ({ editor: ed }) => {
    updateCursor(ed)
    updateBubbleMenu(ed)
  },
  onDestroy: () => {
    editorStore.unbind()
  }
})

// ── 外部数据同步守卫（文件切换 / 草稿恢复 / SQLite 回载）──
watch(
  () => props.modelValue,
  (nv) => {
    const ed = editor.value
    if (!ed) return
    try {
      const current = getMarkdown(ed)
      if (current !== nv) {
        ed.commands.setContent(nv, { emitUpdate: false })
      }
    } catch {
      /* 忽略序列化异常 */
    }
  }
)

// ── 大纲滚动联动 ──
let outlineTimer: ReturnType<typeof setTimeout> | null = null
function onScroll(e: Event): void {
  // 滚动时气泡跟随选区（coordsAtPos 为视口坐标，直接重算即可）
  const ed = editor.value
  if (ed) updateBubbleMenu(ed)
  if (outlineTimer) return
  outlineTimer = setTimeout(() => {
    outlineTimer = null
    const ed2 = editor.value
    if (!ed2) return
    const container = (e.target as HTMLElement).getBoundingClientRect().top
    let active = -1
    for (const item of editorStore.outline) {
      const top = ed2.view.coordsAtPos(item.pos).top
      if (top - container <= 90) active = item.pos
      else break
    }
    editorStore.activeHeading = active
  }, 80)
}

// 应用关闭前落盘最后一段输入（仅窗口级关闭触发，不参与文件切换流程）
function onWindowBeforeUnload(): void {
  if (unmounting) return
  const ed = editor.value
  if (ed) flushSync(ed)
}
window.addEventListener('beforeunload', onWindowBeforeUnload)

onBeforeUnmount(() => {
  unmounting = true
  clearTimeout(syncTimer as never)
  clearTimeout(outlineTimer as never)
  window.removeEventListener('beforeunload', onWindowBeforeUnload)
})

// ── 自绘选区浮动菜单 ──
const bubbleVisible = ref(false)
const bubblePos = ref({ top: 0, left: 0 })
// 气泡的绝对定位上下文：模板根节点 .typora-container（position:relative）
const containerRef = ref<HTMLElement | null>(null)

function updateBubbleMenu(ed: Editor): void {
  const { from, to, empty } = ed.state.selection
  if (empty) {
    bubbleVisible.value = false
    return
  }
  try {
    const start = ed.view.coordsAtPos(from)
    const end = ed.view.coordsAtPos(to)
    // 必须以气泡的定位上下文（.typora-container）为参考系计算，
    // 不能用 ed.view.dom（.ProseMirror）的 rect：两者之间隔着
    // editor-content 的 px-6/pt-10 内边距与滚动容器，会导致气泡
    // 向左上偏移且随滚动漂移
    const host = containerRef.value ?? ed.view.dom
    const hostRect = host.getBoundingClientRect()
    // 选区完全滚出可视区时隐藏气泡（coordsAtPos 返回视口外坐标）
    if (end.bottom < hostRect.top || start.top > hostRect.bottom) {
      bubbleVisible.value = false
      return
    }
    // 贴边钳制：选区部分可见时气泡留在容器可视范围内，绝不跑到窗口外
    const rawLeft = (start.left + end.right) / 2 - hostRect.left
    const left = Math.min(Math.max(rawLeft, 8), Math.max(hostRect.width - 8, 8))
    bubblePos.value = {
      top: Math.max(start.top - hostRect.top - 44, 8),
      left
    }
    bubbleVisible.value = true
  } catch {
    bubbleVisible.value = false
  }
}

const bubbleActive = computed(() => {
  void editorStore.tick
  const ed = editor.value
  if (!ed) return { bold: false, italic: false, underline: false, strike: false, code: false }
  return {
    bold: ed.isActive('bold'),
    italic: ed.isActive('italic'),
    underline: ed.isActive('underline'),
    strike: ed.isActive('strike'),
    code: ed.isActive('code')
  }
})

function runBubble(cmd: string): void {
  const ed = editor.value
  if (!ed) return
  switch (cmd) {
    case 'toggleBold':
      ed.chain().focus().toggleBold().run()
      break
    case 'toggleItalic':
      ed.chain().focus().toggleItalic().run()
      break
    case 'toggleUnderline':
      ed.chain().focus().toggleUnderline().run()
      break
    case 'toggleStrike':
      ed.chain().focus().toggleStrike().run()
      break
    case 'toggleCode':
      ed.chain().focus().toggleCode().run()
      break
  }
}

function addLink(): void {
  const ed = editor.value
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

function clearFormats(): void {
  editor.value?.chain().focus().clearNodes().unsetAllMarks().run()
}

defineExpose({ editor })
</script>

<template>
  <div ref="containerRef" class="typora-container relative h-full" :class="{ 'focus-mode': ui.focusMode }">
    <!-- 自绘选区浮动菜单 -->
    <Transition name="pop">
      <div
        v-if="bubbleVisible && editor"
        class="bubble-menu absolute z-50"
        :style="{ top: bubblePos.top + 'px', left: bubblePos.left + 'px', transform: 'translateX(-50%)' }"
        @mousedown.prevent
      >
        <button
          class="bubble-btn"
          :class="{ 'is-active': bubbleActive.bold }"
          title="加粗"
          @click="runBubble('toggleBold')"
        >
          <Icon name="bold" :size="14" />
        </button>
        <button
          class="bubble-btn"
          :class="{ 'is-active': bubbleActive.italic }"
          title="斜体"
          @click="runBubble('toggleItalic')"
        >
          <Icon name="italic" :size="14" />
        </button>
        <button
          class="bubble-btn"
          :class="{ 'is-active': bubbleActive.underline }"
          title="下划线"
          @click="runBubble('toggleUnderline')"
        >
          <Icon name="underline" :size="14" />
        </button>
        <button
          class="bubble-btn"
          :class="{ 'is-active': bubbleActive.strike }"
          title="删除线"
          @click="runBubble('toggleStrike')"
        >
          <Icon name="strike" :size="14" />
        </button>
        <button
          class="bubble-btn"
          :class="{ 'is-active': bubbleActive.code }"
          title="行内代码"
          @click="runBubble('toggleCode')"
        >
          <Icon name="code" :size="14" />
        </button>
        <span class="bubble-divider" />
        <button class="bubble-btn" title="链接" @click="addLink">
          <Icon name="link" :size="14" />
        </button>
        <button class="bubble-btn" title="清除格式" @click="clearFormats">
          <Icon name="x" :size="14" />
        </button>
      </div>
    </Transition>

    <!-- 编辑区 -->
    <div class="editor-scroll h-full overflow-y-auto" @scroll.passive="onScroll">
      <div
        class="mx-auto transition-all duration-300"
        :class="ui.focusMode ? 'max-w-[760px]' : 'max-w-[880px]'"
      >
        <EditorContent :editor="editor" class="editor-content px-6 pt-10 pb-40" />
      </div>
    </div>
  </div>
</template>
