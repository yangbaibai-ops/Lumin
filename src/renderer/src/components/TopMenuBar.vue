<script setup lang="ts">
// ─── 应用内顶部菜单栏（VS Code 式，确定性 Alt+F/E/V/H）─────────────────────
// 替代依赖系统的原生菜单助记键：位置由 DOM 布局精确摆放、Alt+字母必达；
// 菜单项与原生菜单同源动作（files/ui/settings/editor/export 组合）。
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import { confirmIfDirty } from '../composables/useAppActions'
import Icon from './Icon.vue'

const { t } = useI18n()
const router = useRouter()
const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport } = useExport()
const { setMode } = useEditorMode()

type Leaf = { labelKey: string; icon?: string; danger?: boolean; run: () => void | Promise<void> }
type Group = { key: 'f' | 'e' | 'd' | 'v' | 'h'; labelKey: string; items: (Leaf | 'sep')[] }

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
/** 提升标题级别（H2 → H1 等，向更高层级走；非标题无操作） */
function raiseHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 1
  if (level > 1) ed.chain().focus().setHeading({ level: (level - 1) as HeadingLevel }).run()
}
/** 降低标题级别（H1 → H2 等，向更低层级走；非标题无操作） */
function lowerHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 6
  if (level < 6) ed.chain().focus().setHeading({ level: (level + 1) as HeadingLevel }).run()
}

const GROUPS: Group[] = [
  {
    key: 'f',
    labelKey: 'menu.file',
    items: [
      { labelKey: 'menu.newDoc', icon: 'file-plus', run: async () => { if (await confirmIfDirty()) { await files.newDocInWorkspace(); await router.push('/editor') } } },
      { labelKey: 'menu.newWindow', icon: 'copy', run: () => window.luminAPI.app.newWindow() },
      { labelKey: 'menu.openFile', icon: 'folder-open', run: async () => { if (await confirmIfDirty()) { const p = await window.luminAPI.file.chooseOpenFile(); if (p && (await files.openPath(p))) await router.push('/editor') } } },
      { labelKey: 'menu.openFolder', icon: 'folder-plus', run: () => files.openFolder() },
      'sep',
      { labelKey: 'menu.save', icon: 'save', run: async () => { if (await files.save()) ui.toast(t('toast.saved'), 'success') } },
      { labelKey: 'menu.saveAs', icon: 'copy', run: async () => { if (await files.saveAs()) ui.toast(t('toast.saved'), 'success') } },
      'sep',
      { labelKey: 'menu.exportPdf', icon: 'file', run: () => runExport('pdf') },
      { labelKey: 'menu.exportHtml', icon: 'code', run: () => runExport('html') },
      { labelKey: 'menu.exportWord', icon: 'file', run: () => runExport('word') },
      { labelKey: 'menu.exportEpub', icon: 'book', run: () => runExport('epub') }
    ]
  },
  {
    key: 'e',
    labelKey: 'menu.edit',
    items: [
      { labelKey: 'menu.undo', icon: 'undo', run: () => editorStore.instance?.commands.undo() },
      { labelKey: 'menu.redo', icon: 'redo', run: () => editorStore.instance?.commands.redo() },
      'sep',
      { labelKey: 'menu.findReplace', icon: 'search', run: () => ui.toast(t('common.pending'), 'info') },
      { labelKey: 'menu.globalSearch', icon: 'list-checks', run: () => ui.openGlobalSearch() }
    ]
  },
  {
    key: 'd',
    labelKey: 'menu.paragraph',
    items: [
      { labelKey: 'editor.codeBlock', icon: 'braces', run: () => editorStore.instance?.chain().focus().toggleCodeBlock().run() },
      { labelKey: 'editor.quote', icon: 'quote', run: () => editorStore.instance?.chain().focus().toggleBlockquote().run() },
      'sep',
      { labelKey: 'editor.ul', icon: 'list', run: () => editorStore.instance?.chain().focus().toggleBulletList().run() },
      { labelKey: 'editor.ol', icon: 'list-ordered', run: () => editorStore.instance?.chain().focus().toggleOrderedList().run() },
      { labelKey: 'editor.task', icon: 'list-checks', run: () => editorStore.instance?.chain().focus().toggleTaskList().run() },
      'sep',
      { labelKey: 'editor.hr', icon: 'hr', run: () => editorStore.instance?.chain().focus().setHorizontalRule().run() },
      'sep',
      { labelKey: 'editor.raiseHeading', icon: 'chevron-up', run: raiseHeadingLevel },
      { labelKey: 'editor.lowerHeading', icon: 'chevron-down', run: lowerHeadingLevel }
    ]
  },
  {
    key: 'v',
    labelKey: 'menu.view',
    items: [
      { labelKey: 'menu.toggleSidebar', icon: 'panel-left', run: () => { ui.sidebarVisible = !ui.sidebarVisible; settings.set('sidebarVisible', ui.sidebarVisible) } },
      'sep',
      { labelKey: 'menu.wysiwyg', icon: 'eye', run: () => setMode('wysiwyg') },
      { labelKey: 'menu.split', icon: 'columns', run: () => setMode('split') },
      { labelKey: 'menu.source', icon: 'source', run: () => setMode('source') },
      'sep',
      { labelKey: 'menu.focus', icon: 'focus', run: () => { ui.focusMode = !ui.focusMode } }
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
]

const active = ref<Group | null>(null)
const panelStyle = reactive({ left: '0px', top: '0px' })
const btnRefs: Record<string, HTMLElement | null> = { f: null, e: null, d: null, v: null, h: null }

function setBtnRef(key: string, el: Element | null): void {
  btnRefs[key] = (el as HTMLElement) || null
}

function openGroup(g: Group): void {
  active.value = g
  const el = btnRefs[g.key]
  if (el) {
    const r = el.getBoundingClientRect()
    panelStyle.left = `${Math.round(r.left)}px`
    panelStyle.top = `${Math.round(r.bottom + 4)}px`
  }
}

function close(): void {
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

function onKeydown(e: KeyboardEvent): void {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const ch = e.key.toLowerCase()
  const g = GROUPS.find((x) => x.key === ch)
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
  <div class="topmenu-root flex h-8 shrink-0 items-center gap-0.5 border-b border-edge bg-panel/90 px-2 text-[12.5px] text-ink-2 backdrop-blur-md select-none">
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
          <button
            v-else
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
            :class="it.danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-panel-2'"
            @click="runLeaf(it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-3">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            {{ t(it.labelKey) }}
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>
