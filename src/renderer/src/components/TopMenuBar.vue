<script setup lang="ts">
// ─── 应用内顶部菜单栏（VS Code 式，确定性 Alt+F/E/V/H）─────────────────────
// 替代依赖系统的原生菜单助记键：位置由 DOM 布局精确摆放、Alt+字母必达；
// 菜单项与原生菜单同源动作（files/ui/settings/editor/export 组合）。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useFindStore } from '../stores/find'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import { confirmIfDirty, newDocumentWindow } from '../composables/useAppActions'
import { openExternalFile, openInWindowOrFocus } from '../lib/openFile'
import { ENCODINGS } from '../../../shared/encodings'
import { EOL_OPTIONS } from '../../../shared/eol'
import RecentList from './RecentList.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const router = useRouter()
const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport } = useExport()
const { setMode } = useEditorMode()

// labelKey = i18n 键；label = 直接文案（最近文档这类动态项用文件名，无键可查）
type Leaf = {
  labelKey?: string
  label?: string
  icon?: string
  danger?: boolean
  /** 当前项（如「选择编码重新打开」里当前生效的那个编码）：右侧打勾并高亮 */
  active?: boolean
  run: () => void | Promise<void>
}
/** 二级菜单项：悬停展开右侧浮层（最近文档 / 最近文件夹 / 自定义内容） */
type SubMenu = {
  labelKey: string
  icon?: string
  /** 固定内容（Leaf 列表）；与 slot 二选一 */
  children?: (Leaf | 'sep')[]
  /** 用插槽渲染自定义内容（如共用的 RecentList 组件） */
  slot?: 'recentFiles' | 'recentFolders'
}
type Group = {
  key: 'f' | 'e' | 'd' | 'v' | 'h'
  labelKey: string
  items: (Leaf | SubMenu | 'sep')[]
}

function isSub(it: Leaf | SubMenu | 'sep'): it is SubMenu {
  return typeof it === 'object' && ('children' in it || 'slot' in it)
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
/** 提升标题级别（H2 → H1 等，向更高层级走；非标题无操作） */
function raiseHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 1
  if (level > 1)
    ed.chain()
      .focus()
      .setHeading({ level: (level - 1) as HeadingLevel })
      .run()
}
/** 降低标题级别（H1 → H2 等，向更低层级走；非标题无操作） */
function lowerHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 6
  if (level < 6)
    ed.chain()
      .focus()
      .setHeading({ level: (level + 1) as HeadingLevel })
      .run()
}

/** 二级菜单里的「最近文档」：已开着就聚焦那个窗口，否则新窗口打开（不打扰当前窗口）；
 *  「最近文件夹」始终在新窗口把该文件夹作为工作区打开 */
function openRecentFile(path: string): void {
  close()
  void openInWindowOrFocus(path)
}
function openRecentFolder(path: string): void {
  close()
  window.luminAPI.app.openFolderInNewWindow(path)
}

/**
 * 「选择编码重新打开」的二级项：自动检测 + 全部编码。
 * 当前生效的那个编码打勾（`active`）——文档的 encoding 一定是具体编码，
 * 所以「自动检测」这一项本身不打勾，它只是「回到自动判定」的动作。
 */
function reopenEncodingItems(): (Leaf | 'sep')[] {
  const cur = files.current
  const items: (Leaf | 'sep')[] = [
    {
      labelKey: 'encoding.auto',
      icon: 'refresh',
      run: async () => {
        await files.reopenWithEncoding('auto')
      }
    },
    'sep'
  ]
  for (const e of ENCODINGS) {
    items.push({
      label: e.label,
      active: cur?.encoding === e.id,
      run: async () => {
        await files.reopenWithEncoding(e.id)
      }
    })
  }
  return items
}

/**
 * 「行尾」二级项：LF / CRLF，当前生效的打勾。
 * 语义是「按该行尾保存」（不是只切个显示）—— 内存里文本永远是 LF，行尾是文档属性，
 * 所以切换后要立刻落盘，否则用户以为改了、文件其实还没变（见 stores/files.setEol）。
 */
