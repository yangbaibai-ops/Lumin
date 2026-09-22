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

         观感口径（第二次调整）：**这一行只允许一个「有形状的控件」**。
           * 搜索框去掉 1px 边框，只用一块白面（`--panel`）+ 10px 圆角表达；
             聚焦时才补一圈 `--accent-soft` 的柔光环 —— 静息态少一条线。
           * 分段控件走 `variant="quiet"`：没有轨道底、没有发丝边、没有投影，
             只留一枚滑动的软底块；图标选中态用字色而不是品牌色（旁边就是输入框，
             一点彩色就会显得跳）。两处控件**同高 28px**，成对出现时是一条齐平的带子。
           * 分隔仍是 1px `--edge` + 与页签/树行同一条竖线的 10px 内缩；
             不加阴影、不加底色 —— 保持「安静但有结构」。 -->
    <div
      v-if="files.root"
      class="flex flex-none items-center gap-1.5 border-t border-edge px-2.5 pb-1.5 pt-1.5"
      data-sidebar-filetools
    >
      <div
        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-panel px-2.5 transition-shadow focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
      >
        <Icon name="search" :size="12.5" class="text-ink-3" />
        <input
          v-model="filter"
          class="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          :placeholder="t('sidebar.filterPlaceholder')"
        />
        <button
          v-if="filter"
          class="text-ink-3 transition-colors hover:text-ink"
          :aria-label="t('common.close')"
          @click="filter = ''"
        >
          <Icon name="x" :size="12" />
        </button>
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
