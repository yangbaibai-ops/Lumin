<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import { openExternalFile } from '../lib/openFile'
import {
  activeTreePath,
  focusFirstAvailableRow,
  initRovingFocus,
  onTreeKeydown
} from '../lib/treeFocus'
import TreeNode from './TreeNode.vue'
import FileList from './FileList.vue'
import Icon from './Icon.vue'
import SegmentedControl, { type SegmentItem } from './SegmentedControl.vue'

const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()
const router = useRouter()
const filter = ref('')

/**
 * ─── 文件名搜索：平常收起成一枚放大镜，点开长出输入框 ──────────────────────
 * 用户口径：① 静息态只留一枚图标；② 展开/收起要有好看的动效；
 * ③ **失焦时不能闪烁**（上一版就是两个兄弟元素重叠：按钮立刻出现、旧输入框还在淡出，
 *    两个都占着 flex-1 槽位 → 中间帧抖动）。
 * 这一版结构上只有**一个**会变形的元素（`.file-search` 外壳），放大镜按钮从不卸载，
 * 动画只动外壳的 `width` / 背景色 + 输入框的一次短淡入（见 template 上的说明与 scoped 样式）。
 *
 * 收起规则三条，共同目的是「筛选条件不能悄悄消失」：
 *   * 失焦且输入为空 → 收起；
 *   * 失焦但有内容 → 保持展开（否则条件会被藏进一个看不见的输入框里）；
 *   * `Esc` → 清空并收起；× 只清空、不收起。
 */
const searchOpen = ref(false)
const filterEl = ref<HTMLInputElement | null>(null)

async function openSearch(): Promise<void> {
  searchOpen.value = true
  await nextTick()
  filterEl.value?.focus()
}

/** 放大镜：收起时点开；展开时（它已经是输入框的前缀）点它只是把焦点交给输入框 */
function onSearchIcon(): void {
  if (searchOpen.value) filterEl.value?.focus()
  else void openSearch()
}

function closeSearch(): void {
  filter.value = ''
  searchOpen.value = false
}

function onSearchBlur(): void {
  if (!filter.value) searchOpen.value = false
}

// 离开「文件」页签或关掉工作区时收起：面板是 v-show 常驻的，不收起下次回来会「自己开着」
watch(
  () => [ui.sidebarTab, files.root],
  () => {
    if (ui.sidebarTab !== 'files' || !files.root) {
      filter.value = ''
      searchOpen.value = false
    }
  }
)

/** 侧栏文件视图切换的段定义（与工具栏模式切换共用同一个分段控件） */
const viewItems = computed<SegmentItem[]>(() => [
  { id: 'tree', icon: 'list-tree', label: t('sidebar.viewTree') },
  { id: 'list', icon: 'list', label: t('sidebar.viewList') }
])
const filesViewValue = computed({
  get: () => ui.sidebarFilesView,
  set: (v: string) => (ui.sidebarFilesView = v as 'tree' | 'list')
})
const rootNodes = computed(() => files.dirCache[files.root ?? ''] ?? [])

/**
 * 键盘导航（ARIA tree 模式，实现见 lib/treeFocus.ts）。
 * keydown 挂在容器上（行会冒泡上来）：一行一个监听器在递归组件里没必要。
 *
 * `focusin` 里补一次「落点」：用 Tab 进入树时浏览器会聚焦第一个 tabindex≥0 的元素，
 * 而 roving tabindex 的 0 需要先有落点 —— 首次（activeTreePath 为空）时挑当前文档那一行。
 */
function ensureRovingFocus(): void {
  if (!activeTreePath.value) focusFirstAvailableRow()
}

function handleTreeKeydown(e: KeyboardEvent): void {
  if (onTreeKeydown(e)) e.preventDefault()
}

const filtered = computed(() => {
  if (!filter.value) return rootNodes.value
  return rootNodes.value.filter(
    (n) => n.name.toLowerCase().includes(filter.value.toLowerCase()) || n.type === 'directory'
  )
})

