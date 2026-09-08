<script setup lang="ts">
// ─── 应用内顶部菜单栏（VS Code 式，确定性 Alt+F/E/V/H）─────────────────────
// 替代依赖系统的原生菜单助记键：位置由 DOM 布局精确摆放、Alt+字母必达；
// 菜单项与原生菜单同源动作（files/ui/settings/editor/export 组合）。
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import { confirmIfDirty } from '../composables/useAppActions'
import Icon from './Icon.vue'

const router = useRouter()
const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport } = useExport()
const { setMode } = useEditorMode()

type Leaf = { label: string; icon?: string; danger?: boolean; run: () => void | Promise<void> }
type Group = { key: 'f' | 'e' | 'v' | 'h'; label: string; items: (Leaf | 'sep')[] }

const GROUPS: Group[] = [
  {
    key: 'f',
    label: '文件(F)',
    items: [
      { label: '新建文档', icon: 'file-plus', run: async () => { if (await confirmIfDirty()) { await files.newDocInWorkspace(); await router.push('/editor') } } },
      { label: '新建窗口', icon: 'copy', run: () => window.luminAPI.app.newWindow() },
      { label: '打开…', icon: 'folder-open', run: async () => { if (await confirmIfDirty()) { const p = await window.luminAPI.file.chooseOpenFile(); if (p && (await files.openPath(p))) await router.push('/editor') } } },
      { label: '打开文件夹…', icon: 'folder-plus', run: () => files.openFolder() },
      'sep',
      { label: '保存', icon: 'save', run: async () => { if (await files.save()) ui.toast('已保存', 'success') } },
      { label: '另存为…', icon: 'copy', run: async () => { if (await files.saveAs()) ui.toast('已保存', 'success') } },
      'sep',
      { label: '导出为 PDF', icon: 'file', run: () => runExport('pdf') },
      { label: '导出为 HTML', icon: 'code', run: () => runExport('html') },
      { label: '导出为 Word (.doc)', icon: 'file', run: () => runExport('word') },
      { label: '导出为 EPUB', icon: 'book', run: () => runExport('epub') }
    ]
  },
  {
    key: 'e',
    label: '编辑(E)',
    items: [
      { label: '撤销', icon: 'undo', run: () => editorStore.instance?.commands.undo() },
      { label: '重做', icon: 'redo', run: () => editorStore.instance?.commands.redo() },
      'sep',
      { label: '查找 / 替换', icon: 'search', run: () => ui.toast('查找替换功能待接入', 'info') },
      { label: '全局搜索（全文索引）', icon: 'list-checks', run: () => ui.openGlobalSearch() }
    ]
  },
  {
    key: 'v',
    label: '视图(V)',
    items: [
      { label: '切换侧边栏', icon: 'panel-left', run: () => { ui.sidebarVisible = !ui.sidebarVisible; settings.set('sidebarVisible', ui.sidebarVisible) } },
      'sep',
      { label: '所见即所得（实时渲染）', icon: 'eye', run: () => setMode('wysiwyg') },
      { label: '分屏对比（渲染 + 源码）', icon: 'columns', run: () => setMode('split') },
      { label: '源码模式', icon: 'source', run: () => setMode('source') },
      'sep',
      { label: '专注模式', icon: 'focus', run: () => { ui.focusMode = !ui.focusMode } }
    ]
  },
  {
    key: 'h',
    label: '帮助(H)',
    items: [
      { label: '设置', icon: 'settings', run: () => ui.openSettings() },
      { label: '关于 Lumin', icon: 'info', run: () => router.push('/about') }
    ]
  }
]

const active = ref<Group | null>(null)
const panelStyle = reactive({ left: '0px', top: '0px' })
const btnRefs: Record<string, HTMLElement | null> = { f: null, e: null, v: null, h: null }

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
        {{ g.label }}
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
            {{ it.label }}
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>