function eolItems(): (Leaf | 'sep')[] {
  const cur = files.current
  return EOL_OPTIONS.map((eol) => ({
    labelKey: eol === 'crlf' ? 'menu.eolCrlf' : 'menu.eolLf',
    active: cur?.eol === eol,
    run: async () => {
      await files.setEol(eol, { save: true })
    }
  }))
}

/**
 * 「以编码保存」的二级项：把文档编码改成指定值并立即写回。
 * 与「选择编码重新打开」的区别：那个是重新解释磁盘上的字节（不动文件），
 * 这个是改变**写盘**编码（会真的改写文件）。
 */
function saveEncodingItems(): (Leaf | 'sep')[] {
  const cur = files.current
  const items: (Leaf | 'sep')[] = [
    // 当前编码直接保存（最常用的那项）；具体编码在下面
    {
      labelKey: 'menu.saveWithEncoding',
      run: async () => {
        await files.save()
      }
    },
    'sep'
  ]
  for (const e of ENCODINGS) {
    items.push({
      label: e.label,
      active: cur?.encoding === e.id,
      run: async () => {
        await files.saveWithEncoding(e.id)
      }
    })
  }
  return items
}

/** 菜单结构用 computed：文件菜单里的「最近文档/最近文件夹」需要随使用记录实时更新 */
const GROUPS = computed<Group[]>(() => [
  {
    key: 'f',
    labelKey: 'menu.file',
    items: [
      {
        // 「新建」是文件菜单第一项（与 Ctrl+N 同一动作）：新窗口 + 工作区不变 + 未命名文档
        // （保存位置等 Ctrl+S 时再问，见 newDocumentWindow）。§4.50 起不再有单独的「新建文档」项 ——
        // 同一件事不留两个入口；顶部栏那个独立按钮也收回到这里。
        labelKey: 'menu.new',
        icon: 'file-plus',
        run: () => newDocumentWindow()
      },
      { labelKey: 'menu.newWindow', icon: 'copy', run: () => window.luminAPI.app.newWindow() },
      {
        labelKey: 'menu.openFile',
        icon: 'folder-open',
        run: async () => {
          if (await confirmIfDirty()) {
            const p = await window.luminAPI.file.chooseOpenFile()
            if (p) {
              // 落点规则（无工作区 → 本窗口 + 侧栏切到该文件的文件夹；有工作区 → 新窗口）
              // 统一在 lib/openFile.ts
              await openExternalFile(p)
              await router.push('/editor')
            }
          }
        }
      },
      { labelKey: 'menu.openFolder', icon: 'folderOpen', run: () => files.openFolder() },
      'sep',
      // 一级项 + 悬停二级：最近文档 / 最近文件夹（二级里用共用的 RecentList 组件）
      { labelKey: 'open.recent', icon: 'clock', slot: 'recentFiles' },
      { labelKey: 'open.recentFolders', icon: 'folder', slot: 'recentFolders' },
      'sep',
      {
        labelKey: 'menu.save',
        icon: 'save',
        // 保存成功不发通知（脏标记/状态栏就是反馈）；失败本身由 files.save() 内部报错
        run: async () => {
          await files.save()
        }
      },
      {
        labelKey: 'menu.saveAs',
        icon: 'copy',
        run: async () => {
          await files.saveAs()
        }
      },
      'sep',
      // 一级「导出」+ 悬停二级：具体格式收进二级菜单，一级菜单保持短（children 列表）
      {
        labelKey: 'menu.export',
        icon: 'download',
        children: [
          { labelKey: 'menu.exportPdf', icon: 'file', run: () => runExport('pdf') },
          { labelKey: 'menu.exportHtml', icon: 'code', run: () => runExport('html') },
          { labelKey: 'menu.exportWord', icon: 'file', run: () => runExport('word') },
          { labelKey: 'menu.exportEpub', icon: 'book', run: () => runExport('epub') }
        ]
      },
      // 本地历史（Wave 2）：保存前的快照可查看/载入（未落盘文档没有历史）
      {
        labelKey: 'menu.localHistory',
        icon: 'clock',
        run: async () => {
          await files.openHistory()
        }
      },
      // 一级「行尾」+ 悬停二级：以 LF / CRLF 保存（当前行尾打勾）
      {
        labelKey: 'menu.saveWithEol',
        icon: 'hr',
        children: eolItems()
      },
      // 一级「以编码保存」+ 悬停二级：按指定编码改写文件（当前编码打勾）
      {
        labelKey: 'menu.saveWithEncoding',
        icon: 'save',
        children: saveEncodingItems()
      },
      // 一级「选择编码重新打开」+ 悬停二级：按指定编码重读当前文档（当前生效的那个打勾）
      {
        labelKey: 'menu.reopenWithEncoding',
        icon: 'globe',
        children: reopenEncodingItems()
      }
    ]
  },
  {
    key: 'e',
    labelKey: 'menu.edit',
    items: [
      { labelKey: 'menu.undo', icon: 'undo', run: () => editorStore.instance?.commands.undo() },
      { labelKey: 'menu.redo', icon: 'redo', run: () => editorStore.instance?.commands.redo() },
      'sep',
      {
        labelKey: 'menu.findReplace',
        icon: 'search',
        run: () => useFindStore().show()
      },
      { labelKey: 'menu.replace', icon: 'pencil', run: () => useFindStore().showReplace() },
      { labelKey: 'menu.globalSearch', icon: 'list-checks', run: () => ui.openGlobalSearch() }
    ]
  },
  {
    key: 'd',
    labelKey: 'menu.paragraph',
    items: [
      {
        labelKey: 'editor.codeBlock',
        icon: 'braces',
        run: () => editorStore.instance?.chain().focus().toggleCodeBlock().run()
      },
      {
        labelKey: 'editor.quote',
        icon: 'quote',
        run: () => editorStore.instance?.chain().focus().toggleBlockquote().run()
      },
      'sep',
      {
        labelKey: 'editor.ul',
        icon: 'list',
        run: () => editorStore.instance?.chain().focus().toggleBulletList().run()
      },
      {
        labelKey: 'editor.ol',
        icon: 'list-ordered',
        run: () => editorStore.instance?.chain().focus().toggleOrderedList().run()
      },
      {
        labelKey: 'editor.task',
        icon: 'list-checks',
        run: () => editorStore.instance?.chain().focus().toggleTaskList().run()
      },
      'sep',
      {
        labelKey: 'editor.hr',
        icon: 'hr',
        run: () => editorStore.instance?.chain().focus().setHorizontalRule().run()
      },
      'sep',
      { labelKey: 'editor.raiseHeading', icon: 'chevron-up', run: raiseHeadingLevel },
      { labelKey: 'editor.lowerHeading', icon: 'chevron-down', run: lowerHeadingLevel }
    ]
  },
  {
    key: 'v',
    labelKey: 'menu.view',
    items: [
      {
        labelKey: 'menu.toggleSidebar',
        icon: 'panel-left',
        run: () => {
          ui.sidebarVisible = !ui.sidebarVisible
          settings.set('sidebarVisible', ui.sidebarVisible)
        }
      },
      {
        // 关掉工具栏后唯一的「开关型」入口（右键菜单那条路已被隐藏，看不出可点）；
        // 项目排序/显隐仍在设置 → 编辑器 → 快捷工具栏里
        labelKey: 'menu.toggleToolbar',
        icon: 'settings',
        run: () => settings.set('toolbarVisible', !settings.toolbarVisible)
      },
      'sep',
      { labelKey: 'menu.wysiwyg', icon: 'eye', run: () => setMode('wysiwyg') },
      { labelKey: 'menu.split', icon: 'columns', run: () => setMode('split') },
      { labelKey: 'menu.source', icon: 'source', run: () => setMode('source') },
      'sep',
      {
        labelKey: 'menu.focus',
        icon: 'focus',
        run: () => {
          ui.focusMode = !ui.focusMode
        }
      }
    ]
  },
  {
    key: 'h',
    labelKey: 'menu.help',
    items: [
      { labelKey: 'menu.settings', icon: 'settings', run: () => ui.openSettings() },
      { labelKey: 'menu.about', icon: 'info', run: () => router.push('/about') }
    ]
  }
])

