<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileNode } from '../../../shared/types'
import { stripTextExtension } from '../../../shared/textFiles'
import { useFilesStore } from '../stores/files'
import { useUiStore, type ContextMenuItem } from '../stores/ui'
import { activeTreePath } from '../lib/treeFocus'
import { samePath, ancestorDirs } from '../lib/pathUtils'
import { canDropOn } from '../lib/treeMove'
import { confirmDiscardIfDirty, confirmNative } from '../lib/dialog'
import { errorReason } from '../lib/errors'
import { useWorkspaceRootMenu } from '../composables/useWorkspaceRootMenu'
import Icon from './Icon.vue'

const props = defineProps<{
  node: FileNode
  depth: number
  parentDir: string
  filter: string
  /**
   * 这一行是不是**工作区顶层文件夹**（树顶那一行）。
   *
   * 为什么要这一位：顶层文件夹复用同一套行（箭头/图标/展开收起/子级缩进/拖放落点），
   * 但它**不是**工作区里的一个普通条目 —— 重命名 / 删除 / 拖动 / 「移动到…」在它身上
   * 全都是错的动作（删掉它就是删掉整个工作区）。所以这些一并关掉，右键只给根菜单。
   */
  isRoot?: boolean
}>()

const { t } = useI18n()
const files = useFilesStore()
const ui = useUiStore()
/** 工作区根的右键菜单（与 FileTree 空白处同一份实现） */
const { openWorkspaceRootMenu } = useWorkspaceRootMenu()

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
    // 只选中文件名主干（不含扩展名）：输入即替换、保留扩展名。
    // 「哪些后缀算文本类型」不再在这里手写正则 —— 唯一真相源是 shared/textFiles.ts
    const stem = stripTextExtension(props.node.name)
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

/**
 * 搜索过滤下这一层的可见子项。
 *
 * 口径：**目录永远留着**、只按名字过滤文件。理由：
 *   * 目录是"容器"而不是"结果"，藏掉它就等于藏掉它里面所有可能的命中
 *     （用户搜 `guide` 时，`docs/` 里那篇 `guide.md` 不该因为目录名不叫 guide 而消失）；
 *   * 与改造前 `FileTree.vue` 在**顶层**的处理完全一致（那时顶层目录也是不过滤的），
 *     现在只是把同一条口径下沉到这里，于是每一层的行为也一致了。
 */
function visibleChildren(): FileNode[] {
  if (!props.filter) return children.value
  return children.value.filter(
    (c) => c.type === 'directory' || c.name.toLowerCase().includes(props.filter.toLowerCase())
  )
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
  // 顶层文件夹没有"重命名/删除"这两件事（见 isRoot 的说明）；方向键那几条照旧
  // （由容器层的 treeFocus 处理，展开/收起/移动都还成立）
  if (props.isRoot) {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      openWorkspaceRootMenu(Math.round(r.left + 24), Math.round(r.bottom - 4))
    }
    return
  }
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
  // 顶层文件夹：只有「根的菜单」（新建文件/文件夹、刷新、关闭工作区）。
  // 重命名 / 删除 / 移动到… 在它身上是错的动作（删掉=删掉整个工作区），一律不给。
  if (props.isRoot) {
    openWorkspaceRootMenu(x, y)
    return
  }
  const items: ContextMenuItem[] = []
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
  // 「移动到…」：拖放的**键盘等价入口**（取舍与候选范围见 moveTargets 的说明）
  if (files.root) {
    items.push({
      label: t('fileTree.moveTo'),
      icon: 'folderOpen',
      action: 'move-to',
      children: moveTargets
    })
  }
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

/**
 * ─── 「移动到…」子菜单（键盘可达的那一半）────────────────────────────────────────
 *
 * 拖放只可能用鼠标完成，所以同一件事必须有第二条路：这一条挂在已有的行右键菜单上，
 * 于是 `Shift+F10` / 菜单键 → `↓` 到「移动到…」→ `→` 展开 → `Enter` 选目标 ——
 * 全程键盘（菜单的按键口径见 `ContextMenu.vue` 的说明），且与拖放**共用同一条**
 * `files.moveNode()`（判定、失败提示、撤销卡都没有第二份实现）。
 *
 * 候选范围（**这里就是本轮明确的取舍**）：工作区根 + 该项的祖先链 + `dirCache` 里
 * 已经有的目录（= 用户在树里展开过、或它就在祖先链上的目录）。
 *   * 为什么不弹系统"选择文件夹"对话框：那会把目标选到工作区之外，落点判定、相对路径、
 *     最近列表迁移全都要另立一套口径（本轮只做工作区内的移动）；
 *   * 为什么不递归预扫整棵子树：每次右键都要走一遍磁盘 IPC，代价与收益不成比例。
 *   * 代价：没展开过的深层目录要先在树里点开一次才能成为候选 —— 记在
 *     `docs/manual/09-components.md` 的欠账里。
 * 不合法的目标（自己 / 自己的子孙 / 当前所在目录）由 `canDropOn` 直接过滤掉，
 * 于是菜单里**只会出现真的会搬的那些目录**（按下去不会有"什么都没发生"的情况）。
 */
