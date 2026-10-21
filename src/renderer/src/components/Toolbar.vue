<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Editor } from '@tiptap/core'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import { useOutlineSide } from '../composables/useOutlineSide'
import Icon from './Icon.vue'
import SegmentedControl, { type SegmentItem } from './SegmentedControl.vue'
import ToolbarTableButton from './ToolbarTableButton.vue'
import ToolbarCodeBlockButton from './ToolbarCodeBlockButton.vue'
import { shouldCloseOnScrollOrResize } from '../lib/popoverClose'
import { insertImageFromPath, insertImageFromUrl } from '../lib/insertImage'
import { insertOrEditLink } from '../lib/linkInsert'
import { selectionHasMdStyle } from '../lib/editor/inlineMarks'
import {
  DEFAULT_TOOLBAR_ITEMS,
  insertToolbarItemByOrder,
  sanitizeToolbarItems,
  toolbarItemDef,
  type ToolbarItemDef
} from '../../../shared/toolbarItems'

// ─── 编辑器工具栏：命令通过 editor store 桥接 Tiptap 内核（解耦）────────────
// 项目与顺序由 settings.toolbarItems 决定（目录见 shared/toolbarItems.ts）：
// 渲染时先清洗一遍再补上图标/文案，因此旧版本残留的 id、手改坏的重复项都不会把
// 工具栏画歪。分组只在渲染时决定分隔线位置（见 groupChanged 的说明）。
const { t } = useI18n()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport } = useExport()
const { setMode } = useEditorMode()

/** 分段控件的段定义：文案走 i18n，提示里带上循环切换的快捷键（Ctrl+/） */
const modeItems = computed<SegmentItem[]>(() =>
  (
    [
      { id: 'wysiwyg', icon: 'eye', labelKey: 'editor.wysiwyg' },
      { id: 'split', icon: 'columns', labelKey: 'editor.split' },
      { id: 'source', icon: 'source', labelKey: 'editor.source' }
    ] as const
  ).map((m) => ({
    id: m.id,
    icon: m.icon,
    label: t(m.labelKey),
    title: `${t(m.labelKey)} (Ctrl+/)`
  }))
)

/** v-model 桥接：写回时走 useEditorMode（它负责 mode → ui/editor 的联动），不直接改 ui */
const editorModeValue = computed({
  get: () => ui.editorMode,
  set: (v: string) => setMode(v as 'wysiwyg' | 'source' | 'split')
})

// ─── 大纲位置（左侧边栏 ⇄ 编辑区右侧）─────────────────────────────────────────
// 视图区里的第三枚开关（另外两枚是侧边栏与专注模式）。实现只有一份（useOutlineSide），
// 顶部「视图」菜单、原生菜单/快捷键、设置面板都指向同一处。
//
// 为什么是**状态开关**而不是第二枚分段控件（左/右）：
//   * 工具栏里已经有一枚三段分段控件（模式），再摆一枚两段的会两个控件互相抢视觉；
//   * 语义与旁边的侧边栏开关同类（点一下翻一个二值状态，active 高亮 = 当前开着），口径一致；
//   * 分段控件的"两处使用"是既有验收口径（`_verify-segmented-control.js` 断言 `.seg` 恰好两处）。
const { onRight: outlineOnRight, toggleOutlineSide } = useOutlineSide()
/** 提示文案跟着状态走：说的是**下一步会发生什么**（active 高亮则说明"现在在大纲在右侧"） */
const outlineSideTitle = computed(() =>
  outlineOnRight.value ? t('outline.toLeft') : t('outline.toRight')
)

/** 当前生效的快捷项（已清洗）：settings 是唯一真源，不另立一份 ui 状态 */
const items = computed<ToolbarItemDef[]>(() =>
  sanitizeToolbarItems(settings.toolbarItems)
    .map((id) => toolbarItemDef(id))
    .filter((d): d is ToolbarItemDef => !!d)
)

/** 与上一项分组不同 → 画分隔线（第一项不画） */
function groupChanged(index: number): boolean {
  if (index <= 0) return false
  return items.value[index - 1].group !== items.value[index].group
}

/** 提示文案：标题带序号，其余直接用项目自己的 i18n key */
function titleOf(d: ToolbarItemDef): string {
  return d.level ? `${t(d.labelKey)} ${d.level}` : t(d.labelKey)
}

