<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { confirmIfDirty } from '../composables/useAppActions'
import { openExternalFile } from '../lib/openFile'
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
  { id: 'tree', icon: 'chevron-right', label: t('sidebar.viewTree') },
  { id: 'list', icon: 'list', label: t('sidebar.viewList') }
])
const filesViewValue = computed({
  get: () => ui.sidebarFilesView,
  set: (v: string) => (ui.sidebarFilesView = v as 'tree' | 'list')
})
const rootNodes = computed(() => files.dirCache[files.root ?? ''] ?? [])
const filtered = computed(() => {
  if (!filter.value) return rootNodes.value
  return rootNodes.value.filter(
    (n) =>
      n.name.toLowerCase().includes(filter.value.toLowerCase()) || n.type === 'directory'
  )
})

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
    const name = await ui.prompt(t('context.newFolder'), t('sidebar.newFolderHint'), t('context.newFolder'))
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
    <!-- 搜索 + 视图切换（树 / 列表） -->
    <div v-if="files.root" class="px-2.5 pb-1.5">
      <div class="flex items-center gap-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-1.5 transition-colors focus-within:border-accent">
          <Icon name="search" :size="13" class="text-ink-3" />
          <input
            v-model="filter"
            class="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
            :placeholder="t('sidebar.filterPlaceholder')"
          />
          <button v-if="filter" class="text-ink-3 hover:text-ink" @click="filter = ''">
            <Icon name="x" :size="12" />
          </button>
        </div>
        <!-- 树 / 列表 切换（会话级偏好，非持久化）：与工具栏模式切换同一个分段控件 -->
        <SegmentedControl
          v-model="filesViewValue"
          :items="viewItems"
          size="sm"
          :group-label="t('sidebar.filesView')"
          class="flex-none"
        />
      </div>
    </div>

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
      <!-- 工作区树 -->
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" @contextmenu="onRootContextMenu">
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
        <div v-if="!rootNodes.length && !filter" class="mt-6 flex flex-col items-center gap-2 px-4 text-center">
          <Icon name="folder" :size="26" :stroke-width="1.3" class="text-ink-3/60" />
          <p class="text-[12px] leading-relaxed text-ink-3">{{ t('sidebar.emptyFolder') }}<br />{{ t('sidebar.emptyFolderHint') }}</p>
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
  </div>
</template>
