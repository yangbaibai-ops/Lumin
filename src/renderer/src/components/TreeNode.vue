<script setup lang="ts">
import { computed } from 'vue'
import type { FileNode } from '../../../shared/types'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const props = defineProps<{
  node: FileNode
  depth: number
  parentDir: string
  filter: string
}>()

const files = useFilesStore()
const ui = useUiStore()

const isOpen = computed(() => files.expanded.has(props.node.path))
const children = computed(() => files.dirCache[props.node.path] ?? [])
const isCurrent = computed(() => files.current?.path === props.node.path)

function visibleChildren(): FileNode[] {
  if (!props.filter) return children.value
  return children.value.filter((c) => c.name.toLowerCase().includes(props.filter.toLowerCase()))
}

async function onToggle(e: MouseEvent): Promise<void> {
  e.stopPropagation()
  if (props.node.type === 'directory') {
    await files.toggleDir(props.node.path)
  } else {
    await open()
  }
}

async function open(): Promise<void> {
  if (files.dirty && files.current?.path !== props.node.path) {
    const ok = await ui.confirm({
      title: '有未保存的更改',
      body: '当前文档有未保存的更改，确定要打开其他文件吗？',
      danger: true
    })
    if (!ok) return
  }
  if (await files.openPath(props.node.path)) {
    // 已在编辑器路由内则由事件驱动，无需导航
    document.dispatchEvent(new CustomEvent('lumin:file-opened'))
  }
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const items: { label: string; icon?: string; action: string; danger?: boolean }[] = []
  if (props.node.type === 'directory') {
    items.push(
      { label: '新建文件', icon: 'file-plus', action: 'new-file' },
      { label: '新建文件夹', icon: 'folder-plus', action: 'new-folder' }
    )
  }
  items.push({ label: '重命名', icon: 'pencil', action: 'rename' })
  items.push({ label: '删除', icon: 'trash', action: 'delete', danger: true })
  ui.openContextMenu({
    x: e.clientX,
    y: e.clientY,
    items,
    onSelect: (action) => void handleAction(action)
  })
}

async function handleAction(action: string): Promise<void> {
  if (action === 'new-file') {
    const name = await ui.prompt('新建文件', '文件名，例如 notes.md', '未命名.md')
    if (name) {
      const path = await files.createFileAt(props.node.path, name)
      if (path) await files.openPath(path)
      else ui.toast('创建失败', 'error')
    }
  } else if (action === 'new-folder') {
    const name = await ui.prompt('新建文件夹', '文件夹名称', '新文件夹')
    if (name) await files.createDirAt(props.node.path, name)
  } else if (action === 'rename') {
    const name = await ui.prompt('重命名', '新名称', props.node.name)
    if (name && name !== props.node.name) {
      try {
        await files.renameNode(props.node, props.parentDir, name)
        ui.toast('已重命名', 'success')
      } catch {
        ui.toast('重命名失败', 'error')
      }
    }
  } else if (action === 'delete') {
    const ok = await ui.confirm({
      title: '删除确认',
      body: `确定要删除「${props.node.name}」吗？此操作不可恢复。`,
      danger: true
    })
    if (ok) {
      await files.removeNode(props.node, props.parentDir)
      ui.toast('已删除', 'success')
    }
  }
}

function onDragStart(e: DragEvent): void {
  e.dataTransfer?.setData('text/plain', props.node.path)
  e.dataTransfer!.effectAllowed = 'copy'
}
</script>

<template>
  <div>
    <div
      class="group flex cursor-pointer select-none items-center gap-1.5 rounded-lg py-[3.5px] pr-2 text-[13px] transition-colors duration-100"
      :class="
        isCurrent
          ? 'bg-accent-soft text-accent'
          : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
      "
      :style="{ paddingLeft: `${6 + depth * 14}px` }"
      draggable="true"
      @click="onToggle"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
    >
      <span class="flex h-4 w-4 flex-none items-center justify-center">
        <Icon
          v-if="node.type === 'directory'"
          name="chevron-right"
          :size="13"
          class="text-ink-3 transition-transform duration-200"
          :class="isOpen ? 'rotate-90' : ''"
        />
      </span>
      <Icon
        v-if="node.type === 'directory'"
        :name="isOpen ? 'folderOpen' : 'folder'"
        :size="15"
        class="text-[color-mix(in_srgb,var(--warning)_70%,var(--ink-3))]"
      />
      <Icon v-else name="file" :size="15" class="text-ink-3" :class="isCurrent ? 'text-accent' : ''" />
      <span class="min-w-0 flex-1 truncate">{{ node.name }}</span>
    </div>

    <Transition name="list">
      <div v-if="node.type === 'directory' && isOpen">
        <div v-if="!children.length" class="py-0.5 pl-7 text-[11.5px] text-ink-3" :style="{ paddingLeft: `${34 + depth * 14}px` }">
          空文件夹
        </div>
        <TreeNode
          v-for="child in visibleChildren()"
          :key="child.path"
          :node="child"
          :depth="depth + 1"
          :parent-dir="node.path"
          :filter="filter"
        />
      </div>
    </Transition>
  </div>
</template>
