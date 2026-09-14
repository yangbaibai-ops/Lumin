<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import { buildEditorExtensions } from '../../lib/editor/extensions'
import { openLinkTarget } from '../../lib/linkOpen'
import { getMarkdown } from '../../lib/editor/markdownStorage'
import { useEditorStore } from '../../stores/editor'
import { useFilesStore } from '../../stores/files'
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
const files = useFilesStore()
const ui = useUiStore()

let syncTimer: ReturnType<typeof setTimeout> | null = null
// 卸载中标记：切换文件时旧实例销毁会触发 blur/destroy，
// 若不拦截，flushSync 会把旧文档内容回写覆盖新打开的文档（数据竞态）
let unmounting = false
// 内部序列化回声守卫：记录最近一次 emit 的内容与时刻。快速连续输入时，
// blur 触发的 flushSync 会把「上一轮」的 markdown 提前 emit 出去，经父组件
// store 同步回流成 props.modelValue，外部同步 watch 误判为外部变化而
// setContent 回滚整个文档（快速回车丢失的根因）。回声过滤 + 静默窗双保险。
let lastEmitted: string | null = null
let lastEmitTime = 0

function flushSync(ed: Editor): void {
  if (unmounting) return
  // 源码模式：编辑器被 display:none 隐藏，切走时其 blur 若把序列化 md 写回
  // files 会重置 textarea 的 value/光标（还把源码模式里的最新编辑覆盖掉）。
  // 源码模式的编辑面是 textarea，编辑器只是隐藏副本——切回编辑器视图时由
  // EditorView 按需一次性同步（syncEditorContent），此处无需 emit。
  if (ui.editorMode === 'source') return
  clearTimeout(syncTimer as never)
  syncTimer = null
  try {
    const md = getMarkdown(ed)
    lastEmitted = md
    lastEmitTime = performance.now()
    emit('update:modelValue', md)
    // 编辑器文档 == 刚序列化的 md（files 槽同步由父组件 onEditorUpdate 完成）
    editorStore.markSynced(md)
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
  extensions: buildEditorExtensions({ onOpenLink: (href) => void openLinkTarget(href) }),
  editorProps: {
    attributes: {
      class: 'md-preview',
      spellcheck: 'false'
    }
  },
  onUpdate: ({ editor: ed }) => {
    // 防抖 250ms：高频输入合并序列化（开发文档性能建议）
    editorStore.markDirty()
    clearTimeout(syncTimer as never)
    syncTimer = setTimeout(() => flushSync(ed), 250)
  },
  onBlur: ({ editor: ed, event }) => {
    // 焦点仍在编辑器内部（例如移入代码块 CodeMirror、点选气泡菜单）时
    // 不落盘：否则会抢在本轮文档同步之前把「上一轮」的旧快照 emit 出去，
    // 回流后触发外部同步 watch 的 setContent 回滚（快速回车丢失的根因）。
    const rt = event?.relatedTarget as HTMLElement | null
    if (rt && (rt.closest('.cm-editor') || ed.view.dom.contains(rt))) return
    flushSync(ed)
  },
  onCreate: ({ editor: ed }) => {
    editorStore.bind(ed)
    // 编辑器以 props.modelValue（=files.content）整装创建：记录已对齐 md
    editorStore.markSynced(props.modelValue)
    updateCursor(ed)
    // 真实文本标记模型：初始解析产物只有 legacy bold 等 mark，
    // 归一化一次把标记文本写入文档（后续由 appendTransaction 自动维护）
    setTimeout(() => ed.commands.normalizeMdMarkers(), 0)
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
// 双重回声过滤：
// 1. nv 与最近一次内部 emit 完全一致 → 自身回声，跳过；
// 2. 距最近内部 emit 600ms 内的更新 → 滞后回声（blur 提前 emit 的旧快照
//    经 store 回流），跳过。真正的文件切换/草稿恢复是低频外部事件，
//    不会被静默窗误伤；高速输入结束 250ms 防抖 emit 最新内容后，其
//    回声同样在窗内被忽略，不再触发 setContent 全文档重建。
//
// ⚠️ 两条过滤都是**启发式**，对「显式外部替换」（重新解释编码等）都不成立：
//    * 按原编码切回来时，store 里的内容恰好**等于**编辑器上一次 emit 的文本（就是原文），
//      于是被规则 1 当成回声丢掉；
//    * 若上一次 emit 发生在 600ms 内（切完编码马上再切、或刚打完字），会被规则 2 丢掉。
//    结果就是「状态栏编码变了、正文却没回来」。所以显式替换（files.syncEpoch 变化）走
//    force 分支，**跳过两条过滤**、无条件同步。
function applyExternalContent(nv: string, force: boolean): void {
  const ed = editor.value
  if (!ed) return
  // 源码模式：编辑器常驻但隐藏，textarea 才是编辑面。逐键的 files 更新
  // 若在这里 setContent 会变成「每次停顿重解析整篇大文档」（历史卡顿根源），
  // 交给 EditorView 在切回编辑器视图时按需一次性同步（restore 里的
  // syncEditorContent）。文件打开/草稿恢复走 :key 重建，同样不需要此路径。
  if (ui.editorMode === 'source') return
  if (!force) {
    if (nv === lastEmitted) return
    if (performance.now() - lastEmitTime < 600) return
  }
  try {
    const current = getMarkdown(ed)
    if (force || current !== nv) {
      ed.commands.setContent(nv, { emitUpdate: false })
      // 外部同步后编辑器文档 == nv（files 内容），记录对齐状态
      editorStore.markSynced(nv)
    }
  } catch {
    /* 解析失败时保持现状（例如极端脏数据） */
  }
}

watch(
  () => props.modelValue,
  (nv) => applyExternalContent(nv, false)
)
// 显式外部替换（重新解释编码 / 强制回载）：无条件同步
watch(
  () => files.syncEpoch,
  () => applyExternalContent(props.modelValue, true)
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
/**
 * 选中文字后的浮动格式工具栏开关。
 * 目前按需求「暂时禁用」：实现完整保留（定位计算、贴边钳制、样式、按钮全在），
 * 把这里改回 true 即可原样恢复，无需其它改动。
 * 禁用时 updateBubbleMenu 直接返回，气泡永不显示；模板处再兜一层判断，
 * 避免将来别处置位 bubbleVisible 时意外弹出。
 */
const BUBBLE_MENU_ENABLED = false
const bubbleVisible = ref(false)
const bubblePos = ref({ top: 0, left: 0 })
// 气泡的绝对定位上下文：模板根节点 .typora-container（position:relative）
const containerRef = ref<HTMLElement | null>(null)

function updateBubbleMenu(ed: Editor): void {
  if (!BUBBLE_MENU_ENABLED) {
    bubbleVisible.value = false
    return
  }
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
    bold: ed.isActive('mdStyle', { style: 'bold' }),
    italic: ed.isActive('mdStyle', { style: 'italic' }),
    underline: ed.isActive('underline'),
    strike: ed.isActive('mdStyle', { style: 'strike' }),
    code: ed.isActive('mdStyle', { style: 'code' })
  }
})

function runBubble(cmd: string): void {
  const ed = editor.value
  if (!ed) return
  switch (cmd) {
    case 'toggleBold':
      ed.chain().focus().toggleMdBold().run()
      break
    case 'toggleItalic':
      ed.chain().focus().toggleMdItalic().run()
      break
    case 'toggleUnderline':
      ed.chain().focus().toggleUnderline().run()
      break
    case 'toggleStrike':
      ed.chain().focus().toggleMdStrike().run()
      break
    case 'toggleCode':
      ed.chain().focus().toggleMdCode().run()
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
    <!-- 自绘选区浮动菜单（当前由 BUBBLE_MENU_ENABLED 关闭，见 script 顶部说明） -->
    <Transition name="pop">
      <div
        v-if="BUBBLE_MENU_ENABLED && bubbleVisible && editor"
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
        :class="ui.focusMode ? 'max-w-[1140px]' : 'max-w-[1320px]'"
      >
        <EditorContent :editor="editor" class="editor-content px-10 pt-10 pb-40" />
      </div>
    </div>
  </div>
</template>