// ─── 空白区右键菜单 ────────────────────────────────────────────────────────
// 「空白区域」= 工具栏里没有落在任何一个项目按钮上的位置（右侧弹簧区、分组之间、
// 单项被隐藏后留下的空档）。判定用 data-toolbar-item：凡项目根节点都带这个属性，
// 右键落在它内部时交给项目自身（与按钮的左键行为一致），不弹工具栏菜单。
function isOnItem(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('[data-toolbar-item]')
}

/**
 * 工具栏空白区右键：一级给两个动作，二级展开「显示的项目」勾选列表。
 * 用现成的通用右键菜单（ui.openContextMenu）而不是另起一套：位置钳制、外部点击
 * 关闭、Esc 关闭都在 ContextMenu.vue 里，这里只负责给出条目。
 *
 * 二级做成「勾选当前显示的项目」而不是四组行：既避免在菜单里再引一层分组概念，
 * 也让「关掉这个按钮」这一最常用的操作一步可达（未勾选项仍在，勾上即回来）。
 */
function onToolbarContextMenu(e: MouseEvent): void {
  if (isOnItem(e.target)) return
  e.preventDefault()
  ui.openContextMenu({
    x: e.clientX,
    y: e.clientY,
    ariaLabel: 'toolbar-menu',
    items: [
      {
        action: 'toolbar.hide',
        label: t('toolbar.hide'),
        icon: 'x',
        danger: true
      },
      {
        action: 'toolbar.adjust',
        label: t('toolbar.adjust'),
        icon: 'settings',
        // 共用一个子菜单容器：children 由 ContextMenu.vue 惰性渲染
        children: () => {
          const current = new Set(sanitizeToolbarItems(settings.toolbarItems))
          const list = catalogOrder.value
          const shown = list.filter((d) => current.has(d.id))
          const hidden = list.filter((d) => !current.has(d.id))
          // 已显示的排前面且带勾：右键菜单里最常用的是「关掉某一个」
          return [...shown, ...hidden].map((d) => ({
            action: `toolbar.toggle.${d.id}`,
            label: titleOf(d),
            icon: d.icon,
            checked: current.has(d.id)
          }))
        }
      }
    ],
    onSelect: (action) => {
      if (action === 'toolbar.hide') {
        settings.set('toolbarVisible', false)
        return
      }
      if (action === 'toolbar.adjust') {
        ui.openToolbarAdjust()
        return
      }
      if (!action.startsWith('toolbar.toggle.')) return
      toggleItem(action.slice('toolbar.toggle.'.length))
    }
  })
}

/** 目录顺序（出厂顺序）：右键子菜单按它列出所有项目 */
const catalogOrder = computed<ToolbarItemDef[]>(() =>
  DEFAULT_TOOLBAR_ITEMS.map((id) => toolbarItemDef(id)).filter((d): d is ToolbarItemDef => !!d)
)

/** 勾选/取消一个项目：在「显示集合」里加或减，新增项按出厂顺序落位 */
function toggleItem(id: string): void {
  const current = sanitizeToolbarItems(settings.toolbarItems)
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : insertToolbarItemByOrder(current, id)
  settings.set('toolbarItems', next)
}