const active = ref<Group | null>(null)
const panelStyle = reactive({ left: '0px', top: '0px' })
const btnRefs: Record<string, HTMLElement | null> = { f: null, e: null, d: null, v: null, h: null }

function setBtnRef(key: string, el: Element | null): void {
  btnRefs[key] = (el as HTMLElement) || null
}

function openGroup(g: Group): void {
  active.value = g
  closeSub()
  const el = btnRefs[g.key]
  if (el) {
    const r = el.getBoundingClientRect()
    panelStyle.left = `${Math.round(r.left)}px`
    panelStyle.top = `${Math.round(r.bottom + 4)}px`
  }
}

function close(): void {
  closeSub()
  active.value = null
}

async function runLeaf(leaf: Leaf): Promise<void> {
  close()
  try {
    await leaf.run()
  } catch {
    /* 动作内部自行提示 */
  }
}

// ─── 二级菜单（悬停展开）：与编辑器右键菜单同一套「悬停意图」思路 ─────────────
// 一级行与二级浮层是两个独立元素，指针跨越时若立即收起，就会出现「怎么都移不到
// 二级上」；因此：定位贴死（重叠 1px，见 placeSub）、离开后用 160ms 宽限收起、
// 指针进入二级即撤销。
const subOpen = ref<SubMenu | null>(null)
const subStyle = reactive({ left: '0px', top: '0px', maxHeight: '70vh' })
let closeTimer: ReturnType<typeof setTimeout> | null = null

