<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import {
  activeTreePath,
  focusFirstAvailableRow,
  initRovingFocus,
  onTreeKeydown
} from '../lib/treeFocus'
import { draggingTree, endTreeDrag } from '../lib/treeMove'
import TreeNode from './TreeNode.vue'
import FileList from './FileList.vue'
import Icon from './Icon.vue'
import SegmentedControl, { type SegmentItem } from './SegmentedControl.vue'

const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()
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
const shellEl = ref<HTMLElement | null>(null)

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

/**
 * 失焦收起 —— **延迟一拍再判**（逐帧实测抓到的第二次闪烁）。
 *
 * `blur` 常常只是「用户又点了一下壳里的东西」的前半段：`mousedown` 先把焦点从输入框拿走
 * （blur 触发），`click` 才在同一个壳里发生。若在 blur 里同步收起，就会得到
 * 「收起 → 这一下 click 又展开」= 宽度先缩再长，眼睛看到的就是闪一下。
 * 于是：有内容直接保持展开；空内容也延到下一拍，看焦点是否仍落在壳内（是就不收）。
 * 图标上还加了 `@mousedown.prevent`：mousedown 根本不抢焦点，blur 压根不发生。
 */
function onSearchBlur(): void {
  if (filter.value) return
  void nextTick(() => {
    if (!searchOpen.value) return
    const active = document.activeElement
    if (shellEl.value && active && shellEl.value.contains(active)) return
    searchOpen.value = false
  })
}

/**
 * 侧栏里的 Ctrl+F（`ui.requestSidebarSearch()`）→ 展开并聚焦这里的文件名搜索框。
 *
 * 路由判定在 `useAppActions` 的 `find` 命令里（只有焦点落在本容器内才会走到这儿），
 * 这里只管「把搜索框打开、把光标放进去」—— 复用同一个 `openSearch()`，
 * 于是收起规则、动画、焦点环全都跟手动点放大镜一模一样，没有第二套状态。
 */
watch(
  () => ui.sidebarSearchTick,
  () => {
    if (files.root) void openSearch()
  }
)

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

/** 侧栏空态那三个入口（新建 / 打开文件 / 打开文件夹）随空态区块一起删掉了 ——
    没有工作区时侧栏不再放任何入口按钮（用户口径）。入口仍在顶部「文件」菜单与快捷键里。 */

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
    // 关闭工作区不发通知：文件树立刻清空，结果已在界面上
    await files.setRoot(null)
  }
}

/**
 * ─── 容器级的拖放（两种来源，必须分开对待）────────────────────────────────────
 *
 *  ① **外部拖入**（系统文件管理器里的文件）：`treeMove` 的信箱是空的 ⇒ 行为与改动前**完全一致**
 *     —— 只 `preventDefault`（把落点挡在侧栏外，交给编辑器/全局那两条路去处理），什么都不做。
 *  ② **树内拖动**（本项目自己的行）：落在**文件夹行**上由 `TreeNode.vue` 认领（它会
 *     `stopPropagation`）；落在**其它空白处**就是"移到工作区根"。两种"不是落点"的情形要
 *     分开看 —— 它们都不该被当成"根"顺手接住（拖到子文件夹里却搬去了根，是最糟的一种"帮忙"）：
 *       * 落在**文件行**上：那不是目录；
 *       * 落在**某个展开目录的子级区域里**（子行之间的空隙、空文件夹的那句提示）：那是
 *         "这个目录里"，但指针并没有落在它的**行**上 —— 猜成"根"会与用户看到的位置相反。
 *         本轮的落点口径就是"文件夹行"（题目：移动到文件夹，理由见 lib/treeMove.ts）。
 *
 * `@dragend` 挂在这里是因为它会从**源行冒泡上来**：拖拽以"没有 drop"的方式结束
 * （Esc 取消、拖到窗口外）时，只有这里能兜底把落点高亮清掉。
 */
function treeRowAt(e: DragEvent): HTMLElement | null {
  const target = e.target as HTMLElement | null
  return target?.closest?.('[data-tree-row]') ?? null
}

/** 指针是不是落在某个展开目录的**子级区域**里（不是那一行本身，见上面第二条） */
function insideFolderChildren(e: DragEvent): boolean {
  const target = e.target as HTMLElement | null
  return !!target?.closest?.('[data-tree-children]')
}

function onDragOver(e: DragEvent): void {
  if (!draggingTree()) {
    // 外部拖入：保持原样（此前是 `@dragover.prevent`）
    e.preventDefault()
    return
  }
  if (treeRowAt(e) || insideFolderChildren(e)) return // 都不是"根"的落点，交给行自己判定
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  const src = draggingTree()
  if (!src) return
  if (treeRowAt(e) || insideFolderChildren(e)) return // 同上：只有"真正的空白"才是移到根
  ui.dropTargetPath = null
  endTreeDrag()
  if (files.root) await files.moveNode(src, files.root)
}