function moveTargets(): ContextMenuItem[] {
  const root = files.root
  if (!root) return []
  const source = { path: props.node.path, type: props.node.type }
  const dirs = new Set<string>([
    root,
    ...ancestorDirs(root, props.node.path),
    ...Object.keys(files.dirCache)
  ])
  const out: ContextMenuItem[] = []
  for (const dir of dirs) {
    if (!canDropOn(source, dir, root)) continue
    out.push({ label: dirLabel(dir, root), icon: 'folder', action: `move-to:${dir}` })
  }
  return out
}

/** 候选目标在菜单里显示什么：工作区根用名字，其余用相对工作区的路径（比绝对路径短得多）。
 *  这些路径全部来自同一个工作区（根 / 祖先链 / dirCache），所以"根是它的字符串前缀"成立；
 *  标签只影响观感，真正的落点走的是 action 里那个**原样**的路径。 */
function dirLabel(dir: string, root: string): string {
  if (samePath(dir, root)) return t('fileTree.moveToRoot')
  const rel = dir
    .replace(/[\\/]+$/, '')
    .slice(root.replace(/[\\/]+$/, '').length)
    .replace(/^[\\/]+/, '')
  return rel ? rel.replace(/\\/g, '/') : t('fileTree.moveToRoot')
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
  } else if (action.startsWith('move-to:')) {
    // 子菜单条目把目标目录编在 action 里（路径原样，含反斜杠）；失败提示在 store 里
    await files.moveNode(
      { path: props.node.path, type: props.node.type },
      action.slice('move-to:'.length)
    )
  } else if (action === 'delete') {
    // 删的是"正在编辑且脏"的那一篇（或它所在的目录）时，确认框要多说一句：
    // 内容会被留成草稿、回收站里也有，但用户得知道"现在删的是手里这份没保存的东西"。
    const warnUnsaved = files.deleteAffectsCurrentDoc(props.node.path) && files.dirty
    const body = t('editor.deleteConfirmBody', { name: props.node.name })
    // 确认走**主进程原生框**（用户口径：确认类弹窗全部原生）；正文里那句「还有未保存改动」
    // 仍按原规则拼在同一个 body 里，语义不变。
    const ok = await confirmNative({
      kind: 'delete-file',
      title: t('editor.deleteConfirmTitle'),
      body: warnUnsaved ? `${body}\n${t('editor.deleteUnsavedWarn')}` : body,
      danger: true
    })
    if (ok) {
      // 删除成功不发通知：那行会从树里消失，本身就是结果；失败与"不支持回收站"才提示
      try {
        await files.removeNode(props.node, props.parentDir)
      } catch (err) {
        ui.toast(t('toast.deleteFailedDetail', { reason: errorReason(err) }), 'error')
      }
    }
  }
}

/**
 * ─── 这一行不再可拖、也不再是拖放落点（用户口径：拖拽行为全部取消）──────────────
 *
 * 入口处已拦掉所有 dragstart / drop（`lib/dragGuard.ts`），模板里的 `draggable` 也钉成
 * `false`（`assets/base.css` 再补 `-webkit-user-drag: none`）。所以这里**没有**
 * dragstart / dragover / drop / 落点高亮。
 *
 * 「移动到…」的功能没有丢：它仍在右键菜单里（`moveTargets` → `files.moveNode`），
 * 且是**键盘可达**的那一条（Shift+F10 / 菜单键 → 「移动到…」）。
 */
</script>

<template>
  <div>
    <!-- 一行的解剖：16px 的箭头槽（文件行留空以对齐）→ 15px 类型图标 → 文件名。
         缩进由 --tree-depth 在 CSS 里算（4 + depth * 16），行高由 `.tree-row` 的 min-height（32px）
         统一，让整棵树等距；选中态 = accent-soft 整行底 + accent-ink 文字 + accent 图标
         （**不再有左侧那条灰色条**，取舍见 sidebar.css 里那段说明与 §4.79）。
         改名中的行带 `.is-renaming`（浅面底色）——输入框本身无边框，靠它提供位置感。

         ARIA：这是 tree 里的一行（role="treeitem"，容器在 FileTree.vue）。
         tabindex 用 roving tabindex —— 整棵树只有一个可 Tab 到的行（键盘焦点所在行），
         其余 -1；方向键移动与 Home/End 见 lib/treeFocus.ts（DOM 顺序即 ARIA 遍历顺序）。
         data-tree-* 是键盘导航要读的最小元数据：path（身份）、parent（← 回父项）、
         type（← 收起 / → 展开的语义差别）、current（Tab 进树时的落点）。

         行的按键（onRowKeydown）：F2 重命名、Delete 删除、Shift+F10 / 菜单键唤出上下文菜单。
         aria-keyshortcuts 把这三条报给读屏器（不写的话只能靠用户猜）。

         拖放已全禁用（见 script 里那一段说明）：`draggable="false"`、不挂任何 drag/drop
         处理，也不再出现 `.is-drop-target` 落点高亮。 -->
    <div
      class="tree-row"
      :class="{ 'is-current': isCurrent, 'is-renaming': renaming }"
      role="treeitem"
      data-tree-row
      :data-tree-root-row="isRoot ? 'true' : undefined"
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
      draggable="false"
      @focus="activeTreePath = node.path"
      @click="onToggle"
      @contextmenu="onContextMenu"
      @keydown="onRowKeydown"
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
          <template v-if="isRoot">
            {{ t('sidebar.emptyFolder') }}<br />{{ t('sidebar.emptyFolderHint') }}
          </template>
          <template v-else>{{ t('sidebar.emptyFolder') }}</template>
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
