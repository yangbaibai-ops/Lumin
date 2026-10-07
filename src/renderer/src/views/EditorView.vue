<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TextSelection } from '@tiptap/pm/state'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { useEditorMenuStore } from '../stores/editorMenu'
import Toolbar from '../components/Toolbar.vue'
import StatusBar from '../components/StatusBar.vue'
import NotificationCenter from '../components/NotificationCenter.vue'
import OutlinePanel from '../components/OutlinePanel.vue'
import TyporaEditor from '../components/editor/TyporaEditor.vue'
import Icon from '../components/Icon.vue'
import { measureAllCodeBlocks } from '../lib/editor/codeBlockViews'
import { confirmIfDirty } from '../composables/useAppActions'
import { openExternalFile } from '../lib/openFile'
import { registerEditorFlush, currentEditorFlush } from '../lib/editorFlush'
import { useEditorMode } from '../composables/useEditorMode'
import i18n from '../i18n'

// ─── 编辑器页面：工具栏 + 实时渲染/分屏对比/源码三模式 + 状态栏 ────────────
// 布局模型：渲染面板（Tiptap）与源码面板（textarea）各只挂载一次、常驻 DOM，
// 模式切换只改变两个面板的尺寸/显隐与分隔条，绝不卸载重建编辑器内核——
// 大文档下 TyporaEditor 重建是此前切换耗时（数百 ms）的唯一来源。
const files = useFilesStore()
const ui = useUiStore()
const editorStore = useEditorStore()
const settings = useSettingsStore()
const editorMenu = useEditorMenuStore()
/**
 * 「编辑器里挂起的变更现在就得落地」的登记：数据层（stores/files、lib/dialog）在换文档 /
 * 关窗 / 判断脏之前会调它，而它只会调到这里 —— 见 lib/editorFlush.ts 的说明。
 * 登记的是`useEditorMode` 里那份唯一的 flush 实现（防抖窗口内的序列化 + 账本记账）。
 */
const { flushWysiwyg } = useEditorMode()

/**
 * 渲染面板右键：先按点击位置校正选区（右键点在哪就作用于哪，表格识别才准确；
 * 点在已有选区内则保留选区），再交 store 组装并打开菜单。
 * 源码视图不接管（保留原生文本菜单的拼写/粘贴能力）。
 */
function onRenderContextMenu(e: MouseEvent): void {
  const editor = editorStore.instance
  if (!editor || ui.editorMode === 'source') return
  e.preventDefault()
  const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (hit) {
    const { from, to } = editor.state.selection
    // posAtCoords 可能落在非文本块上（表格外框、行间空白、块首尾边界），此时不能改选区：
    // TextSelection 要求端点落在 inline content 内，否则 PM 会告警并拒绝定位。
    const inline = editor.state.doc.resolve(hit.pos).parent.inlineContent
    if (inline && (hit.pos < from || hit.pos > to)) editor.commands.setTextSelection(hit.pos)
  }
  editorMenu.openAt(e.clientX, e.clientY)
}

function onEditorUpdate(md: string): void {
  // 记一代账：作者由编辑面自己挂的牌决定（正文输入 = wysiwyg，代码块 CodeMirror = codeblock）。
  // 账本顺手把作者的 applied 推到最新，所以这次写入不会回灌到作者自己身上。
  files.setContent(md, editorStore.consumeWriteIntent())
}

/** editorStore.instance 的窄化类型（跨文件类型别名，避免 Editor 泛型不一致） */
type PmEditor = NonNullable<typeof editorStore.instance>

// ─── 源码面板（textarea 原始 Markdown，绝不渲染样式）──
// 分屏右侧与全屏源码模式共用同一个常驻 textarea：切换时选区/滚动天然保留，
// 只需按模式切换外层的居中/留白类。
//
// 它是**声明式副本**：模板上 `:value="files.current?.content"` 就是唯一的回灌通道，
// 内核永远单向 store → DOM。声明式本身是收敛的（DOM 值已经等于新值时浏览器不动光标，
// 所以「自己写的」那条路径不需要再用代码判断一次）—— 见 lib/contentSync.ts 顶部说明。
const sourceRef = ref<HTMLTextAreaElement | null>(null)
const renderRef = ref<{ syncNow: () => void } | null>(null)

function onSourceInput(e: Event): void {
  files.setContent((e.target as HTMLTextAreaElement).value, 'source')
}

/** 源码模式 Tab 插入两个空格（textarea 默认 Tab 会移出焦点，写作语义不符） */
function onSourceTab(e: KeyboardEvent): void {
  e.preventDefault()
  const ta = e.target as HTMLTextAreaElement
  const { selectionStart, selectionEnd, value } = ta
  ta.value = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
  ta.selectionStart = ta.selectionEnd = selectionStart + 2
  files.setContent(ta.value, 'source')
}