function onTreeDragEnd(): void {
  endTreeDrag()
  ui.dropTargetPath = null
}
</script>

<template>
  <div
    class="flex h-full flex-col"
    data-sidebar-files
    @drop="onDrop"
    @dragover="onDragOver"
    @dragend="onTreeDragEnd"
  >
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
          <p class="text-ui-sm leading-relaxed text-ink-2b">
            {{ t('sidebar.emptyFolder') }}<br />{{ t('sidebar.emptyFolderHint') }}
          </p>
        </div>
      </div>
    </template>

    <!-- 未打开工作区：**什么都不放**（用户口径：没打开文件夹时，侧栏不要出现
         「新建文档 / 打开文件 / 打开文件夹」这些按钮和提示）。
         原来这里是一组三枚图标按钮 + 一行 `open.hint` 提示，现已整块删除。
         入口都还在别处：顶部菜单「文件」、快捷键（Ctrl+N / Ctrl+O）、以及侧栏头部的
         「打开文件夹 / 新建文件」两个按钮 —— 侧栏空着就是空着。 -->

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
             不加阴影、不加底色 —— 保持「安静但有结构」。

          ── 默认隐藏、悬停侧栏才出现（用户口径：这一条工具带平时收起来）──────────────
          规则写在 `assets/overlays.css`（要选到祖先 `aside:hover`，而 `aside` 不在本组件的
          模板里，scoped 样式选不到它）。三个显示条件，都是「不能把它藏没」的兜底：
            * `aside:hover`        —— 鼠标在侧栏上（用户口径要的那条）；
            * `aside:focus-within` —— 键盘 Tab 进侧栏（树行可聚焦）时也显示，否则纯键盘
              用户永远够不到搜索与视图切换（`visibility:hidden` 的元素不可聚焦）；
            * `filetools--pinned`  —— **搜索框开着**时一直显示（含「失焦但筛选条件还在」
              那种情况）：筛选条件不能悄悄消失，这与上面那三条收起规则同一个口径。
          用 `visibility` 而不是 `display`：保持占位高度，悬停时上面的树不会跳一行。 -->
    <div
      v-if="files.root"
      class="flex flex-none items-center gap-1.5 border-t border-edge px-2.5 pb-1.5 pt-1.5"
      data-sidebar-filetools
      :class="{ 'filetools--pinned': searchOpen }"
    >
      <div class="flex h-7 min-w-0 flex-1 items-center">
        <div
          ref="shellEl"
          class="file-search"
          :class="{ 'file-search--open': searchOpen }"
          data-sidebar-search
        >
          <button
            class="file-search__icon"
            :data-sidebar-search-toggle="searchOpen ? undefined : 'true'"
            :title="t('sidebar.filterPlaceholder') + ' (Ctrl+F)'"
            :aria-label="t('sidebar.filterPlaceholder')"
            :aria-expanded="searchOpen ? 'true' : 'false'"
            @mousedown.prevent
            @click="onSearchIcon"
          >
            <Icon name="search" :size="14" />
          </button>
          <!-- 输入框的进出**不做淡入**，只做离场淡出（见 scoped 样式）：
               `name` 故意不叫 `fade` —— 全局 `.fade-enter-*` 会把淡入加回来，
               而淡入正是「外壳已经变宽、里面却还是空条」那一闪的来源。 -->
          <Transition name="search">
            <input
              v-if="searchOpen"
              ref="filterEl"
              v-model="filter"
              class="file-search__input"
              data-sidebar-filter
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
  /* 焦点环也参与过渡、并**延后 60ms** 才出现（逐帧实测的修正）：
     展开瞬间输入框就拿到了焦点，若环立刻出现，会在「还只有 28px 的小方块」上先亮一圈
     再跟着长开 —— 眼睛看到的就是展开时闪一下。延后到外壳已经长到 ~100px 时再淡入，
     观感变成「字段长开的同时光环浮现」。 */
  box-shadow: 0 0 0 0 transparent;
  transition:
    width 0.2s cubic-bezier(0.32, 0.72, 0, 1),
    background-color 0.2s ease,
    box-shadow 0.16s ease 0.06s;
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

/* 输入框的过渡**只做离场**：收起时文字跟着宽度一起收进去（0.16s 淡出），
   而不是「啪」地消失。入场刻意什么都不写 —— 没有 opacity 动画，占位文字从第一帧
   就跟着 `overflow: hidden` 的揭示一起出现，不会再出现「外壳已变宽、里面是空条」。 */
.file-search__input.search-leave-active {
  transition: opacity 0.16s ease;
}
.file-search__input.search-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .file-search,
  .file-search__icon,
  .file-search__clear,
  .file-search__input.search-leave-active {
    transition: none;
  }
}
</style>
