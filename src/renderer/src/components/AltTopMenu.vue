<script setup lang="ts">
// ─── Alt 助记键兜底下拉菜单（Alt+F/E/V/H）─────────────────────────────────
// 原生菜单在个别 Electron/Windows 组合下助记键不响应时，这里保证
// Alt+字母 一定能打开对应菜单；所有动作经 luminAPI.app.invokeMenu →
// 主进程 'menu:action'（与原生菜单点击完全同一通道），行为零分叉。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MenuAction } from '../../../shared/types'
import Icon from './Icon.vue'

interface Leaf {
  label: string
  action?: MenuAction
  icon?: string
  danger?: boolean
}
interface Group {
  id: 'file' | 'edit' | 'view' | 'help'
  key: string
  label: string
  x: number
  leaves: Leaf[]
}

const GROUPS: Group[] = [
  {
    id: 'file',
    key: 'f',
    label: '文件(F)',
    x: 6,
    leaves: [
      { label: '新建文档', action: 'new', icon: 'file-plus' },
      { label: '打开…', action: 'open', icon: 'folder-open' },
      { label: '打开文件夹…', action: 'open-folder', icon: 'folder-plus' },
      { label: '', icon: '' },
      { label: '保存', action: 'save', icon: 'save' },
      { label: '另存为…', action: 'save-as', icon: 'copy' },
      { label: '', icon: '' },
      { label: '导出为 PDF', action: 'export-pdf', icon: 'file' },
      { label: '导出为 HTML', action: 'export-html', icon: 'code' },
      { label: '导出为 Word (.doc)', action: 'export-word', icon: 'file' },
      { label: '导出为 EPUB', action: 'export-epub', icon: 'book' }
    ]
  },
  {
    id: 'edit',
    key: 'e',
    label: '编辑(E)',
    x: 74,
    leaves: [
      { label: '查找 / 替换', action: 'find', icon: 'search' },
      { label: '全局搜索（全文索引）', action: 'global-search', icon: 'list-checks' }
    ]
  },
  {
    id: 'view',
    key: 'v',
    label: '视图(V)',
    x: 156,
    leaves: [
      { label: '切换侧边栏', action: 'toggle-sidebar', icon: 'panel-left' },
      { label: '', icon: '' },
      { label: '所见即所得（实时渲染）', action: 'mode-wysiwyg', icon: 'eye' },
      { label: '分屏对比（渲染 + 源码）', action: 'mode-split', icon: 'columns' },
      { label: '源码模式', action: 'mode-source', icon: 'source' },
      { label: '', icon: '' },
      { label: '专注模式', action: 'toggle-focus', icon: 'focus' },
      { label: '打字机模式', action: 'toggle-typewriter', icon: 'type' }
    ]
  },
  {
    id: 'help',
    key: 'h',
    label: '帮助(H)',
    x: 252,
    leaves: [
      { label: '设置', action: 'settings', icon: 'settings' },
      { label: '关于 Lumin', action: 'about', icon: 'info' }
    ]
  }
]

const active = ref<Group | null>(null)
const activeIdx = ref(0)

function openGroup(g: Group | null): void {
  active.value = g
  activeIdx.value = 0
}

function run(leaf: Leaf): void {
  if (!leaf.action) return
  window.luminAPI.app.invokeMenu(leaf.action)
  active.value = null
}

function onKeydown(e: KeyboardEvent): void {
  // 仅处理 Alt + F/E/V/H（不含 Ctrl/Shift/Meta）
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const ch = e.key.toLowerCase()
  if (ch.length !== 1 || !/[fevh]/.test(ch)) return
  const g = GROUPS.find((x) => x.key === ch)
  if (!g) return
  e.preventDefault()
  if (active.value?.id === g.id) openGroup(null)
  else openGroup(g)
  // 避免与浏览器/系统行为冲突（如输入框内 Alt+F）
  e.stopPropagation()
}

function onDocDown(e: MouseEvent): void {
  const el = e.target as HTMLElement
  if (!el.closest('.alt-topmenu')) openGroup(null)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('blur', () => openGroup(null))
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('blur', () => openGroup(null))
})
</script>

<template>
  <Teleport to="body">
    <div v-if="active" class="alt-topmenu fixed top-2 z-[140]" :style="{ left: active.x + 'px' }">
      <div
        class="w-[248px] overflow-hidden rounded-xl border border-edge bg-elevate p-1.5 shadow-2xl"
        :style="{ boxShadow: 'var(--shadow-2)' }"
      >
        <p class="px-2.5 pb-1 pt-1 text-[11px] font-semibold tracking-wide text-ink-3">{{ active.label }}</p>
        <template v-for="(leaf, i) in active.leaves" :key="i">
          <div v-if="leaf.label === ''" class="my-1 h-px bg-edge" />
          <button
            v-else
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
            :class="leaf.danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-panel-2'"
            @mouseenter="activeIdx = i"
            @click="run(leaf)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-3">
              <Icon v-if="leaf.icon" :name="leaf.icon" :size="13" />
            </span>
            {{ leaf.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
