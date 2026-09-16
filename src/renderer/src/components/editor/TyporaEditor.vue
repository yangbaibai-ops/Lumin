<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import { buildEditorExtensions } from '../../lib/editor/extensions'
import { openLinkTarget } from '../../lib/linkOpen'
import { getMarkdown } from '../../lib/editor/markdownStorage'
import { selectionHasMdStyle } from '../../lib/editor/typoraInlineMarks'
import { useEditorStore } from '../../stores/editor'
import { useFilesStore } from '../../stores/files'
import { useUiStore } from '../../stores/ui'
import Icon from '../Icon.vue'

// ─── Typora 式所见即所得编辑器（开发文档「步骤 2」的高阶封装）────────────────
// - Tiptap(ProseMirror) AST 内核 + tiptap-markdown 双向转换
// - onUpdate 防抖序列化回 Markdown 源码（SQLite 持久化管道的源头）
// - 外部数据同步：**按账本世代**判断该不该换内容（手册 §4.59），不比字符串、不看时间窗
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

function flushSync(ed: Editor): void {
  if (unmounting) return
  // 源码模式：编辑器被 display:none 隐藏，切走时其 blur 若把序列化 md 写回
  // files 会重置 textarea 的 value/光标（还把源码模式里的最新编辑覆盖掉）。
  // 源码模式的编辑面是 textarea，编辑器只是隐藏副本——切回编辑器视图时由
  // 账本（`files.contentIsStale('wysiwyg')`）驱动一次性同步，此处无需 emit。
  if (ui.editorMode === 'source') return
  clearTimeout(syncTimer as never)
  syncTimer = null
  try {
    const md = getMarkdown(ed)
    emit('update:modelValue', md)
    // 序列化结果由父组件写入 files（onEditorUpdate）并消费写者标记
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
  extensions: buildEditorExtensions({
    onOpenLink: (href) => void openLinkTarget(href),
    // 图片相对路径的解析基准 = 当前文档所在目录（未命名文档为侧栏工作区，见 stores/files 的 openUntitled）
    getDocumentDir: () => files.currentDir ?? null
  }),
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
    // 编辑器以 props.modelValue（=files.content）整装创建：直接标记「已渲染到当前世代」
    files.markContentApplied('wysiwyg')
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

// ── 外部数据同步：**只看账本世代**（手册 §4.59）──────────────────────────────
//
// 规则只有一条：`files.contentIsStale('wysiwyg')` —— 我渲染到的世代落后于真源，就按
// store 的内容 setContent 一次并报「已跟上」；没落后就什么都不做。
//
// 为什么这就够了：
//   * 自己 flush 出去的写入由账本记成 `author='wysiwyg'`（代码块写的是 `'codeblock'`），
//     `write()` 顺手把这些编辑面的 applied 推到最新 ⇒ **自己的回声永远不会回灌自己**，
//     不需要「刚 emit 的内容相等」或「600ms 静默窗」这类会漏判的启发式；
//   * 源码 textarea / 切编码 / 恢复草稿 / 载入历史 / 打开文件都会让世代 +1 且作者不是
//     wysiwyg ⇒ applied 落后 ⇒ 这里必换内容，哪怕新旧文本恰好一模一样
//     （旧写法在「切回原编码」时正好被内容相等骗过去，状态栏变了正文不动）。
//
// 唯一例外：源码模式。编辑器此时是被 display:none 的隐藏副本，textarea 才是编辑面；
// 逐键 setContent 会变成「每停一下重解析整篇大文档」，所以推迟到切回编辑器视图时
// 由 EditorView 调 `applyStoreContent()` 一次性对齐（模式切换本就会走这条路）。
function doApplyStoreContent(): void {
  const ed = editor.value
  if (!ed || unmounting) return
  if (!files.contentIsStale('wysiwyg')) return
  // 内容**从 store 现读**，不读 `props.modelValue`：props 是父组件渲染时传下来的，
  // 而账本 watcher 跑在渲染之前（默认 pre-flush）—— 读 props 会拿到**上一代**的内容，
  // 把编辑器灌成旧文本。真源只有一个，就直接读它（旧写法正是踩在这一点上：
  // 灌旧文本后归一化插件会产生一次新事务 → onUpdate → 防抖 flush 把旧文本写回 store，
  // 源码面刚敲的那行就没了；表现为偶发，取决于那一次 watcher 落在渲染前还是渲染后）。
  const nv = files.current?.content ?? ''
  try {
    ed.commands.setContent(nv, { emitUpdate: false })
  } catch {
    /* 解析失败时保持现状（例如极端脏数据） */
  }
  files.markContentApplied('wysiwyg')
}

/**
 * 渲染节流：分屏下源码面逐键输入时，左侧预览合并成 ~200ms 一次整篇重解析。
 * 注意这只是**推迟渲染**，不是第二条真源 —— 「要不要重渲染」仍然只由账本决定。
 */
let renderTimer: ReturnType<typeof setTimeout> | null = null

/** 账本驱动的自动对齐（真源每变一代跑一次） */
function applyStoreContent(): void {
  if (unmounting || !editor.value) return
  // 源码模式：编辑器是隐藏副本，不在这里逐键重解析（切回视图时 syncNow 一次性对齐）
  if (ui.editorMode === 'source') return
  if (!files.contentIsStale('wysiwyg')) return
  if (ui.editorMode === 'split' && files.contentAuthor === 'source') {
    clearTimeout(renderTimer as never)
    renderTimer = setTimeout(() => {
      renderTimer = null
      doApplyStoreContent()
    }, 200)
    return
  }
  syncNow()
}

/** 立刻对齐（供模式切换 / 光标落位前调用：不做节流、不看模式） */
function syncNow(): void {
  clearTimeout(renderTimer as never)
  renderTimer = null
  doApplyStoreContent()
}

watch(() => files.contentRev, applyStoreContent)

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
  clearTimeout(renderTimer as never)
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
    bold: selectionHasMdStyle(ed, 'bold'),
    italic: selectionHasMdStyle(ed, 'italic'),
    underline: ed.isActive('underline'),
    strike: selectionHasMdStyle(ed, 'strike'),
    code: selectionHasMdStyle(ed, 'code')
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

defineExpose({ editor, syncNow })
</script>

<template>
  <div
    ref="containerRef"
    class="typora-container relative h-full"
    :class="{ 'focus-mode': ui.focusMode }"
  >
    <!-- 自绘选区浮动菜单（当前由 BUBBLE_MENU_ENABLED 关闭，见 script 顶部说明） -->
    <Transition name="pop">
      <div
        v-if="BUBBLE_MENU_ENABLED && bubbleVisible && editor"
        class="bubble-menu absolute z-50"
        :style="{
          top: bubblePos.top + 'px',
          left: bubblePos.left + 'px',
          transform: 'translateX(-50%)'
        }"
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