// 树渲染完就挑一个「静息焦点行」（当前文档行，否则第一行）：ARIA tree 随时都得有
// 且只有一个可 Tab 的行，否则 Tab 进来方向键没反应（见 lib/treeFocus.initRovingFocus）。
// 只在「文件」页签可见时做 —— 面板常驻 DOM（v-show），否则切到大纲时这里会去动焦点。
watch(
  [filtered, () => files.root],
  () => {
    if (ui.sidebarTab !== 'files') return
    void nextTick(() => {
      if (ui.sidebarTab !== 'files') return
      initRovingFocus()
    })
  },
  { immediate: true }
)

/**
 * 切回「文件」页签时自愈：目录缓存可能被别处清掉（`setRoot` 清空、`refreshDir` 删掉子级键、
 * 或事件竞态），而本组件**只读缓存、从不自己拉**。缓存空了就重新拉一次根目录 ——
 * 否则会停在「打开着工作区却一个新文件都不显示」，且没有任何恢复路径（用户报的就是这个现象）。
 */
watch(
  () => ui.sidebarTab,
  (tab) => {
    if (tab !== 'files' || !files.root) return
    const root = files.root
    if (!files.dirCache[root]) void files.loadChildren(root)
    void nextTick(() => initRovingFocus())
  }
)

function onRootContextMenu(e: MouseEvent): void {
  if (!files.root) return
  e.preventDefault()
  ui.openContextMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: t('context.newFile'), icon: 'file-plus', action: 'new-file' },
      { label: t('context.newFolder'), icon: 'folder-plus', action: 'new-folder' },
      { label: t('sidebar.refresh'), icon: 'refresh', action: 'refresh' },
      { label: t('sidebar.closeWorkspace'), icon: 'x', action: 'close', danger: true }
    ],
    onSelect: (action) => void handleAction(action)
  })
}

/** 侧栏空态里的三个入口（原欢迎页的能力，见 template 里的空态区块） */
async function newDoc(): Promise<void> {
  if (!(await confirmIfDirty())) return
  await files.newDocInWorkspace()
  await router.push('/editor')
}

async function openFileDialog(): Promise<void> {
  if (!(await confirmIfDirty())) return
  const path = await window.luminAPI.file.chooseOpenFile()
  if (!path) return
  // 落点规则见 lib/openFile.ts（无工作区 → 本窗口 + 侧栏切到该文件的文件夹）
  await openExternalFile(path)
  await router.push('/editor')
}

async function handleAction(action: string): Promise<void> {
  if (!files.root) return
  if (action === 'new-file') {
    // 新建即就地重命名（不再弹窗输名）
    await files.newFileAt(files.root)
  } else if (action === 'new-folder') {
    const name = await ui.prompt(
      t('context.newFolder'),
      t('sidebar.newFolderHint'),
      t('context.newFolder')
    )
    if (name) await files.createDirAt(files.root, name)
  } else if (action === 'refresh') {
    await files.refreshDir(files.root)
  } else if (action === 'close') {
    await files.setRoot(null)
    ui.toast(t('toast.workspaceClosed'), 'success')
  }
}

function onDrop(e: DragEvent): void {
  // 从外部拖入文件 → 交给全局处理
  e.preventDefault()
}
</script>

