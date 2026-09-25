<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileNode } from '../../../shared/types'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { activeTreePath } from '../lib/treeFocus'
import { confirmDiscardIfDirty } from '../lib/dialog'
import { errorReason } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{
  node: FileNode
  depth: number
  parentDir: string
  filter: string
}>()

const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()

const isOpen = computed(() => files.expanded.has(props.node.path))
const children = computed(() => files.dirCache[props.node.path] ?? [])
const isCurrent = computed(() => files.current?.path === props.node.path)

// ── 就地重命名（原位置编辑，失焦/回车生效，Esc 取消）──
const renaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

async function startRename(): Promise<void> {
  renaming.value = true
  renameDraft.value = props.node.name
  await nextTick()
  const input = renameInputRef.value
  if (input) {
    input.focus()
    // 只选中文件名主干（不含 .md 等扩展名）：输入即替换、保留扩展名
    const stem = props.node.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')
    input.setSelectionRange(0, stem.length)
  }
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return
  renaming.value = false
  const draft = renameDraft.value.trim()
  if (!draft || draft === props.node.name) return
  try {
    await files.renameNode(props.node, props.parentDir, draft)
    // 改名成功不发通知：文件树里的那一行就是结果（失败才发，见下）
  } catch (err) {
    // 目标已存在是**可预期**的冲突，给一句能指导下一步的话；
    // 其余失败（占用/只读/权限）保留原来的通用文案
    const exists = String(err instanceof Error ? err.message : err).includes('TARGET_EXISTS')
    ui.toast(t(exists ? 'toast.renameExists' : 'toast.renameFailed'), exists ? 'warning' : 'error')
  }
}

function cancelRename(): void {
  renaming.value = false
}

// 新建文件后就地重命名：新建动作设置 files.pendingRenamePath，
// 挂载（或路径变化）时若匹配本节点则自动进入重命名并消费该标记
watch(
  () => files.pendingRenamePath,
  (p) => {
    if (p && p === props.node.path) {
      files.pendingRenamePath = null
      void startRename()
    }
  },
  { immediate: true }
)

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
  // 打开另一篇文档前先问（脏的是**当前**文档；点的就是它自己则不用问）
  if (!(await confirmDiscardIfDirty(() => files.dirty && files.current?.path !== props.node.path)))
    return
  if (await files.openPath(props.node.path)) {
    // 已在编辑器路由内则由事件驱动，无需导航
    document.dispatchEvent(new CustomEvent('lumin:file-opened'))
  }
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  openMenuAt(e.clientX, e.clientY)
}

/**
 * 行的键盘操作（审计 §8：此前文件树**只能用鼠标**重命名/删除 —— 键盘用户能浏览、
 * 却够不到那四个菜单动作，只能绕到"打开文件"对话框）。
 *
 * 口径与资源管理器 / VS Code 一致：F2 重命名、Delete 删除、
 * Shift+F10 与"菜单键"（ContextMenu）唤出上下文菜单。
 * 方向键/Home/End/Enter/Space 由 lib/treeFocus 在容器层处理，这里只补这三条，
 * 并且**只在编辑态之外**生效（重命名输入框里按 F2 不该再触发一次）。
 */
function onRowKeydown(e: KeyboardEvent): void {
  if (renaming.value) return
  if (e.key === 'F2') {
    e.preventDefault()
    void startRename()
    return
  }
  if (e.key === 'Delete') {
    e.preventDefault()
    void handleAction('delete')
    return
  }
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // 菜单贴着行的右下角弹出（键盘没有指针坐标，用行本身当锚点）
    openMenuAt(Math.round(r.left + 24), Math.round(r.bottom - 4))
  }
}

/** 在给定坐标弹出本行的上下文菜单（鼠标右键与键盘唤出共用这一条） */
function openMenuAt(x: number, y: number): void {
  const items: { label: string; icon?: string; action: string; danger?: boolean }[] = []
  if (props.node.type === 'directory') {
    items.push(
      { label: t('context.newFile'), icon: 'file-plus', action: 'new-file' },
      { label: t('context.newFolder'), icon: 'folder-plus', action: 'new-folder' }
    )
  } else {
    items.push({
      label: t('context.openNewWindow'),
      icon: 'external-link',
      action: 'open-new-window'
    })
  }
  items.push({ label: t('context.rename'), icon: 'pencil', action: 'rename' })
  items.push({ label: t('context.delete'), icon: 'trash', action: 'delete', danger: true })
  ui.openContextMenu({
    x,
    y,
    items,
    // 无名称的 menu 在读屏器里只是一句"菜单"，加个名字说明它作用于哪一项
    ariaLabel: `${props.node.name} — ${t('context.menuLabel')}`,
    onSelect: (action) => void handleAction(action)
  })
}

