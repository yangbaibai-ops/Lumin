<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import FileTree from './FileTree.vue'
import Outline from './Outline.vue'
import SidebarRecentButton from './SidebarRecentButton.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const files = useFilesStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

const workspaceName = computed(() => files.root?.split(/[\\/]/).filter(Boolean).pop() || '')

// ── 拖拽调整宽度 ──
const dragging = ref(false)
const width = computed({
  get: () => settings.sidebarWidth,
  set: (v) => settings.set('sidebarWidth', Math.max(200, Math.min(420, v)))
})

function onDragStart(e: MouseEvent): void {
  dragging.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const move = (ev: MouseEvent): void => {
    width.value = ev.clientX
  }
  const up = (): void => {
    dragging.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  e.preventDefault()
}

/**
 * 收起侧栏：改内存状态 + 落库。
 * 写成方法而不是模板内联多语句 —— prettier 会把内联多语句的分号吃掉（`a = 1 b()`），
 * Vue 模板编译器随即报 "Error parsing JavaScript expression"。
 */
function collapseSidebar(): void {
  ui.sidebarVisible = false
  settings.set('sidebarVisible', false)
}
</script>

<template>
  <aside
    class="relative z-10 flex h-full flex-none flex-col border-r border-edge bg-app"
    :style="{
      width: width + 'px',
      transition: dragging ? 'none' : 'width .28s cubic-bezier(.4,0,.2,1)'
    }"
    :class="ui.focusMode ? 'opacity-40 saturate-50' : ''"
  >
    <!-- 头部（**一行**：品牌 + 当前工作区 + 动作）────────────────────────────────
         原来是两行：`h-11` 的品牌行放「最近 / 新建 / 打开文件夹」三个图标，紧接着又是一行
         工作区名（点名字＝切换文件夹，右侧还有刷新）。三处问题：
           ① 「打开文件夹」与下一行的工作区名重复（同一个动作相隔 24px 出现两次）；
           ② 它用的 `folder-plus` 在惯例里是「**新建**文件夹」，用户会读错（本轮用户原话就是
              「新建文件夹」）—— 现在只在**没有工作区**时保留一个语义正确的 `folderOpen` 入口；
           ③ 两行合计约 69px 的 chrome，而这两行说的其实是同一件事（当前在哪个文件夹）。
         合并之后：品牌 + `📁 工作区名`（点击＝切换文件夹）+ 「最近 / 新建 / 刷新」，
         高度 `h-11 + 工作区行` → **一行 h-10**，顶部 chrome 省掉约 29px，且不再有重复入口。 -->
    <div class="flex h-10 flex-none items-center gap-1.5 border-b border-edge px-3">
      <span class="flex-none text-[13.5px] font-semibold tracking-wide text-ink">Lumin</span>
      <div class="flex-1" />

      <!-- 当前工作区：有工作区 → 名字就是「切换文件夹」入口；没有 → 一个语义正确的打开入口 -->
      <button
        v-if="files.root"
        class="flex min-w-0 max-w-[150px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium tracking-[0.02em] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink-2"
        :title="files.root + '\n' + t('open.openFolder')"
        :aria-label="t('open.openFolder')"
        data-sidebar-workspace
        @click="files.openFolder()"
      >
        <Icon name="folder" :size="11" class="flex-none" />
        <span class="truncate">{{ workspaceName }}</span>
      </button>
      <button
        v-else
        class="icon-btn !h-6.5 !w-6.5"
        :title="t('open.openFolder')"
        :aria-label="t('open.openFolder')"
        data-sidebar-workspace
        @click="files.openFolder()"
      >
        <Icon name="folderOpen" :size="14" />
      </button>

      <!-- 动作：最近文档（写作时切换文档的最短路径）→ 新建文件（最高频）→ 刷新（仅工作区） -->
      <SidebarRecentButton />
      <button
        class="icon-btn !h-6.5 !w-6.5"
        :title="t('context.newFile')"
        :aria-label="t('context.newFile')"
        @click="files.root ? files.newFileAt(files.root) : files.newDocInWorkspace()"
      >
        <Icon name="file-plus" :size="14" />
      </button>
      <button
        v-if="files.root"
        class="icon-btn !h-6.5 !w-6.5"
        :title="t('sidebar.refresh')"
        :aria-label="t('sidebar.refresh')"
        @click="files.refreshDir(files.root!)"
      >
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <!-- 标签页 -->
    <div class="flex flex-none gap-1 px-2.5 pt-2">
      <button
        v-for="tab in ['files', 'outline'] as const"
        :key="tab"
        class="relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12.5px] font-medium transition-all duration-200"
        :class="ui.sidebarTab === tab ? 'text-ink' : 'text-ink-3 hover:text-ink-2'"
        @click="ui.sidebarTab = tab"
      >
        <Icon :name="tab === 'files' ? 'file' : 'list'" :size="13" />
        {{ tab === 'files' ? t('sidebar.files') : t('sidebar.outline') }}
        <span
          v-if="ui.sidebarTab === tab"
          class="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-gradient-to-r from-accent to-accent-2"
          style="animation: lm-fade-in 0.25s ease"
        />
      </button>
    </div>

    <!-- 内容：两个面板**都常驻 DOM**，切页签只切显隐。
         为什么不再用 v-if/Transition（实测过「切到另一个页签再切回来，内容空了」）：
           * 文件树的数据是 lazily 拉进 dirCache 的，卸载/重挂会走一遍「挂载 → nextTick →
             初始化键盘焦点」的时序，而焦点初始化依赖**已经渲染出来的行**；一旦这一拍没对上，
             树就停在「没有任何行」的状态，而且自己没有恢复路径；
           * 大纲同理：它只读 editor store 的 outline，编辑器实例被重建/切模式时可能正好是空的。
         常驻之后切页签只是 display 切换 —— 数据、滚动位置、展开状态全部原样保留，
         这类「切一次就空」的状态机问题从根上没有了（而且省掉每次切换的重挂成本）。 -->
    <div class="mt-1.5 min-h-0 flex-1">
      <FileTree v-show="ui.sidebarTab === 'files'" />
      <Outline v-show="ui.sidebarTab === 'outline'" />
    </div>

    <!-- 底部 -->
    <div class="flex flex-none items-center gap-0.5 border-t border-edge px-2 py-1.5">
      <button
        class="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
        @click="ui.openSettings()"
      >
        <Icon name="settings" :size="13" />
        {{ t('settings.title') }}
      </button>
      <button
        class="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
        @click="router.push('/about')"
      >
        <Icon name="info" :size="13" />
        {{ t('about.title') }}
      </button>
      <button
        class="icon-btn !h-6.5 !w-6.5"
        :title="t('sidebar.collapse') + ' (Ctrl+Shift+B)'"
        @click="collapseSidebar"
      >
        <Icon name="panel-left" :size="14" />
      </button>
    </div>

    <!-- 拖拽手柄 -->
    <div
      class="absolute -right-[3px] top-0 z-20 h-full w-[5px] cursor-col-resize opacity-0 transition-opacity hover:opacity-100"
      :class="dragging ? 'opacity-100' : ''"
      @mousedown="onDragStart"
    >
      <div
        class="mx-auto h-full w-px transition-colors"
        :class="dragging ? 'bg-accent' : 'bg-transparent'"
      />
    </div>
  </aside>
</template>