<template>
  <div class="flex h-full flex-col" @drop="onDrop" @dragover.prevent>
    <!-- 列表视图：工作区全部 Markdown 文章（含元数据） -->
    <div
      v-if="files.root && ui.sidebarFilesView === 'list'"
      class="min-h-0 flex-1"
      @contextmenu="onRootContextMenu"
    >
      <FileList :filter="filter" />
    </div>

    <!-- 树视图 -->
    <template v-else-if="files.root">
      <!-- 工作区树（ARIA tree：方向键移动/展开、Home/End、Enter 打开，见 lib/treeFocus.ts）
           左右内缩 10px = 页签与下方搜索行的同一条竖线，树行的选中药丸与搜索框左缘对齐 -->
      <div
        class="min-h-0 flex-1 overflow-y-auto px-0 pt-1 pb-1.5"
        role="tree"
        data-tree-root
        :aria-label="t('sidebar.files')"
        @keydown="handleTreeKeydown"
        @focusin="ensureRovingFocus()"
        @contextmenu="onRootContextMenu"
      >
        <TransitionGroup name="list">
          <TreeNode
            v-for="node in filtered"
            :key="node.path"
            :node="node"
            :depth="0"
            :parent-dir="files.root"
            :filter="filter"
          />
        </TransitionGroup>
        <div
          v-if="!rootNodes.length && !filter"
          class="mt-6 flex flex-col items-center gap-2 px-4 text-center"
        >
          <Icon name="folder" :size="26" :stroke-width="1.3" class="text-ink-3/60" />
          <p class="text-[12px] leading-relaxed text-ink-3">
            {{ t('sidebar.emptyFolder') }}<br />{{ t('sidebar.emptyFolderHint') }}
          </p>
        </div>
      </div>
    </template>

    <!-- 未打开工作区：空态只留三个图标按钮（新建 / 打开文件 / 打开文件夹），
         文案走 title（全局 tooltip）+ aria-label（读屏可读），侧栏保持干净 -->
    <div v-else class="empty-hub flex min-h-0 flex-1 flex-col items-center px-4 pt-8 text-center">
      <div class="flex items-center gap-2">
        <button
          class="icon-btn border border-edge"
          :title="t('open.newDoc')"
          :aria-label="t('open.newDoc')"
          @click="newDoc"
        >
          <Icon name="file-plus" :size="16" />
        </button>
        <button
          class="icon-btn border border-edge"
          :title="t('open.openFile')"
          :aria-label="t('open.openFile')"
          @click="openFileDialog"
        >
          <Icon name="folderOpen" :size="16" />
        </button>
        <button
          class="icon-btn border border-edge"
          :title="t('open.openFolder')"
          :aria-label="t('open.openFolder')"
          @click="files.openFolder()"
        >
          <Icon name="folder-plus" :size="16" />
        </button>
      </div>

      <p class="mt-4 text-[11.5px] leading-relaxed text-ink-3/80">{{ t('open.hint') }}</p>
    </div>

    <!-- 搜索 + 视图切换（树 / 列表）：**贴底**成一条独立的工具带
         （用户口径：这两件东西放在顶部太抢视觉，压到面板下方更干净）。
         为什么仍留在 FileTree 而不是 AppSidebar 的全局底栏：它只服务「文件」页签，
         切到大纲时不该出现；而这里正好是文件面板的底部，视觉上仍是侧栏最下方。

         观感口径（第三 / 四次调整）：**搜索平常只是一枚放大镜，点开才展开成输入框**，
         并且展开/收起要有动效、**失焦时不能闪**。
           * 结构上只有**一个**会在 DOM 里变形的元素 `.file-search`（外壳）：收起 28px 宽、
             透明底；展开 100% 宽、白面底。放大镜按钮**始终在壳里、从不卸载**，
             于是没有「按钮与正在淡出的输入框同时存在」的中间帧 —— 上一版的闪烁正是
             两个兄弟元素重叠 + 宽度瞬变造成的（实测：失焦瞬间按钮立刻出现、旧输入框还在
             淡出，两个都占着 `flex-1` 槽位）。
           * 动画只动三样：`width`（28px ⇄ 100%，0.2s 缓出）、`background-color`（透明 ⇄ 白面）、
             以及输入框自身的一次短淡入。外壳 `overflow: hidden` 让输入框随宽度**被揭示**，
             而不是「先出现再被挤」—— 这也是没有宽度抖动的原因。
           * 左右内缩恒为 7px：收起时 7 + 图标 14 + 7 = 28px，图标正好居中；展开时图标位置
             **一个像素都不动**，视觉上就是「同一枚放大镜长出了一个输入框」。
           * 收起规则（目的都是「筛选条件不能悄悄消失」）：失焦且为空 → 收起；
             失焦但有内容 → 保持展开；`Esc` → 清空并收起；× 只清空不收起；
             切页签 / 关工作区也收起（面板是 `v-show` 常驻的，否则下次回来会「自己开着」）。
           * 分段控件仍走 `variant="quiet"`（无轨道/无边框/无投影），与外壳**同高 28px**。
           * 分隔仍是 1px `--edge` + 与页签/树行同一条竖线的 10px 内缩；
             不加阴影、不加底色 —— 保持「安静但有结构」。 -->
    <div
      v-if="files.root"
      class="flex flex-none items-center gap-1.5 border-t border-edge px-2.5 pb-1.5 pt-1.5"
      data-sidebar-filetools
    >
      <div class="flex h-7 min-w-0 flex-1 items-center">
        <div class="file-search" :class="{ 'file-search--open': searchOpen }" data-sidebar-search>
          <button
            class="file-search__icon"
            :data-sidebar-search-toggle="searchOpen ? undefined : 'true'"
            :title="t('sidebar.filterPlaceholder')"
            :aria-label="t('sidebar.filterPlaceholder')"
            :aria-expanded="searchOpen ? 'true' : 'false'"
            @click="onSearchIcon"
          >
            <Icon name="search" :size="14" />
          </button>
          <Transition name="fade">
            <input
              v-if="searchOpen"
              ref="filterEl"
              v-model="filter"
              class="file-search__input"
              :placeholder="t('sidebar.filterPlaceholder')"
              :aria-label="t('sidebar.filterPlaceholder')"
              @blur="onSearchBlur"
              @keydown.esc="closeSearch"
            />
          </Transition>
          <button
            v-if="searchOpen && filter"
            class="file-search__clear"
            :aria-label="t('common.close')"
            @click="filter = ''"
          >
            <Icon name="x" :size="12" />
          </button>
        </div>
      </div>
      <!-- 树 / 列表 切换（会话级偏好，非持久化）：与工具栏模式切换同一个分段控件。
           图标已从「chevron-right（= 展开）」换成真正的树形图标，见 Icon.vue 的说明。 -->
      <SegmentedControl
        v-model="filesViewValue"
        :items="viewItems"
        size="sm"
        variant="quiet"
        :group-label="t('sidebar.filesView')"
        class="flex-none"
      />
    </div>
  </div>