function cancelSubClose(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}
function scheduleSubClose(): void {
  cancelSubClose()
  closeTimer = setTimeout(() => {
    closeTimer = null
    subOpen.value = null
  }, 160)
}
function closeSub(): void {
  cancelSubClose()
  subOpen.value = null
}

/** 二级浮层定位：贴在一级面板右侧，右侧放不下则翻到左侧 */
function placeSub(rowEl: HTMLElement, sub: SubMenu): void {
  cancelSubClose()
  subOpen.value = sub
  requestAnimationFrame(() => {
    const row = rowEl.getBoundingClientRect()
    const panel = document.querySelector('.topmenu-drop')?.getBoundingClientRect()
    // 二级内容宽度按最宽项估算：RecentList 面板固定 300，children 菜单 220
    const w = sub.slot ? 300 : 220
    const base = panel ?? row
    const flip = base.right + w > window.innerWidth - 8
    subStyle.left = `${Math.round(flip ? Math.max(8, base.left - w + 1) : base.right - 1)}px`
    const top = Math.round(Math.max(8, Math.min(row.top - 6, window.innerHeight - 120)))
    subStyle.top = `${top}px`
    // 高度必须按「到窗口底部还剩多少」钳制并允许内部滚动：编码那类二级有 14 项（≈480px），
    // 只钳 top 会让最后几行渲染到窗口外面 —— 用户点不到，自动化点不到（实测：菜单项变多后
    // 「选择编码重新打开 → Windows-1252」整行掉出视口，套件点击静默失效）
    subStyle.maxHeight = `${Math.max(160, window.innerHeight - top - 8)}px`
  })
}

function onSubRowLeave(e: MouseEvent): void {
  const related = e.relatedTarget as Node | null
  // 指针进入二级浮层 → 保持；其余情况给 160ms 宽限
  const panel = document.querySelector('.topmenu-sub')
  if (related && panel?.contains(related)) {
    cancelSubClose()
    return
  }
  scheduleSubClose()
}

function onKeydown(e: KeyboardEvent): void {
  // Esc：先收二级，再收一级菜单
  if (e.key === 'Escape' && active.value) {
    if (subOpen.value) closeSub()
    else close()
    return
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const ch = e.key.toLowerCase()
  const g = GROUPS.value.find((x) => x.key === ch)
  if (!g) return
  e.preventDefault()
  e.stopPropagation()
  if (active.value?.key === g.key) close()
  else openGroup(g)
}

function onDocDown(e: MouseEvent): void {
  const el = e.target as HTMLElement
  // 下拉弹层经 Teleport 挂到 body，需一并视为菜单内部，避免点击项前被提前关闭
  if (!el.closest('.topmenu-root') && !el.closest('.topmenu-drop')) close()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onDocDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onDocDown, true)
})
</script>