async function handleAction(action: string): Promise<void> {
  if (action === 'open-new-window') {
    window.luminAPI.app.openInNewWindow(props.node.path)
    return
  }
  if (action === 'new-file') {
    // 新建即就地重命名（不再弹窗输名）
    await files.newFileAt(props.node.path)
  } else if (action === 'new-folder') {
    const name = await ui.prompt(
      t('context.newFolder'),
      t('sidebar.newFolderHint'),
      t('context.newFolder')
    )
    if (name) await files.createDirAt(props.node.path, name)
  } else if (action === 'rename') {
    void startRename()
  } else if (action === 'delete') {
    const ok = await ui.confirm({
      title: t('editor.deleteConfirmTitle'),
      body: t('editor.deleteConfirmBody', { name: props.node.name }),
      danger: true
    })
    if (ok) {
      // 删除成功不发通知：那行会从树里消失，本身就是结果；失败与"不支持回收站"才提示
      try {
        await files.removeNode(props.node, props.parentDir)
      } catch (err) {
        ui.toast(`${t('toast.deleteFailed')}：${errorReason(err)}`, 'error')
      }
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
    <!-- 一行的解剖：16px 的箭头槽（文件行留空以对齐）→ 15px 类型图标 → 文件名。
         缩进由 --tree-depth 在 CSS 里算（4 + depth * 16），行高由 `.tree-row` 的 min-height（32px）
         统一，让整棵树等距；选中项左侧的浅灰色条是 `.tree-row.is-current::before` 画的（不占盒模型）。
         改名中的行带 `.is-renaming`（浅面底色）——输入框本身无边框，靠它提供位置感。

         ARIA：这是 tree 里的一行（role="treeitem"，容器在 FileTree.vue）。
         tabindex 用 roving tabindex —— 整棵树只有一个可 Tab 到的行（键盘焦点所在行），
         其余 -1；方向键移动与 Home/End 见 lib/treeFocus.ts（DOM 顺序即 ARIA 遍历顺序）。
         data-tree-* 是键盘导航要读的最小元数据：path（身份）、parent（← 回父项）、
         type（← 收起 / → 展开的语义差别）、current（Tab 进树时的落点）。

         行的按键（onRowKeydown）：F2 重命名、Delete 删除、Shift+F10 / 菜单键唤出上下文菜单。
         aria-keyshortcuts 把这三条报给读屏器（不写的话只能靠用户猜）。 -->
    <div
      class="tree-row"
      :class="{ 'is-current': isCurrent, 'is-renaming': renaming }"
      role="treeitem"
      data-tree-row
      :data-depth="depth"
      :data-tree-type="node.type"
      :data-tree-path="node.path"
      :data-tree-parent="parentDir"
      :data-tree-current="isCurrent ? 'true' : undefined"
      :aria-expanded="node.type === 'directory' ? isOpen : undefined"
      :aria-selected="isCurrent"
      :aria-level="depth + 1"
      :aria-keyshortcuts="renaming ? undefined : 'F2 Delete Shift+F10'"
      :tabindex="activeTreePath === node.path ? 0 : -1"
      :style="{ '--tree-depth': depth }"
      :draggable="!renaming"
      @focus="activeTreePath = node.path"
      @click="onToggle"
      @contextmenu="onContextMenu"
      @keydown="onRowKeydown"
      @dragstart="onDragStart"
    >
      <span class="tree-chevron-slot">
        <Icon
          v-if="node.type === 'directory'"
          name="chevron-right"
          :size="14"
          class="tree-chevron"
          :class="{ 'is-open': isOpen }"
          data-tree-chevron
        />
      </span>
      <Icon
        v-if="node.type === 'directory'"
        :name="isOpen ? 'folderOpen' : 'folder'"
        :size="15"
        class="tree-icon"
        data-tree-icon
      />
      <Icon v-else name="file" :size="15" class="tree-icon" data-tree-icon />
      <input
        v-if="renaming"
        ref="renameInputRef"
        v-model="renameDraft"
        class="tree-rename-input"
        spellcheck="false"
        @click.stop
        @mousedown.stop
        @dblclick.stop
        @keydown.enter.stop="commitRename"
        @keydown.esc.stop="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="tree-label">{{ node.name }}</span>
    </div>

    <!-- 子层级用轻量过渡（透明度 + 2px 位移，不带缩放），展开/收起不抢注意力 -->
    <Transition name="tree">
      <div
        v-if="node.type === 'directory' && isOpen"
        data-tree-children
        :style="{ '--tree-depth': depth }"
      >
        <div v-if="!children.length" class="tree-empty-hint" data-tree-empty-folder>
          {{ t('sidebar.emptyFolder') }}
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