</template>

<style scoped>
/* ── 文件名搜索：一枚会「长出输入框」的放大镜 ────────────────────────────────
   只有一个元素在变：外壳 `.file-search`。收起 28px 宽（7 + 图标 14 + 7，图标正好居中）、
   透明底；展开 100% 宽、白面底。放大镜按钮**始终在壳里**（不卸载），所以不存在
   「按钮与正在淡出的输入框同框」的中间帧 —— 这正是上一版失焦闪烁的根因。

   动画只动三个便宜的属性，且都在合成/绘制层里：
     * `width` 28px ⇄ 100%（0.2s 缓出）：输入框被 `overflow: hidden` **揭示**出来，
       而不是「先出现再被挤」，所以不会抖；
     * `background-color` 透明 ⇄ `--panel`（与宽度同长）；
     * 输入框自身一次 0.14s 的淡入（`transition-behavior` 无关，纯 opacity）。
   左内缩恒为 7px ⇒ 展开时图标一个像素都不动，观感就是「同一枚放大镜长出了输入框」。

   宽度是布局属性，但这一行只有这两个控件、且都 `flex-none`，外层又是 `overflow`
   不受影响；0.2s 的宽度过渡在 264px 的侧栏里不会掉帧（实测拖拽期同层级的
   宽度过渡是流畅的，见 style.css 里侧栏宽度过渡的既有结论）。 */
.file-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  width: 28px;
  height: 28px;
  padding: 0 7px;
  border-radius: 10px;
  background: transparent;
  overflow: hidden;
  transition:
    width 0.2s cubic-bezier(0.32, 0.72, 0, 1),
    background-color 0.2s ease;
}
.file-search--open {
  width: 100%;
  background: var(--panel);
}
/* 聚焦光环只加在已展开的壳上（收起时它只是一枚图标，不该有输入框的观感） */
.file-search--open:focus-within {
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.file-search__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--ink-3);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color 0.15s ease;
}
.file-search__icon:hover {
  color: var(--ink-2);
}
.file-search--open .file-search__icon {
  cursor: text;
  color: var(--ink-3);
}

.file-search__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12.5px;
  color: var(--ink);
}
.file-search__input::placeholder {
  color: var(--ink-3);
}

.file-search__clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: color 0.15s ease;
}
.file-search__clear:hover {
  color: var(--ink);
}

/* 过渡只留透明度：`fade` 是全局定义（opacity 0.18s），这里把输入框的入场收短一档，
   让它跟着宽度揭示的节奏出现，而不是「先亮后挤」。 */
.file-search__input.fade-enter-active {
  transition: opacity 0.14s ease 0.04s;
}

@media (prefers-reduced-motion: reduce) {
  .file-search,
  .file-search__icon,
  .file-search__clear,
  .file-search__input.fade-enter-active {
    transition: none;
  }
}
</style>