<template>
  <div
    class="topmenu-root flex h-8 shrink-0 items-center gap-0.5 border-b border-edge bg-app px-2 text-[12.5px] text-ink-2 select-none"
  >
    <template v-for="g in GROUPS" :key="g.key">
      <button
        :ref="(el) => setBtnRef(g.key, el as Element | null)"
        class="rounded-md px-2 py-0.5 transition-colors"
        :class="active?.key === g.key ? 'bg-panel-2 text-ink' : 'hover:bg-panel-2 hover:text-ink'"
        @click="active?.key === g.key ? close() : openGroup(g)"
      >
        {{ t(g.labelKey) }}
      </button>
    </template>

    <Teleport to="body">
      <div
        v-if="active"
        class="topmenu-drop fixed z-[150] w-[248px] overflow-hidden rounded-xl border border-edge bg-elevate p-1.5 shadow-2xl"
        :style="{ left: panelStyle.left, top: panelStyle.top, boxShadow: 'var(--shadow-2)' }"
      >
        <template v-for="(it, i) in active.items" :key="i">
          <div v-if="it === 'sep'" class="my-1 h-px bg-edge" />
          <!-- 二级：悬停展开右侧浮层（最近文档 / 最近文件夹） -->
          <button
            v-else-if="isSub(it)"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100"
            :class="subOpen?.labelKey === it.labelKey ? 'bg-panel-2' : 'hover:bg-panel-2'"
            @mouseenter="(e) => placeSub(e.currentTarget as HTMLElement, it)"
            @mouseleave="onSubRowLeave"
            @click="(e) => placeSub(e.currentTarget as HTMLElement, it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-3">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ t(it.labelKey) }}</span>
            <Icon name="chevron-right" :size="12" class="flex-none text-ink-3" />
          </button>
          <button
            v-else
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
            :class="it.danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-panel-2'"
            @mouseenter="closeSub"
            @click="runLeaf(it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-3">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ it.label ?? t(it.labelKey ?? '') }}</span>
          </button>
        </template>
      </div>

      <!-- 二级浮层：与一级面板贴死（重叠 1px），指针可直接平移过来 -->
      <Transition name="pop">
        <div
          v-if="active && subOpen"
          class="topmenu-drop topmenu-sub fixed z-[151] overflow-y-auto overscroll-contain rounded-xl border border-edge bg-elevate p-1.5"
          :style="{
            boxShadow: 'var(--shadow-2)',
            width: subOpen.slot ? '300px' : '220px',
            left: subStyle.left,
            top: subStyle.top,
            maxHeight: subStyle.maxHeight
          }"
          @mouseenter="cancelSubClose"
          @mouseleave="scheduleSubClose"
        >
          <p
            class="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3"
          >
            {{ t(subOpen.labelKey) }}
          </p>
          <RecentList
            v-if="subOpen.slot === 'recentFiles'"
            kind="files"
            :max="8"
            dense
            @select="openRecentFile"
          />
          <RecentList
            v-else-if="subOpen.slot === 'recentFolders'"
            kind="folders"
            :max="8"
            dense
            @select="openRecentFolder"
          />
          <!-- children 列表（如「导出」下的四种格式、「选择编码重新打开」下的编码表）：
               与一级菜单项同样的行样式；active 的项右侧打勾 -->
          <template v-else-if="subOpen.children">
            <template v-for="(child, ci) in subOpen.children" :key="ci">
              <div v-if="child === 'sep'" class="my-1 h-px bg-edge" />
              <button
                v-else
                class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
                :class="
                  child.danger
                    ? 'text-danger hover:bg-danger/10'
                    : child.active
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink hover:bg-panel-2'
                "
                :data-encoding-item="child.label ?? child.labelKey ?? ''"
                @click="runLeaf(child)"
              >
                <span class="flex h-4 w-4 items-center justify-center text-ink-3">
                  <Icon v-if="child.icon" :name="child.icon" :size="13" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{
                  child.label ?? t(child.labelKey ?? '')
                }}</span>
                <Icon v-if="child.active" name="check" :size="13" class="flex-none" />
              </button>
            </template>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
