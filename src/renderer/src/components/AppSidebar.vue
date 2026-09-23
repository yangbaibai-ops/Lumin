<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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

const workspaceName = computed(() => files.root?.split(/[\\/]/).filter(Boolean).pop() || '')

/**
 * 打开「大纲放在编辑区右侧」时，把左栏页签收回「文件」——
 * 否则 `ui.sidebarTab` 停在 'outline' 时，左栏既没有页签可切、又只能显示文件树，
 * 状态和界面对不上（下次关掉三栏模式会突然跳回大纲页签，看着像 bug）。
 */
watch(
  () => settings.outlineOnRight,
  (on) => {
    if (on) ui.sidebarTab = 'files'
  }
)

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
 * 收起侧栏（`ui.sidebarVisible = false` + 落库）随底部那一行一起去掉了：
 * 现在只有菜单「视图 → 显示侧边栏」与 Ctrl+Shift+B 两条入口，它们直接改同一个状态。
 * 需要恢复一个鼠标入口时，把它放回侧栏头部（而不是底部整行）。
 */
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
    <!-- 头部（一行：**当前工作区在左** + 动作在右）────────────────────────────
         用户口径：品牌字「Lumin」去掉；文件夹名靠左，不要靠右（靠右时与右侧动作挤在一起、
         还要靠截断让位，观感差）。
         所以这一行只讲一件事 —— 当前在哪个文件夹：左边是 `📁 名字`（`flex-1` 吃掉弹性空间，
         点击＝切换文件夹），右边是「最近 / 新建 / 刷新」。品牌身份交给窗口标题与关于页。 -->
    <div class="flex h-10 flex-none items-center gap-1.5 border-b border-edge px-3">
      <button
        v-if="files.root"
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-medium text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
        :title="files.root + '\n' + t('open.openFolder')"
        :aria-label="t('open.openFolder')"
        data-sidebar-workspace
        @click="files.openFolder()"
      >
        <Icon name="folder" :size="13" class="flex-none text-ink-3" />
        <span class="truncate">{{ workspaceName }}</span>
      </button>
      <!-- 没有工作区时：同一个位置就是一个语义正确的「打开文件夹」入口（不再是图标 + 空白） -->
      <button
        v-else
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-medium text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink-2"
        :title="t('open.openFolder')"
        :aria-label="t('open.openFolder')"
        data-sidebar-workspace
        @click="files.openFolder()"
      >
        <Icon name="folderOpen" :size="13" class="flex-none" />
        <span class="truncate">{{ t('open.openFolder') }}</span>
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

    <!-- 标签页：仅在**非三栏模式**下出现。
         打开「大纲放在编辑区右侧」后，左栏只承担文件树，页签行整行隐藏
         （这样目录与大纲才能同时看到，而且左栏不再有两套并存的导航语义）。 -->
    <div v-if="!settings.outlineOnRight" class="flex flex-none gap-1 px-2.5 pt-2">
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
         这类「切一次就空」的状态机问题从根上没有了（而且省掉每次切换的重挂成本）。
         三栏模式下：树常显、左栏里的大纲整块不显示（大纲这时在编辑区右侧）。 -->
    <div class="mt-1.5 min-h-0 flex-1">
      <FileTree v-show="settings.outlineOnRight || ui.sidebarTab === 'files'" />
      <Outline v-show="!settings.outlineOnRight && ui.sidebarTab === 'outline'" />
    </div>

    <!-- 底部原先有一行「设置 / 关于 Lumin / 收起侧边栏」——本轮去掉（用户口径：确认是否还需要，
         不需要就优化掉）。三条功能都另有入口，且都不是唯一入口：
           * 设置 → 顶部菜单「帮助 → 设置」（应用内菜单；原生菜单同源）
           * 关于 → 顶部菜单「帮助 → 关于」
           * 收起侧边栏 → 顶部菜单「视图 → 显示侧边栏」+ Ctrl+Shift+B
         去掉之后侧栏只剩「头部工作区 + 文件/大纲」，底部那条分隔线也不再需要。 -->

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
