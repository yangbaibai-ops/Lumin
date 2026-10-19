<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import TableQuickBar from './TableQuickBar.vue'
import { buildEditorExtensions } from '../../lib/editor/extensions'
import { openLinkTarget } from '../../lib/linkOpen'
import { getMarkdown } from '../../lib/editor/markdownStorage'
import { deferAfterPmEvent } from '../../lib/editor/defer'
import { activeHeadingIndex } from '../../lib/editor/scrollSpy'
import { allowRemoteImage } from '../../lib/remoteImages'
import { useEditorStore } from '../../stores/editor'
import { useFilesStore } from '../../stores/files'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { useNotificationsStore } from '../../stores/notifications'
import { perfFlag } from '../../lib/editor/perfProbe'

// ─── Typora 式所见即所得编辑器（开发文档「步骤 2」的高阶封装）────────────────
// - Tiptap(ProseMirror) AST 内核 + tiptap-markdown 双向转换
// - onUpdate 防抖序列化回 Markdown 源码（SQLite 持久化管道的源头）
// - 外部数据同步：**按账本世代**判断该不该换内容（手册 §4.59），不比字符串、不看时间窗
// - 自绘选区浮动菜单（选中文本时弹出格式工具）
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const editorStore = useEditorStore()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()
const notifications = useNotificationsStore()
/** 编辑器容器：远程图片占位的点击/回车委托挂在这里（见 loadGuardedImage） */
const containerRef = ref<HTMLElement | null>(null)
/**
 * 正文列包裹层（`relative`）：**表格快捷操作条的坐标系原点**。
 * 工具条是它的绝对定位子节点，所以落点用内容坐标（表格的 offsetTop/Left），
 * 滚动时与表格一起走 —— 不需要任何 scroll 监听（见 TableQuickBar.vue）。
 */
const colRef = ref<HTMLElement | null>(null)

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
    getDocumentDir: () => files.currentDir ?? null,
    // 远程图片默认不自动加载（隐私，见 lib/remoteImages.ts）：读设置、现取现用
    getRemoteImagePolicy: () => settings.remoteImages,
    // 粘贴护栏的可见提示（降级/拒绝/超时回滚）：走应用内通知中心，不静默吞内容
    onPasteNotice: (notice) => {
      void notifications.notify({
        level: notice.level,
        title: notice.title,
        body: notice.body
      })
    }
  }),
  editorProps: {
    attributes: {
      class: 'md-preview',
      /**
       * 正文是**唯一**开启拼写检查的编辑面（用户口径：正文 `spellcheck="true"`）。
       * 代码块（CodeMirror 的 contentDOM）、mermaid 源码框、公式/图片源码、源码模式
       * textarea 都显式 `spellcheck="false"` —— 否则满屏红波浪线。见各处的注释与
       * tests/spellcheckExclusions.test.mjs 的静态断言。
       */
      spellcheck: 'true'
    },
    /**
     * ⚡ 性能（本轮）：打字（以及任何 `scrollIntoView` 事务）时，PM 的
     * `scrollRectIntoView` 会**逐层量祖先矩形**（实测每次按键 14 次 getBoundingClientRect，
     * 且量完还可能写 scrollTop 引发重排）。光标本来就在可视区里时这些测量全是白做。
     *
     * 这里只做一件事：光标离上下边缘都还有 10px（PM 自己的 scrollMargin 是 5px，所以
     * 这个判据**比 PM 更保守**：会被 PM 滚动的情形我们一律交回 PM）才返回 true 跳过测量。
     * 光标贴近边缘 / 非折叠选区 / 拿不到滚动容器 ⇒ 返回 false，走的还是原来的 PM 路径。
     */
    handleScrollToSelection: (view) => {
      if (!perfFlag('fastScroll')) return false
      try {
        const sel = view.state.selection
        if (!sel.empty) return false
        const scroller = view.dom.closest('.editor-scroll') as HTMLElement | null
        if (!scroller) return false
        const box = scroller.getBoundingClientRect()
        const caret = view.coordsAtPos(sel.head)
        const pad = 10
        return caret.top >= box.top + pad && caret.bottom <= box.bottom - pad
      } catch {
        return false
      }
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
    // 归一化一次把标记文本写入文档（后续由 appendTransaction 自动维护）。
    // 延后一拍：onCreate 时首个事务还在 PM 手里，同步改会被它自己的初始化覆盖。
    deferAfterPmEvent(() => ed.commands.normalizeMdMarkers())
  },
  onSelectionUpdate: ({ editor: ed }) => {
    updateCursor(ed)
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
// 判定规则抽在 `lib/editor/scrollSpy.ts`（纯函数 + 单测）：判定线（容器上沿往下 90px）之上最后
// 一个标题 = 当前章节；文档末尾那几节压不到判定线时**按剩余滚动距离等分**依次点亮
// （用户两轮报障的边界：旧行为是停在倒数第四；加个「到底就跳最后」的补丁又会跳过中间两节）。
//
// ⚠️ 刚点过目录时用 store 的 `activePinned` 挡住侦测：**点的那条必须亮着**，直到用户自己滚动
// （wheel / 触摸 / 按键 / 按下指针）为止 —— 之前是「800ms 后自动解锁」，结果平滑滚动落地后侦测
// 立刻把高亮从我点的那条挪走（用户第二轮报障：点倒数第三、亮到倒数第四）。
let outlineTimer: ReturnType<typeof setTimeout> | null = null
function onScroll(e: Event): void {
  if (outlineTimer) return
  const el = e.target as HTMLElement
  outlineTimer = setTimeout(() => {
    outlineTimer = null
    const ed2 = editor.value
    if (!ed2) return
    if (editorStore.activePinned) return // 用户点的那条还没让位（见 store 的注释）
    const cTop = el.getBoundingClientRect().top
    const outline = editorStore.outline
    const tops = outline.map((it) => ed2.view.coordsAtPos(it.pos).top - cTop)
    const idx = activeHeadingIndex({
      tops,
      scrollTop: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight
    })
    editorStore.activeHeading = idx < 0 ? -1 : outline[idx].pos
  }, 80)
}

// 应用关闭前落盘最后一段输入（仅窗口级关闭触发，不参与文件切换流程）
function onWindowBeforeUnload(): void {
  if (unmounting) return
  const ed = editor.value
  if (ed) flushSync(ed)
}
window.addEventListener('beforeunload', onWindowBeforeUnload)

/**
 * ─── 远程图片占位：点击 / 回车即加载（自查报告 H2）──────────────────────────────
 * 渲染层把远程图渲染成 `<span data-remote-src=…>`（**没有 `src` 就不会发请求**）。
 * 这里做**就地替换**：把该 src 记进会话白名单（后续重渲染直接出真图），并把占位换成 `<img>`。
 * 不碰文档：这些 data-* 只是视图层的事，保存/导出用的仍是文档里的真实 src。
 *
 * ⚠️ 第五十五轮：钩子从**类名** `.img-guard` 改成**属性** `[data-remote-src]` ——
 * 占位元素不再有任何类名（用户口径："`.img-guard` 类名彻底消失"）。
 */
function loadGuardedImage(el: HTMLElement): void {
  const src = el.getAttribute('data-remote-src')
  if (!src) return
  allowRemoteImage(src)
  const img = document.createElement('img')
  // 拖拽已全局禁用（lib/dragGuard.ts）：就地换上的真图也不是拖拽源
  img.draggable = false
  img.src = src
  // alt 取占位元素自己的 data-remote-alt（第五十三轮已删掉文案节点，按内容查会恒为空）
  img.alt = el.getAttribute('data-remote-alt') ?? ''
  img.loading = 'lazy'
  el.replaceWith(img)
}

function onContainerClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-remote-src]') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  loadGuardedImage(el)
}

function onContainerKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const el = (e.target as HTMLElement | null)?.closest?.('[data-remote-src]') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  loadGuardedImage(el)
}

onMounted(() => {
  const el = containerRef.value
  if (!el) return
  el.addEventListener('click', onContainerClick)
  el.addEventListener('keydown', onContainerKeydown)
})

onBeforeUnmount(() => {
  unmounting = true
  clearTimeout(syncTimer as never)
  clearTimeout(renderTimer as never)
  clearTimeout(outlineTimer as never)
  window.removeEventListener('beforeunload', onWindowBeforeUnload)
  containerRef.value?.removeEventListener('click', onContainerClick)
  containerRef.value?.removeEventListener('keydown', onContainerKeydown)
})

// ── 选区浮动菜单：**已删除**（第二十五轮；审计结论见下）─────────────────────────
// 它从第二十二轮起就被 `BUBBLE_MENU_ENABLED = false` 永久关闭：模板 `v-if` 恒假、
// `updateBubbleMenu` 提前返回，但**每次选区变化仍在重算气泡状态**（纯浪费），
// 组件里 77 行 + `style.css` 40 行 + `verify-tiptap.js` 3 条断言都是死码；
// 而 `README.md` 与手册还把它记成「已交付」。功能上它与顶部工具栏 + 编辑器右键菜单
// **完全重复**（同 5 个行内格式 + 链接），因此删掉而不是留着「以后可能开」。
// 若将来真想要选区气泡，正确做法是重新实现成一个独立组件（而不是复活这段死码）。

defineExpose({ editor, syncNow })
</script>

<template>
  <div
    ref="containerRef"
    class="typora-container relative h-full"
    :class="{ 'focus-mode': ui.focusMode }"
  >
    <!-- 编辑区。
         分屏时给滚动容器加 `editor-scroll--split-left`：把**左侧（渲染面）**的滚动条移到左边，
         于是两侧滚动条各自贴外缘、中间分界线干净（做法与坑见 components.css 的同名注释）。 -->
    <div
      class="editor-scroll h-full overflow-y-auto"
      :class="{ 'editor-scroll--split-left': ui.editorMode === 'split' }"
      @scroll.passive="onScroll"
      @wheel.passive="editorStore.releaseActiveHeadingPin()"
      @touchstart.passive="editorStore.releaseActiveHeadingPin()"
      @pointerdown="editorStore.releaseActiveHeadingPin()"
      @keydown="editorStore.releaseActiveHeadingPin()"
    >
      <div
        ref="colRef"
        class="relative mx-auto transition-all duration-300"
        :class="ui.focusMode ? 'max-w-[1140px]' : 'max-w-[1320px]'"
      >
        <!-- 正文列的左右内缩：40px → **56px**（用户口径「稍微增加编辑区内容与左右两侧的间隔」）。
             通知带（NotificationCenter）与查找栏用的内缩要跟着这里走，见 overlays.css 的同名注释。 -->
        <EditorContent
          :editor="editor"
          class="editor-content px-14 max-[900px]:px-8 max-[760px]:px-5 pt-10 max-[760px]:pt-7 pb-40"
        />
        <!-- 表格快捷操作条：贴光标所在那张表的头部（内容坐标，随滚动一起走）。
             这一层 `relative` 就是它的坐标系原点，见 TableQuickBar.vue。 -->
        <TableQuickBar :host="colRef" />
      </div>
    </div>
  </div>
</template>
