<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import TreeNode from './TreeNode.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()
const filter = ref('')

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

async function handleAction(action: string): Promise<void> {
  if (!files.root) return
  if (action === 'new-file') {
    const name = await ui.prompt(t('context.newFile'), t('sidebar.newFileHint'), `${t('common.untitled')}.md`)
    if (name) {
      const path = await files.createFileAt(files.root, name)
      if (path) await files.openPath(path)
    }
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
    <!-- 搜索 -->
    <div v-if="files.root" class="px-2.5 pb-1.5">
      <div class="flex items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-1.5 transition-colors focus-within:border-accent">
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
    </div>

    <!-- 工作区树 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" @contextmenu="onRootContextMenu">
      <template v-if="files.root">
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
      </template>
      <div v-else class="mt-6 flex flex-col items-center gap-3 px-4 text-center">
        <Icon name="folderOpen" :size="26" :stroke-width="1.3" class="text-ink-3/60" />
        <p class="text-[12px] leading-relaxed text-ink-3">{{ t('welcome.emptyFolder') }}</p>
        <button class="btn btn-outline px-3 py-1.5 text-[12px]" @click="files.openFolder()">
          <Icon name="folder-plus" :size="13" />
          {{ t('sidebar.openFolderBtn') }}
        </button>
      </div>
    </div>
  </div>
</template>