// ─── 编辑器命令 ────────────────────────────────────────────────────────────
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
    // 用**语义锚点**判断「点到的是不是本菜单自己的弹层」：原判据是 Tailwind 生成的
    // 类名 `.fixed.z-\[100\]`，而表格选择器与代码块弹层用的是同一串类名 ——
    // 点它们会顺手把导出菜单一起收掉（审计 F8）。这里改成各自的数据锚点。
    const panel = (e.target as HTMLElement).closest?.('[data-export-pop], [data-export-pop-anchor]')
    if (!panel) exportOpen.value = false
  }
}
/** 滚动/缩放收起导出菜单：菜单内部滚动不收起（见 lib/popoverClose.ts） */
function onWindowScrollOrResize(e: Event): void {
  if (!exportOpen.value) return
  const panel = document.querySelector<HTMLElement>('[data-export-pop]')
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

/** 工具栏隐藏时把导出弹层一起收掉（否则它会孤零零浮在文档上） */
watch(
  () => settings.toolbarVisible,
  (v) => {
    if (!v) exportOpen.value = false
  }
)

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

// ─── 单项状态 ──────────────────────────────────────────────────────────────
// disabled：做不了。这类项目灰着显示而不是消失——位置若随状态进出而跳动（比如回退栈
//   空时整个按钮不见了），用户会以为按钮丢了。
// active：当前选区处在该项目对应的格式里。
function isDisabled(id: string): boolean {
  void editorStore.tick
  const ed = editorStore.instance
  // 侧边栏开关是纯界面动作，源码模式下也照常可用
  if (id === 'sidebar') return false
  if (!ed) return true // 源码模式：instance 为 null，编辑器命令全部不可用
  if (id === 'undo') return !canUndo()
  if (id === 'redo') return !canRedo()
  return false
}

function isItemActive(id: string): boolean {
  switch (id) {
    case 'h1':
      return isActive('heading', { level: 1 })
    case 'h2':
      return isActive('heading', { level: 2 })
    case 'h3':
      return isActive('heading', { level: 3 })
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return isMdActive(id)
    case 'quote':
      return isActive('blockquote')
    case 'ul':
      return isActive('bulletList')
    case 'ol':
      return isActive('orderedList')
    case 'task':
      return isActive('taskList')
    case 'codeblock':
      return isActive('codeBlock')
    default:
      return false
  }
}

function runItem(id: string): void {
  switch (id) {
    case 'sidebar':
      toggleSidebar()
      return
    case 'undo':
      editorStore.instance?.chain().focus().undo().run()
      return
    case 'redo':
      editorStore.instance?.chain().focus().redo().run()
      return
    case 'h1':
      return toggleHeading(1)
    case 'h2':
      return toggleHeading(2)
    case 'h3':
      return toggleHeading(3)
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return runInline(id)
    case 'quote':
    case 'ul':
    case 'ol':
    case 'task':
      return runBlock(id)
    case 'hr':
      // 工具栏不再放分割线按钮（与手打 `---`+Enter、顶部菜单栏、右键菜单等价，
      // 见 shared/toolbarItems.ts 的说明）；旧设置里残留的 id 落到这里就是无操作。
      return
    case 'link':
      return addLink()
    case 'image':
      return addImage()
    case 'toc':
      return insertToc()
  }
}

function runInline(cmd: 'bold' | 'italic' | 'strike' | 'code'): void {
  const ed = editorStore.instance
  if (!ed) return
  const chain = ed.chain().focus()
  if (cmd === 'bold') chain.toggleMdBold().run()
  else if (cmd === 'italic') chain.toggleMdItalic().run()
  else if (cmd === 'strike') chain.toggleMdStrike().run()
  else chain.toggleMdCode().run()
}

/** 行内样式激活态（真实文本标记模型：mdStyle mark） */
function isMdActive(cmd: 'bold' | 'italic' | 'strike' | 'code'): boolean {
  void editorStore.tick
  const ed = editorStore.instance
  if (!ed) return false
  const kind =
    cmd === 'bold' ? 'bold' : cmd === 'italic' ? 'italic' : cmd === 'strike' ? 'strike' : 'code'
  try {
    return selectionHasMdStyle(ed, kind)
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

/** 在光标处插入文档目录 */
function insertToc(): void {
  const ed = editorStore.instance
  if (!ed) return
  // 光标在段落中间时先落到块首，再插入独立的目录块
  ed.chain().focus().insertTableOfContents().run()
}

function addLink(): void {
  // store 里的 instance 经 Vue 响应式包装后，类型上丢了 Editor 的私有成员
  // （css/className/editorView…）；运行时它就是 markRaw 的原始实例，故此处断言
  // （与 stores/editorMenu.ts 的 buildSections 同一处口径）
  const ed = editorStore.instance as Editor | null
  if (!ed) return
  // 插入 / 编辑链接的规则只有一份（lib/linkInsert.ts，右键菜单那条入口共用它）：
  //   有选区 → 弹窗只要链接（锚文字 = 选中的文字）；
  //   无选区 → 弹窗要锚文字 + 链接（锚文字留空则以链接地址作锚文字）；
  //   光标在既有链接上 → 同一个弹窗进入「编辑」语义（预填 + 可移除）。
  // 文案（标题/占位/错误提示）都由 ModalHost 按 ui.linkState 的键取，不再在这里传字符串。
  void insertOrEditLink(ed, (req) => ui.promptLink(req))
}

function addImage(): void {
  const ed = editorStore.instance
  if (!ed) return
  const insert = (src: string): void => {
    ed.chain().focus().setImage({ src }).run()
  }
  // 三条入口：贴过来的图/拖进来的图由编辑区自己接管（lib/editor/imagePaste），
  // 按钮这里给两个选择 —— 选本地文件（复制进工作区 assets/）或手打远程 URL。
  // 之前只有"输入 URL"一条路，剪贴板与本地文件都无处可去（审计 §7 第 16 条）。
  const el = document.querySelector('[data-toolbar-item-id="image"]')
  const r = el?.getBoundingClientRect()
  ui.openContextMenu({
    x: Math.round(r?.left ?? 120),
    y: Math.round((r?.bottom ?? 80) + 4),
    ariaLabel: t('editorMenu.imagePrompt'),
    items: [
      { label: t('editor.imageFromFile'), icon: 'folder', action: 'image-file' },
      { label: t('editor.imageFromUrl'), icon: 'link', action: 'image-url' }
    ],
    onSelect: (action) => {
      if (action === 'image-file') {
        void window.luminAPI.file
          .chooseImage()
          .then((path) => (path ? insertImageFromPath(insert, path) : false))
      } else {
        void ui
          .prompt(t('editorMenu.imagePrompt'), t('editorMenu.imagePlaceholder'))
          .then((src) => {
            if (src) insertImageFromUrl(insert, src)
          })
      }
    }
  })
}

const exportItems: { icon: string; labelKey: string; format: 'pdf' | 'html' | 'word' | 'epub' }[] =
  [
    { icon: 'file', labelKey: 'editor.exportPdf', format: 'pdf' },
    { icon: 'code', labelKey: 'editor.exportHtml', format: 'html' },
    { icon: 'file', labelKey: 'editor.exportWord', format: 'word' },
    { icon: 'book', labelKey: 'editor.exportEpub', format: 'epub' }
  ]
</script>

<template>
  <!-- 底色 = **纸**（`bg-paper`，与编辑区同一个颜色；用户口径，见 §4.82）：
       浅色主题下与写作区同为纯白，深色 / 羊皮纸主题各自跟随 `--paper`，
       所以口径是"与编辑区同色"而不是写死 #fff。 -->
  <div
    class="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge bg-paper px-3"
    data-editor-toolbar
    @mousedown.prevent
    @contextmenu="onToolbarContextMenu"
  >
    <!-- 快捷项：顺序 / 显隐完全由 settings.toolbarItems 驱动。
         分组不同的相邻两项之间画一条竖分隔线（见 script 里的 groupChanged）。 -->
    <template v-for="(d, i) in items" :key="d.id">
      <div v-if="groupChanged(i)" class="mx-1.5 h-5 w-px shrink-0 bg-edge" />

      <!-- 侧边栏开关：自己管理状态（与菜单栏/状态栏共用同一份持久化） -->
      <button
        v-if="d.id === 'sidebar'"
        class="icon-btn"
        data-toolbar-item
        :title="t('menu.toggleSidebar') + ' (Ctrl+Shift+B)'"
        :aria-label="t('menu.toggleSidebar')"
        @click="toggleSidebar"
      >
        <Icon name="panel-left" :size="16" />
      </button>

      <!-- 段落 / 代码块：自带悬停弹层，单独两个组件 -->
      <ToolbarTableButton v-else-if="d.id === 'table'" data-toolbar-item />
      <ToolbarCodeBlockButton v-else-if="d.id === 'codeblock'" data-toolbar-item />

      <!-- 其余项目：一条通用渲染路径（图标 + 序号 + 激活态 + 禁用态）。
          同时给 title 与 aria-label：全局 tooltip 悬停时会**摘掉 title**
          再自己画一层，屏读器那时就读不到可访问名了（审计 F4）。 -->
      <button
        v-else
        class="icon-btn"
        data-toolbar-item
        :data-toolbar-item-id="d.id"
        :class="{ active: isItemActive(d.id) }"
        :disabled="isDisabled(d.id)"
        :title="titleOf(d)"
        :aria-label="titleOf(d)"
        @click="runItem(d.id)"
      >
        <Icon :name="d.icon" :size="15" />
        <!-- 标题按钮的层级已经画在图标里（heading-1/2/3 = H + 数字同一套描边），
             不再额外拼一个数字 span —— 那会造成字重/基线不一致（详见 Icon.vue 的注释）。
             层级信息仍在 title/aria-label 里（见 titleOf）。 -->
      </button>
    </template>

    <!-- 编辑器模式：实时渲染 / 分屏对比 / 源码。
         主控控件放左侧主功能区：右侧文档信息区在窄窗口会被
         overflow-x-auto 裁掉，模式切换必须永远可见。
         分段控件只显示图标（文案在 title/aria-label 上）+ 滑动指示块，比三个文字
         按钮更简约；具体说明悬停即得，模式本身看指示块位置与图标配色。 -->
    <div v-if="items.length" class="mx-1.5 h-5 w-px shrink-0 bg-edge" />
    <SegmentedControl
      v-model="editorModeValue"
      :items="modeItems"
      :group-label="t('editor.viewMode')"
      class="mx-1"
      data-toolbar-item
    />

    <!-- 大纲位置（左栏 ⇄ 编辑区右侧）：视图工具区的第三枚开关。
         固定入口，不参与工具栏项目的排序/隐藏 —— 位置类开关一旦被隐藏，
         用户就再也找不到「把大纲搬回来」的那条路（与右侧固定入口同一考量）。 -->
    <div class="mx-1.5 h-5 w-px shrink-0 bg-edge" />
    <button
      class="icon-btn"
      :class="{ active: outlineOnRight }"
      :title="outlineSideTitle"
      :aria-label="outlineSideTitle"
      :aria-pressed="outlineOnRight ? 'true' : 'false'"
      data-outline-side
      @click="toggleOutlineSide()"
    >
      <Icon name="outline-panel" :size="15" />
    </button>

    <!-- 右侧弹簧区：这里是「空白区域」右键菜单最常用的落点 -->
    <div class="min-w-2 flex-1" data-toolbar-item />

    <!-- 右侧固定入口：不参与排序/隐藏（避免把工具栏调成「没法切模式、没法导出」）。
         不加 data-toolbar-item：它们与弹簧区一样属于「非快捷项」，右键与四周的空白同义 -->
    <button
      class="icon-btn"
      :class="{ active: ui.focusMode }"
      :title="t('editor.focus') + ' (Ctrl+Shift+F)'"
      :aria-label="t('editor.focus')"
      @click="ui.focusMode = !ui.focusMode"
    >
      <Icon name="maximize" :size="15" />
    </button>

    <div class="mx-1 h-5 w-px shrink-0 bg-edge" />

    <!-- 导出（固定入口，不参与排序） -->
    <div ref="exportRef" class="relative shrink-0">
      <button
        class="icon-btn"
        :class="{ active: exportOpen }"
        :title="t('editor.export')"
        :aria-label="t('editor.export')"
        :aria-expanded="exportOpen"
        aria-haspopup="menu"
        data-export-pop-anchor
        @click="toggleExport"
      >
        <Icon name="download" :size="15" />
      </button>
    </div>

    <button
      class="icon-btn"
      :title="t('settings.title')"
      :aria-label="t('settings.title')"
      @click="ui.openSettings()"
    >
      <Icon name="settings" :size="15" />
    </button>

    <!-- 导出弹层：Teleport 到 body 固定定位。
         工具栏是 overflow-x-auto 滚动容器，普通 absolute 弹层会被裁剪
         （层级/裁切错乱），与表格选择器同款的 body 传送方案 -->
    <Teleport to="body">
      <Transition name="pop">
        <div
          v-if="exportOpen"
          class="export-pop fixed z-[var(--z-popover)] w-[190px] rounded-xl border border-edge bg-elevate p-1.5"
          data-export-pop
          :style="{
            boxShadow: 'var(--shadow-2)',
            left: exportPos.x + 'px',
            top: exportPos.y + 'px'
          }"
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