/** 源码模式光标位置 → 状态栏 */
function updateSourceCursor(ta: HTMLTextAreaElement): void {
  const before = ta.value.slice(0, ta.selectionStart ?? 0)
  const lines = before.split('\n')
  ui.cursor = { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

/**
 * 分屏下左侧序列化不许把右侧的**光标与滚动顶到末尾**（审计 §3 P2）。
 *
 * 这不是我们写的代码在动光标，而是 HTML 规范本身：`value` setter 在"新值 ≠ 当前值"时
 * 会把选区移到末尾。右侧 textarea 是声明式副本（`:value`），左侧每 250ms 序列化一次落库 ——
 * 只要右栏内容跟着变，正在对照阅读/校对的人就被弹回文末（小而频繁的打断）。
 *
 * 所以在值**真的**变化时保存并恢复选区与滚动：变化前后光标位置都是"用户放在那儿的"，
 * 恢复到原处才是对的行为。注意"自己输入"那条路径不会进这里（DOM 值已经等于新值，
 * 浏览器不动光标，我们也不动）。
 *
 * 实测（本机 Chromium，见 tools/_regress-split-live.js 的 P 段反向对照）：
 *   * `value` setter **确实**把光标移到末尾（1364 → 3424，即文末）；
 *   * `scrollTop` **没有**被它改（1659 → 1659）—— 所以下面那行恢复滚动是**护栏**
 *     （别的内核/别的情形下不保证），真正的修复点是恢复选区。
 */
watch(
  () => files.current?.content ?? '',
  (next) => {
    const ta = sourceRef.value
    if (!ta || ta.value === next) return
    const selStart = ta.selectionStart ?? 0
    const selEnd = ta.selectionEnd ?? selStart
    const scrollTop = ta.scrollTop
    void nextTick(() => {
      // 等 Vue 把新值写进 DOM 之后再恢复；期间若又来了更新，这次就作废
      // （下一次 watch 回调会带着更新的值再恢复一次）
      if (sourceRef.value !== ta || ta.value !== next) return
      const len = next.length
      try {
        ta.setSelectionRange(Math.min(selStart, len), Math.min(selEnd, len))
      } catch {
        /* 选区非法时保持浏览器默认 */
      }
      ta.scrollTop = scrollTop
    })
  }
)

// ─── 分屏双向同步（IDEA 式对比）──
// 两条方向都由**同一个账本**驱动，没有第二套判断：
//   左（实时渲染）→ 右（源码）：Tiptap 防抖序列化 → files store（作者 wysiwyg）
//     → textarea 的 `:value` 绑定自动跟上（声明式副本，零新增代码）。
//   右（源码）→ 左（实时渲染）：输入即写 files store（作者 source）→ TyporaEditor 的
//     `contentRev` watcher 看到自己落后 ⇒ setContent 进 Tiptap（分屏下 200ms 合并，
//     见 TyporaEditor 的 applyStoreContent；那条合并只是渲染节流）。
// 旧写法在这里另开了一个 200ms 的 setContent 定时器，是同一件事的第二条通道，
// 已删除（手册 §4.59）。

// ── 分屏分隔条拖拽（比例 0.25~0.75，SQLite kv 持久化）──
//
// ─── 为什么拖拽要走「直写 DOM」而不是 splitRatio 响应式 ───────────────────────
// 实测（800 段 + 32 个代码块的文档，Chrome 同机）：
//   * **一次「改 pane 宽度 + 布局」≈ 16ms**（整篇按新宽度重排，这是主要开销，与 Vue 无关：
//     直接写 DOM、CSS 变量两条路都和走 Vue 一样，p95 33ms / max 67ms，百万像素级文档必掉帧）；
//   * `.split-dragging *` 的 `user-select: none !important` 让**整棵子树**在开始/结束拖拽时
//     各做一次全量样式重算 ≈ 26ms —— 所以那条规则改成只作用在 body 上；
//   * 分隔条原本是 flex 子项，改宽度时它也要一起重排 —— 现在改成绝对定位浮层。
// 结论：布局重排本身省不掉（文本必须按新宽度重新折行），能省的是**每帧重复的中间层**：
//   * 指针事件按 rAF 合帧：一帧最多写一次宽度（浏览器一帧本来也只布局一次，多余的写只会
//     反复置脏并让 style/布局缓存失效）；
//   * 拖拽期间**不碰响应式状态**：只改两个 pane 的 inline style 与分隔条位置，
//     Vue 一次都不重渲染（结束时才写回 splitRatio / 持久化）；
//   * 拖拽中给两栏加 `contain: layout paint` + 关掉过渡：把重排半径限制在 pane 内部，
//     并让分隔条不追着指针"慢慢滑"。
const kernelRef = ref<HTMLElement | null>(null)
const splitRatio = ref<number>(settings.splitRatio)
const splitDragging = ref(false)

function clampRatio(v: number): number {
  return Math.min(0.75, Math.max(0.25, v))
}

/** 拖拽期间被直接改样式的两个 pane（结束时清理 inline style，交回 Vue 管） */
interface SplitDragPanes {
  left: HTMLElement
  right: HTMLElement
  divider: HTMLElement | null
}
function splitPanes(): SplitDragPanes | null {
  const host = kernelRef.value
  if (!host) return null
  const panes = Array.from(host.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('bg-paper')
  )
  const left = panes[0]
  const right = panes[panes.length - 1]
  if (!left || !right) return null
  return { left, right, divider: host.querySelector<HTMLElement>('.split-divider') }
}

function startSplitDrag(e: MouseEvent): void {
  e.preventDefault()
  const host = kernelRef.value
  if (!host) return
  const panes = splitPanes()
  if (!panes) return
  const rect = host.getBoundingClientRect()
  splitDragging.value = true
  document.body.classList.add('split-dragging')
  // 拖拽期间关掉两栏的过渡与 `contain`（重排半径限制在 pane 内，别扩散到整页）
  for (const p of [panes.left, panes.right]) {
    p.style.transition = 'none'
    p.style.contain = 'layout paint'
  }

  let pendingX: number | null = null
  let raf = 0
  /** 一帧只落一次：把比例直接写进 DOM（不触发 Vue） */
  const apply = (): void => {
    raf = 0
    if (pendingX === null) return
    const ratio = clampRatio((pendingX - rect.left) / rect.width)
    pendingX = null
    panes.left.style.flex = '0 0 auto'
    panes.left.style.width = (ratio * 100).toFixed(4) + '%'
    panes.right.style.flex = '1 1 0%'
    // 分隔条跟着分界线走（浮层，不参与两侧重排）
    const d = kernelRef.value?.querySelector<HTMLElement>('.split-divider')
    if (d) d.style.left = (ratio * 100).toFixed(4) + '%'
  }
  const move = (ev: MouseEvent): void => {
    pendingX = ev.clientX
    if (!raf) raf = requestAnimationFrame(apply)
  }
  const up = (ev: MouseEvent): void => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    // 最后一次指针位置也要落地（否则会有"松手后差一点"的观感）
    const ratio =
      ev && typeof ev.clientX === 'number'
        ? clampRatio((ev.clientX - rect.left) / rect.width)
        : splitRatio.value
    // 终态直接落 DOM（不经过 Vue），并且这一份 inline 从此由我们持有、不清除
    panes.left.style.flex = '0 0 auto'
    panes.left.style.width = (ratio * 100).toFixed(4) + '%'
    panes.right.style.flex = '1 1 0%'
    panes.right.style.width = ''
    panes.right.style.minWidth = '0'
    panes.left.style.display = ''
    panes.right.style.display = ''
    splitRatio.value = ratio
    splitDragging.value = false
    document.body.classList.remove('split-dragging')
    for (const p of [panes.left, panes.right]) {
      p.style.transition = ''
      p.style.contain = ''
    }
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)

    /**
     * 关于「松手后为什么不把 inline 交回 Vue」：
     *
     * 实测（隔离实例 + MutationObserver 记录 style 属性的每一次写入）：松手后 Vue **并没有**
     * 重写 pane 的 `:style`。Vue 的 patchStyle 是拿「上一次渲染的值」和「新值」比对后再写，
     * 拖拽期间 DOM 被外部改过（我们直写 inline）、又由 `clearInline` 清空过，Vue 记的
     * prev/next 与实际 DOM 已经脱节——它认为"没变化"就短路了，于是清完 inline 就没人再写：
     * 左栏宽度掉到 516px（≈ 内容 max-content），`ratio` 却是 0.5875，两者对不上。
     *
     * 结论：pane 宽度**不交给 Vue**。拖拽中直写、拖拽后也直写，唯一的写入方是
     * `syncPaneLayout()`（模式切换与双击复位也走它），这样"屏幕上的宽度"只有一个主人，
     * 不会出现两份状态互相覆盖。分隔条位置仍由 Vue 的 CSS 变量绑定驱动。
     */
    syncPaneLayout()
    // 拖拽结束才持久化（拖拽过程高频写 kv 无意义）
    settings.set('splitRatio', splitRatio.value)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/**
 * 双击分隔条：左右比例复位到 1:1 并持久化。
 * 写成方法而不是模板内联多语句 —— prettier 会把内联多语句的分号吃掉（`a = 1 b()`），
 * Vue 模板编译器随即报 "Error parsing JavaScript expression"。
 */
function resetSplitRatio(): void {
  splitRatio.value = clampRatio(0.5)
  settings.set('splitRatio', splitRatio.value)
}

/**
 * 分隔条的**键盘路径**（审计 §8 P2「纯鼠标交互：分屏分隔条 / 侧栏宽度手柄 / mermaid 预览」）。
 *
 * 语义照 ARIA APG 的 window splitter：`role="separator"` + `aria-orientation="vertical"` 时
 * 它就是**可聚焦的 widget**，必须带 `aria-valuenow/min/max` 并响应方向键。
 * 步长与侧栏宽度手柄（`AppSidebar.onResizeKeydown`）保持一致：2%，按住 Shift 走 10%；
 * Home/End/Enter/Space 复位到 1:1（与双击同一档）。
 */
function onSplitKeydown(e: KeyboardEvent): void {
  if (e.key === 'Home' || e.key === 'End' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    resetSplitRatio()
    return
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const step = e.shiftKey ? 0.1 : 0.02
  splitRatio.value = clampRatio(splitRatio.value + (e.key === 'ArrowRight' ? step : -step))
  settings.set('splitRatio', splitRatio.value)
}

// ─── 分屏同步滚动 ───
// scroll 事件不冒泡但可捕获：在内核容器挂 capture 监听，分屏时左右任意一栏
// 滚动（含左侧代码块的 CodeMirror 内部滚动）都按「滚动进度比」映射到另一栏。
// 写入 target.scrollTop 后浏览器会回发一次 scroll 事件：busy 旗标 + 比值
// 收敛（同值赋值不再触发 scroll）保证不振荡、无回声回路。
let splitScrollBusy = false
function onSplitScroll(e: Event): void {
  if (ui.editorMode !== 'split' || !settings.syncScroll || splitScrollBusy) return
  const host = kernelRef.value
  if (!host) return
  const t = e.target as HTMLElement
  const leftScroll = host.querySelector<HTMLElement>('.editor-scroll')
  const rightScroll = host.querySelector<HTMLElement>('textarea.source-editor')
  const source =
    t === leftScroll || leftScroll?.contains(t)
      ? leftScroll
      : t === rightScroll
        ? rightScroll
        : null
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

// ─── 三视图切换时保持滚动/光标位置 ─────────────────────────────────────────
// 编辑器与 textarea 常驻后，各自内部的光标/滚动天然保留，不再需要「等待重建」。
// 保留的只有「跨面换算」：离开当前编辑面时把光标锚（PM pos 或 md offset）与
// 滚动进度记入 mem，切到另一编辑面时按内容比例还原到目标坐标——保证切换时
// 视线不跳（中段→中段），且滚动条宽度/换行变化后仍保持同一阅读进度。
interface ViewPosMem {
  // 滚动进度 0..1（相对各自滚动区总长）
  scrollRatio: number
  // 上次离开 Tiptap 编辑面时的光标：PM 位置 + 当时文档内容长度
  pmPos: number
  pmLen: number
  // 上次离开源码编辑面时的光标：字符偏移 + 当时源码长度
  mdOffset: number
  mdLen: number
  // 来源坐标种类（split 左右都可能持焦，用于跨界换算基准）
  fromKind: 'tiptap' | 'textarea'
}
const viewPosMem = ref<ViewPosMem | null>(null)
// 视图切换恢复期间隐藏内容区：新布局虽已就位，但光标/滚动是按比例落位的，
// 若先显示旧位置再跳会闪一帧；隐藏到恢复完成再一次性呈现（visibility:hidden
// 保留布局，滚动测量正常，耗时仅数毫秒）。
const viewRestoring = ref(false)

/**
 * 重文档降级：**源码模式下不挂载渲染面板**（见 lib/largeDoc.ts 的实测数字）。
 *
 * `files.heavyMode` 只在「打开文件时判定为超阈值」时置真（打开动作里已把会话模式切成 source），
 * 不会因为编辑过程中内容变大而中途卸载编辑器 —— 那会把未同步的输入丢掉。
 * 用户若主动切回 wysiwyg / split，这里就重新挂载（代价是他的选择，并且有降级提示告知过）。
 */
const skipRenderPane = computed(() => files.heavyMode && ui.editorMode === 'source')

/** 距文档开头的内容比例（Tiptap：按 PM pos / doc 长度；源码：offset / len） */
function anchorRatio(mem: ViewPosMem): number {
  if (mem.fromKind === 'textarea') return mem.mdLen ? mem.mdOffset / mem.mdLen : 0
  return mem.pmLen ? mem.pmPos / mem.pmLen : 0
}

/** 读取某元素的滚动进度（0..1），无滚动余地时 0 */
function scrollRatioOf(el: HTMLElement | null): number {
  if (!el) return 0
  const max = el.scrollHeight - el.clientHeight
  return max > 0 ? el.scrollTop / max : 0
}

/** 设置滚动进度：滚动条没有超出内容时不动（否则内容会跳） */
function applyScrollRatio(el: HTMLElement | null, ratio: number): void {
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  if (max > 0) el.scrollTop = Math.min(1, Math.max(0, ratio)) * max
}

/** 恢复滚动：立即设置 + 后台静默校准。
    图片/mermaid/代码块高亮等异步内容加载完可能改变 scrollHeight，用 rAF +
    120ms 各补一次（后台执行、位移很小，不会让用户感到延迟或明显跳动）。 */
function applyScrollRatioSettled(el: HTMLElement | null, ratio: number): void {
  applyScrollRatio(el, ratio)
  requestAnimationFrame(() => applyScrollRatio(el, ratio))
  setTimeout(() => applyScrollRatio(el, ratio), 120)
}

/** 编辑器视图内的实际滚动容器（.editor-scroll，TyporaEditor 内部） */
function editorScrollEl(ed: PmEditor | null): HTMLElement | null {
  const dom = ed?.view?.dom as HTMLElement | undefined
  return dom ? (dom.closest('.editor-scroll') as HTMLElement | null) : null
}

/** 保存当前编辑面状态（离开前调用；此时旧布局还在 DOM 里，可直接读取） */
function captureViewPos(prev: 'wysiwyg' | 'split' | 'source'): void {
  const ed = editorStore.instance
  let pmPos = 0
  let pmLen = 0
  let mdOffset = 0
  let mdLen = 0
  let scrollRatio = 0
  let fromKind: 'tiptap' | 'textarea' = 'tiptap'

  if (prev === 'source') {
    const ta = sourceRef.value
    mdLen = ta?.value.length ?? 0
    mdOffset = ta?.selectionStart ?? 0
    scrollRatio = scrollRatioOf(ta)
    fromKind = 'textarea'
  } else if (prev === 'split') {
    // 焦点在右侧源码 textarea 时按源码坐标系记录，否则按左侧 Tiptap 记录
    const ae = document.activeElement as HTMLElement | null
    const ta = sourceRef.value
    if (ta && (ae === ta || ta.contains(ae))) {
      mdLen = ta.value.length
      mdOffset = ta.selectionStart ?? 0
      scrollRatio = scrollRatioOf(ta)
      fromKind = 'textarea'
    } else if (ed) {
      pmLen = ed.state.doc.content.size
      pmPos = Math.min(Math.max(0, ed.state.selection.from), pmLen)
      scrollRatio = scrollRatioOf(editorScrollEl(ed))
      fromKind = 'tiptap'
    }
  } else if (ed) {
    // wysiwyg
    pmLen = ed.state.doc.content.size
    pmPos = Math.min(Math.max(0, ed.state.selection.from), pmLen)
    scrollRatio = scrollRatioOf(editorScrollEl(ed))
    fromKind = 'tiptap'
  }
  viewPosMem.value = { scrollRatio, pmPos, pmLen, mdOffset, mdLen, fromKind }
}

/** 等待编辑器实例就绪（文件刚切换、新 TyporaEditor 尚未绑定完成时） */
async function waitEditorReady(timeout = 1200): Promise<PmEditor | null> {
  const t0 = Date.now()
  await nextTick()
  for (;;) {
    const ed = editorStore.instance
    if (ed && ed.view?.dom?.isConnected) return ed
    if (Date.now() - t0 > timeout) return editorStore.instance
    await new Promise((r) => setTimeout(r, 8))
  }
}

/** 把记忆里的「光标比例」转成目标坐标系位置并安全落位 */
function placePmCursor(ed: PmEditor, ratio: number, exactPos: number): void {
  const doc = ed.state.doc
  const size = doc.content.size
  let pos: number
  if (exactPos > 0 && exactPos <= size) {
    pos = exactPos
  } else {
    pos = Math.round(ratio * size)
  }
  pos = Math.max(1, Math.min(pos, size))
  // 落点可能是块边界/非内联位置，用 near 安全钳制到最近可编辑文本位置
  try {
    const $pos = doc.resolve(pos)
    if (!$pos.parent.isTextblock) {
      const near = TextSelection.near($pos, 1)
      pos = near ? near.from : pos
    }
  } catch {
    /* 忽略，pos 已被钳制 */
  }
  try {
    ed.commands.setTextSelection(pos)
  } catch {
    /* 忽略：位置非法时保持编辑器默认光标 */
  }
}

function placeTextareaCursor(ta: HTMLTextAreaElement, ratio: number, exactOffset: number): void {
  const len = ta.value.length
  const offset = exactOffset > 0 && exactOffset <= len ? exactOffset : Math.round(ratio * len)
  try {
    ta.setSelectionRange(offset, offset)
  } catch {
    /* 忽略 */
  }
  updateSourceCursor(ta)
}

/** 切换后恢复（目标布局已应用、两编辑面均常驻） */
async function restoreViewPos(mode: 'wysiwyg' | 'split' | 'source'): Promise<void> {
  const mem = viewPosMem.value
  if (!mem) return
  // 源码坐标系的锚需要源码长度一致才有效（源码文本 = files.content）
  if (mem.fromKind === 'textarea' && mem.mdLen !== (files.current?.content ?? '').length) return
  const ratio = anchorRatio(mem)

  if (mode === 'source') {
    const ta = sourceRef.value
    if (!ta) return
    if (mem.fromKind === 'textarea') {
      placeTextareaCursor(ta, ratio, mem.mdOffset)
    } else {
      placeTextareaCursor(ta, ratio, 0) // Tiptap→源码：按比例近似
    }
    ta.focus()
    // focus 可能把光标滚入视野，布局稳定后再按比例复位滚动
    applyScrollRatioSettled(ta, mem.scrollRatio)
    return
  }

  // wysiwyg / split：目标含 Tiptap 左栏；编辑器常驻，直接拿当前实例
  let ed = editorStore.instance
  if (!ed) ed = await waitEditorReady()
  if (!ed) return
  // files 是唯一真源（分屏右侧/源码 textarea 都直接写 files）。进入编辑器视图前
  // 先把编辑器对齐到当前世代（源码模式下它是隐藏副本，刚才没逐键同步）；
  // 光标比例因此总是落在最新文档上。已对齐时这一步是空操作。
  renderRef.value?.syncNow()
  const fromTiptap = mem.fromKind === 'tiptap'
  if (mode === 'wysiwyg') {
    placePmCursor(ed, ratio, fromTiptap ? mem.pmPos : 0)
    ed.commands.focus()
    applyScrollRatioSettled(editorScrollEl(ed), mem.scrollRatio)
  }

  if (mode === 'split') {
    // 左栏始终对齐位置：同源精确、跨源按比例（保持中段→中段）
    placePmCursor(ed, ratio, fromTiptap ? mem.pmPos : 0)
    applyScrollRatioSettled(editorScrollEl(ed), mem.scrollRatio)
    const ta = sourceRef.value
    if (ta) {
      // 源码侧来的光标回到右栏；并把右栏滚动对齐到同一进度
      if (!fromTiptap) {
        placeTextareaCursor(ta, ratio, mem.mdOffset)
        ta.focus()
      } else {
        ed.commands.focus()
      }
      applyScrollRatioSettled(ta, mem.scrollRatio)
    }
  }
}

// 切换文件（TyporaEditor :key 重建）时，跨文档的位置记忆作废
watch(
  () => files.current?.path,
  () => {
    viewPosMem.value = null
    // 新编辑器会按当前世代整装重建（onCreate 里自报「已跟上」），此处只兜底一次，
    // 覆盖「同一 :key 下换了内容」的情形（未命名缓冲 → 另一个未命名缓冲）
    renderRef.value?.syncNow()
  }
)

// ─── 布局/显隐：**直写 DOM**，不走 `:style` 绑定 ───
// 注：分隔条是绝对定位浮层（不占位），所以 split 下左栏按比例占宽、右栏吃掉剩下的，
// 两者相加正好是整条内核宽度，浮层压在分界线上。
//
// 为什么不让 Vue 管两个 pane 的 style：拖拽期间必须绕过 Vue 才不会每帧重渲染（见上），
// 而"拖拽时直写、松手后交回 Vue"会留下两份状态——Vue 的 patchStyle 拿上一次渲染的值比对，
// DOM 又被外部改过，补丁会短路（实测松手后左栏掉回内容宽度）。所以两块 pane 的
// 显隐/宽度**只有一个写入方**：这个函数。模式切换、双击复位、拖拽结束都调它。
const renderPaneRef = ref<HTMLElement | null>(null)
const sourcePaneRef = ref<HTMLElement | null>(null)

function syncPaneLayout(): void {
  const left = renderPaneRef.value
  const right = sourcePaneRef.value
  if (!left || !right) return
  const mode = ui.editorMode
  if (mode === 'split') {
    left.style.display = ''
    left.style.flex = '0 0 auto'
    left.style.width = (splitRatio.value * 100).toFixed(4) + '%'
    right.style.display = ''
    right.style.flex = '1 1 0%'
    right.style.width = ''
    right.style.minWidth = '0'
    return
  }
  // wysiwyg：渲染面板整幅；source：源码面板整幅。另一个 display:none 但常驻（零重建）
  const isSource = mode === 'source'
  const wide = isSource ? right : left
  const hidden = isSource ? left : right
  wide.style.display = ''
  wide.style.flex = '1 1 0%'
  wide.style.width = ''
  wide.style.minWidth = '0'
  hidden.style.display = 'none'
  hidden.style.flex = ''
  hidden.style.width = ''
  hidden.style.minWidth = ''
}
// 显隐/宽度跟着模式与比例走；拖拽中改的是 DOM，不会触发这里（松手后由 up() 自己收尾）
watch([() => ui.editorMode, splitRatio], () => {
  void nextTick(syncPaneLayout)
})
onMounted(() => {
  syncPaneLayout()
})
/** 全屏源码模式的居中列（focusMode 决定最大宽度）；分屏右栏不居中。
    不加 transition：切模式时从「贴边」到「居中限宽」若带动画会显得慢一拍。 */
function sourceCenterClass(): string[] {
  if (ui.editorMode !== 'source') return []
  return ui.focusMode ? ['mx-auto', 'max-w-[1140px]'] : ['mx-auto', 'max-w-[1320px]']
}

// 模式切换：记录位置 → 激活/休眠编辑器 → 布局切换后按比例恢复
// immediate：启动即同步编辑器激活态（若持久化模式是 source，instance 保持 null，
// 待 bind 后 applyActive 也会尊重 active=false）
watch(
  () => ui.editorMode,
  async (mode, prev) => {
    // 离开前先记录当前位置（旧布局还在 DOM 里）；须在 setActive 前读取
    // instance（prev 为 tiptap 编辑面时 capture 依赖它）
    if (prev === 'wysiwyg' || prev === 'split' || prev === 'source') {
      captureViewPos(prev)
    }
    // 源码模式不激活编辑器（instance=null，工具栏富文本命令失活、大纲清空）
    editorStore.setActive(mode !== 'source')
    // 首次运行（prev===undefined，组件刚挂载）：只同步激活态
    if (prev === undefined) return
    const mem = viewPosMem.value
    if (!mem) {
      // 无记忆（首开/文件刚切换）：先把焦点给目标视图；编辑器可能因源码
      // 编辑而落后一个世代，落焦点前先按账本对齐一次
      if (mode === 'source') {
        await nextTick()
        sourceRef.value?.focus()
      } else {
        const ed = await waitEditorReady()
        if (!ed) return
        renderRef.value?.syncNow()
        ed.commands.focus()
      }
      return
    }
    // 有记忆：隐藏内容直到位置恢复完成（内容常驻、恢复仅数毫秒）
    viewRestoring.value = true
    await nextTick()
    try {
      await restoreViewPos(mode as 'wysiwyg' | 'split' | 'source')
    } finally {
      viewRestoring.value = false
    }
    // 隐藏（view-restoring）期间程序化 focus/光标落位可能被浏览器丢弃：
    // 可见后再补一次焦点与光标（隐藏期间设置的选区若被重置会掉到末尾）
    const mem2 = viewPosMem.value
    if (mem2) {
      const ratio2 = anchorRatio(mem2)
      requestAnimationFrame(() => {
        if (mode === 'source' || (mode === 'split' && mem2.fromKind === 'textarea')) {
          const ta = sourceRef.value
          if (!ta) return
          ta.focus()
          if (mode === 'source') {
            placeTextareaCursor(ta, ratio2, mem2.fromKind === 'textarea' ? mem2.mdOffset : 0)
            applyScrollRatio(ta, mem2.scrollRatio)
          } else {
            placeTextareaCursor(ta, ratio2, mem2.mdOffset)
          }
        } else {
          // 编辑器面：焦点补位（selection 已在 restore 里按比例放好）
          const ed = editorStore.instance
          if (!ed) return
          ed.commands.focus()
          // focus 会把光标滚入视野，重新按比例钉住滚动以免跳动
          applyScrollRatio(editorScrollEl(ed), mem2.scrollRatio)
        }
      })
    }
    // 渲染面板刚从隐藏（source 模式 display:none）转可见：CodeMirror 需要
    // 重新测量（隐藏期间宽度为 0，行号/视口尺寸会失真）
    if (mode !== 'source') {
      requestAnimationFrame(() => measureAllCodeBlocks())
    }
  },
  { immediate: true }
)

// 外部文件拖放打开（文件系统逻辑，与内核无关）
// 落点规则与「打开文件 / Ctrl+O」完全一致，统一在 lib/openFile.ts：无工作区 → 本窗口
// 打开并把侧栏切到该文件的文件夹；已有工作区 → 新窗口打开；已打开同一个文件 → 不重复。
async function onDrop(e: DragEvent): Promise<void> {
  /**
   * 先看内层有没有**已经处理**这次拖放（审计 §7 复查发现的疑似缺陷）。
   *
   * 图片粘贴/拖入是内核的 `handleDrop`（`lib/editor/imagePaste.ts`）在做事，它会
   * `preventDefault` 但**不 stopPropagation**，事件继续冒泡到这里；而这里只认 .md/.txt 后缀，
   * 于是把一张 png 拖进编辑区会得到两个结果：图片真的插进去了，**同时**弹一条
   * 「不支持的文件类型」。`defaultPrevented` 就是"内层已经认领"的信号。
   */
  if (e.defaultPrevented) return
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const path = window.luminAPI.file.getPathForFile(file)
  if (!path) return
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) {
    ui.toast(i18n.global.t('toast.unsupportedFile'), 'error')
    return
  }
  if (!(await confirmIfDirty())) return
  // 拖放的路径只有渲染层拿得到 → 先向主进程登记一次**只读**授权（见 services/pathGrants 的说明：
  // 授权闸默认只放行工作区 / 用户选过 / 会话说 / 打开过的路径，不登记就会打不开）
  if (!(await window.luminAPI.file.authorizeUserPath(path))) {
    ui.toast(i18n.global.t('toast.openFailed'), 'error')
    return
  }
  await openExternalFile(path)
}
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

// ─── 草稿恢复弹窗：焦点 / Tab 循环 / 「不选就不能编辑」的按键闸门 ───────────────
//
// 用户口径：这条提示改成**独立弹窗**，不做出选择就不能继续编辑这个文档。
// 按键闸门挂在 document 的**捕获阶段**，所以 wysiwyg 的 ProseMirror 与源码面的 textarea
// 都被挡住，不需要分别去 disable 两个编辑器；只放行 Tab（焦点循环）与回车/空格（按钮自身激活）。
const draftRestoreRef = ref<HTMLButtonElement | null>(null)
const draftDiscardRef = ref<HTMLButtonElement | null>(null)

function blockDraftKeys(e: Event): void {
  if (!files.draftRestore) return
  // 键盘：只放行 Tab（焦点循环）与回车/空格（按钮自身激活）；Esc 也吞掉（必须明确选一个）
  if (e instanceof KeyboardEvent) {
    const key = e.key
    if (key === 'Tab' || key === 'Enter' || key === ' ' || key === 'Spacebar') return
  }
  e.preventDefault()
  e.stopPropagation()
}

/**
 * 未做选择前，任何**写入途径**都要挡住 —— 只挡键盘是不够的：
 * IME 组字、粘贴、拖放、以及 CDP 的 `Input.insertText` 都不产生 keydown，
 * 却都能把内容写进文档（实测就是这条把 `modal-blocks-editing-until-chosen` 打红了）。
 * 所以除了按键闸门，还要：
 *   * `setEditable(false)` —— 渲染面的 ProseMirror（DOM 变 contenteditable=false，浏览器不再接受输入）；
 *   * 源码面 textarea 加 `:readonly`（见模板）；
 *   * 捕获阶段一并吞掉 beforeinput / paste / cut / drop。
 */
function blockDraftWrites(e: Event): void {
  if (!files.draftRestore) return
  e.preventDefault()
  e.stopPropagation()
}

const DRAFT_WRITE_EVENTS = ['beforeinput', 'paste', 'cut', 'drop'] as const

/**
 * Tab 只在两个按钮之间循环（提示里没有别的可聚焦元素，别让焦点跑到工具栏上）。
 *
 * ⚠️ 本轮补齐：原来只写了「恢复 —Tab→ 丢弃」与「丢弃 —Shift+Tab→ 恢复」两条**边**，
 * 于是在「丢弃」上按 Tab 什么都不发生（焦点卡在原地，用键盘的人会以为控件坏了）。
 * 现在首尾相接成真正的循环 —— 与 `ModalHost.vue` 的 `trapTab` 同一套语义（提示内可聚焦
 * 元素环），两个提示的 Tab 行为第一次完全一致。
 */
function onDraftModalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const list = [draftDiscardRef.value, draftRestoreRef.value].filter(
    (el): el is HTMLButtonElement => !!el && !el.disabled
  )
  if (list.length < 2) return
  const idx = list.indexOf(document.activeElement as HTMLButtonElement)
  e.preventDefault()
  if (idx === -1) {
    ;(e.shiftKey ? list[list.length - 1] : list[0]).focus()
    return
  }
  list[(idx + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus()
}

watch(
  () => !!files.draftRestore,
  (open) => {
    if (open) {
      // 焦点默认给「恢复」→ 回车即恢复（危险动作「丢弃」不占默认焦点）
      void nextTick(() => draftRestoreRef.value?.focus())
      document.addEventListener('keydown', blockDraftKeys, true)
      for (const name of DRAFT_WRITE_EVENTS) document.addEventListener(name, blockDraftWrites, true)
    } else {
      document.removeEventListener('keydown', blockDraftKeys, true)
      for (const name of DRAFT_WRITE_EVENTS)
        document.removeEventListener(name, blockDraftWrites, true)
    }
    // 渲染面：弹窗开着时不可编辑（DOM 层面就拒绝输入，连 IME/粘贴都进不来）
    editorStore.instance?.setEditable(!open)
  },
  { immediate: true }
)

onMounted(() => {
  editorStore.setActive(ui.editorMode !== 'source')
  registerEditorFlush(flushWysiwyg)
  // ⚠️ **启动期间不要开这份占位缓冲**（`ui.booting` 为真 = 会话恢复还没跑完）：
  // 这里开出来的空白缓冲区会去查一次「无主草稿」，于是可能把「未保存的草稿」弹窗拉起来；
  // 紧接着会话恢复打开真正的文档（`openPath` 里会把 `draftRestore` 清空）⇒ 弹窗**闪一下就不见**。
  // 用户报的就是这个：打开应用有概率闪一个草稿提示。
  // 交给 main.ts 在会话恢复**之后**决定：有会话文档就用它，没有才补一份空白缓冲（见 main.ts 末尾）。
  if (!files.current && !ui.booting) void files.openUntitled()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', blockDraftKeys, true)
  for (const name of DRAFT_WRITE_EVENTS) document.removeEventListener(name, blockDraftWrites, true)
  // ⚠️ 顺序：**不能**先摘登记再 flushAll —— flushAll 自己要在最前面刷一次编辑器
  // （防抖窗口里的输入否则既不落盘也不写草稿）。所以这里交给它收尾，
  // 并按**身份**摘掉登记（用户快速 /about → /editor 往返时，新实例已经登记过自己的了，
  // 无脑置 null 会把新实例的登记抹掉）。
  void files.flushAll().finally(() => {
    if (currentEditorFlush() === flushWysiwyg) registerEditorFlush(null)
  })
})
</script>

<template>
  <div
    class="relative flex h-full min-h-0 flex-col"
    :class="{ 'split-dragging': splitDragging }"
    @drop.prevent="onDrop"
    @dragover="onDragOver"
  >
    <!-- 快捷工具栏：可在设置（编辑器 → 快捷工具栏）或工具栏空白区右键菜单里关掉；
         关掉后这里是「一片空的编辑区」，不占高度。
         **专注模式下一并隐藏**（用户口径：本产品定位是「纸面优先」的 Typora 式写作，
         而专注模式此前只收窄正文列 + 压暗侧栏，最显眼的 44px 常驻 chrome 却留着 ——
         名不副实）。
         ⚠️ 但"隐藏工具栏"会把它**自己的退出开关**一起藏掉（那枚开关就在工具栏里）——
         报告 §5.2 P0-2 实测：原注释声称"状态栏「专注」也能切回来"，而状态栏里并没有这个入口。
         真正的退路只有 Ctrl+Shift+F 与两张菜单（原生菜单恒在）。所以专注模式下另给一枚
         **悬浮退出胶囊**（见下面 `.focus-exit`）：鼠标用户不必记快捷键，键盘用户 Tab 一下就到。 -->
    <Toolbar v-if="settings.toolbarVisible && !ui.focusMode" />

    <!-- 专注模式的悬浮退出（报告 §5.2 P0-2）：右下角一枚半透明胶囊，悬停变实。
         位置右下是为了不压正文（专注模式下正文居中）；它只在 focusMode 时存在。 -->
    <button
      v-if="ui.focusMode"
      class="focus-exit"
      :title="i18n.global.t('editor.focusExit')"
      :aria-label="i18n.global.t('editor.focusExit')"
      data-focus-exit
      @click="ui.focusMode = false"
    >
      <Icon name="x" :size="13" />
      <span>{{ i18n.global.t('editor.focusExit') }}</span>
    </button>

    <!-- 通知中心：**编辑区上方**（像 Typora），紧接工具栏之下、内核之上 —— 文档流里的一块，
         长通知不会被窗口底边裁掉，也不再挤在底部栏旁边。进出场动画见 overlays.css 的 `.ntf-*`。
         ⚠️ 草稿提示**不在这里**：它已经改成独立弹窗（见下面的 `.draft-modal`），
         因为「当前内容和磁盘不一样」这件事必须先做选择，不能和通知混在一起。 -->
    <NotificationCenter />

    <!-- 编辑器内核：渲染面板与源码面板常驻，模式切换仅改布局/显隐（零重建） -->
    <!-- view-restoring：恢复位置期间隐藏内容区，避免「旧位置先闪现→跳转」的抖动 -->
    <!-- 写作区 = 纸（--paper）：两个 pane 各自整块铺纸，于是 wysiwyg / split / source
         三种模式下「纸」都是同一个矩形，切换模式不会看见底色跳变；pane 之间的分屏
         缝隙仍露出外壳灰（--app），正好充当分隔线。 -->
    <!-- data-editor-kernel：写作区的语义锚点。查找/替换浮条按它的顶边定位 —— 工具栏可被设置
         隐藏、菜单栏在 Windows 上也可能不显示，写死像素就会压住工具栏（用户报过这个 bug）。
         ⚠️ 这一行是「编辑区 + 右侧大纲」的**横排容器**：三栏模式（设置里打开
         「大纲放在编辑区右侧」）下右侧多一块 `OutlinePanel`，内核本身照旧 flex-1。
         内核的定位语义（`data-editor-kernel`）没变，所以查找栏/各套件的锚点选择器不受影响。 -->
    <div class="flex min-h-0 flex-1">
      <div
        ref="kernelRef"
        data-editor-kernel
        class="relative flex min-h-0 flex-1"
        :class="{ 'view-restoring': viewRestoring }"
        @scroll.capture="onSplitScroll"
      >
        <!-- 渲染面板（Tiptap）：wysiwyg 全宽 / split 左栏 / source 隐藏但常驻。
           ⚠️ **唯一的例外**：重文档降级（见 lib/largeDoc.ts 与本文件 skipRenderPane）——
           代码围栏是唯一的性能悬崖（实测 500 块 → 22.8s 打开 / 1500 块 → >185s 且常驻 1.4GB），
           而「隐藏但常驻」意味着即使切到源码模式，那 500 个 CodeMirror 实例照样会被建出来
           （实测降级后仍是 500 实例 / 14.7s / 1.6GB）。所以这种情况**整块不挂载**。 -->
        <div
          v-if="!skipRenderPane"
          ref="renderPaneRef"
          class="h-full min-w-0 bg-paper"
          @contextmenu="onRenderContextMenu"
        >
          <TyporaEditor
            ref="renderRef"
            :key="files.current?.path ?? 'untitled'"
            :model-value="files.current?.content ?? ''"
            @update:model-value="onEditorUpdate"
          />
        </div>

        <!-- 分屏分隔条（仅 split 存在；拖动时显示拖拽态）
           绝对定位浮层：位置由 --split-left（比例）驱动，不参与两侧栏的 flex 布局。
           键盘路径见 onSplitKeydown：它是 role="separator" 的**可聚焦** widget（ARIA APG
           window splitter），所以必须有 aria-valuenow/min/max 与方向键支持 -->
        <div
          v-if="ui.editorMode === 'split'"
          class="split-divider"
          :class="{ dragging: splitDragging }"
          :style="{ '--split-left': `${splitRatio * 100}%` }"
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          :aria-label="i18n.global.t('editor.splitDividerTitle')"
          :aria-valuemin="25"
          :aria-valuemax="75"
          :aria-valuenow="Math.round(splitRatio * 100)"
          :title="i18n.global.t('editor.splitDividerTitle')"
          @mousedown="startSplitDrag"
          @dblclick="resetSplitRatio"
          @keydown="onSplitKeydown"
        >
          <span />
        </div>

        <!-- 源码面板（textarea）：split 右栏 / source 全宽 / wysiwyg 隐藏但常驻 -->
        <div ref="sourcePaneRef" class="h-full min-w-0 overflow-hidden bg-paper">
          <div class="h-full">
            <div class="h-full" :class="sourceCenterClass()">
              <textarea
                ref="sourceRef"
                class="source-editor"
                :class="{ 'source-editor--split': ui.editorMode === 'split' }"
                :value="files.current?.content ?? ''"
                spellcheck="false"
                :readonly="!!files.draftRestore"
                @input="onSourceInput"
                @keydown.tab="onSourceTab"
                @click="updateSourceCursor($event.target as HTMLTextAreaElement)"
                @keyup="updateSourceCursor($event.target as HTMLTextAreaElement)"
                @select="updateSourceCursor($event.target as HTMLTextAreaElement)"
              />
            </div>
          </div>
        </div>

        <!-- 同步滚动开关（分屏专属悬浮芯片，SQLite kv 持久化） -->
        <button
          v-if="ui.editorMode === 'split'"
          class="split-sync-chip"
          :class="{ active: settings.syncScroll }"
          :title="
            i18n.global.t(settings.syncScroll ? 'editor.syncScrollOn' : 'editor.syncScrollOff')
          "
          @click="toggleSyncScroll"
        >
          <Icon name="sync-scroll" :size="13" />
          <span>{{ i18n.global.t('settings.syncScroll') }}</span>
          <span v-if="settings.syncScroll" class="split-sync-dot" />
        </button>
      </div>

      <!-- 右侧大纲（三栏模式）：设置里打开「大纲放在编辑区右侧」时才出现。
           它与左侧文件树同时可见，自身可折叠/展开（见 OutlinePanel.vue）。 -->
      <OutlinePanel v-if="settings.outlineOnRight" />
    </div>

    <StatusBar />

    <!-- ── 草稿恢复提示（文件状态逻辑，与内核无关）─────────────────────────────
         触发条件不变：打开文档时发现「当前内容与磁盘不一致」的未保存草稿（`files.draftRestore`）。
         用户口径（本轮）：**和上面那个确认提示同一套形态** —— 不弹居中窗口、不模糊主界面，
         而是贴在应用顶部的提示条（`.lm-prompt` / `.lm-prompt__card`，见 overlays.css）；
         不做出选择就不能继续编辑这个文档。所以这里：
           * 不是通知、不进 NotificationCenter、也不与通知带混排；
           * 提示之外**点击不关闭**（`@click.self` 里什么都不做）、Esc 不关闭 —— 必须明确选一个；
           * 打开时把焦点给「恢复」（回车即恢复），Tab 只在两个按钮之间循环；
           * `blockDraftKeys` 在捕获阶段吞掉除 Tab/回车/空格外的一切按键 —— 渲染面与源码面
             （textarea）两种编辑态都挡得住，不需要分别去 disable 两个编辑器。
           * 提示之外的区域是**透明命中目标**（`.lm-prompt` 的 `inset: 0`）：点正文既不动光标、
             也不选中（背景 inert），但主界面完全看得见、也不再被压暗/糊掉。 -->
    <Teleport to="body">
      <Transition name="fade">
        <!-- ⚠️ `&& !ui.booting`：**启动期间一律不渲染草稿弹窗**（用户报障的收口那一刀）。
             启动时 `draftRestore` 可能被抢先置上（占位缓冲的草稿检查 / 会话恢复的草稿检查），
             紧接着又被 `openPath` 清掉 —— 结果就是弹窗**闪一下（<0.5s）就消失**。
             这里不赌"谁先谁后"：初始化没结束就不弹；等 `booting` 落下（main.ts 会话恢复跑完），
             草稿若仍挂着，它才出现 —— 那才是真需要用户决定的那一次。
             另两处配套：EditorView 启动期间不开占位缓冲、main.ts 在会话恢复之后再补空白缓冲。 -->
        <div
          v-if="files.draftRestore && !ui.booting"
          class="draft-modal lm-prompt z-[var(--z-critical)]"
          data-top-prompt
          role="dialog"
          aria-modal="true"
          aria-labelledby="draft-modal-title"
        >
          <Transition name="lm-prompt-drop" appear>
            <div class="lm-prompt__card" @keydown="onDraftModalKeydown">
              <div class="mb-2 flex items-center gap-3">
                <div
                  class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent"
                >
                  <Icon name="info" :size="17" />
                </div>
                <h3
                  id="draft-modal-title"
                  class="min-w-0 text-[15px] font-semibold break-words text-ink"
                >
                  {{ i18n.global.t('editor.draftTitle') }}
                </h3>
              </div>
              <p class="mb-2 text-[13px] leading-relaxed break-words text-ink">
                {{
                  files.draftRestore.path
                    ? i18n.global.t('editor.restoreDraft')
                    : i18n.global.t('editor.restoreDraftUntitled')
                }}
              </p>
              <p class="mb-4 text-ui leading-relaxed break-words text-ink-2b">
                {{ i18n.global.t('editor.draftHint') }}
              </p>
              <div class="flex justify-end gap-2">
                <button
                  ref="draftDiscardRef"
                  class="btn btn-ghost px-4 py-2"
                  @click="files.applyDraftRestore(false)"
                >
                  {{ i18n.global.t('common.discard') }}
                </button>
                <button
                  ref="draftRestoreRef"
                  class="btn btn-primary px-4 py-2"
                  @click="files.applyDraftRestore(true)"
                >
                  {{ i18n.global.t('common.restore') }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
