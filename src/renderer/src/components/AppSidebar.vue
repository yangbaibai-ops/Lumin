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
// 上下限写成常量：拖动钳制与键盘 Home/End 用的是同一组边界（只能有一处真相）
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 420

const dragging = ref(false)
const width = computed({
  get: () => settings.sidebarWidth,
  set: (v) => settings.set('sidebarWidth', Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, v)))
})

/**
 * 手柄的键盘路径：role="separator" 的窗体分隔条本该能用方向键调（WAI-ARIA），
 * 而它此前是**纯鼠标**的 —— 键盘用户无法改变侧栏宽度，只能忍着默认值。
 * 口径与浏览器/资源管理器一致：← → 单步 16px，按住 Shift 走 40px，Home/End 到两端。
 */
function onResizeKeydown(e: KeyboardEvent): void {
  const step = e.shiftKey ? 40 : 16
  if (e.key === 'ArrowLeft') width.value = width.value - step
  else if (e.key === 'ArrowRight') width.value = width.value + step
  else if (e.key === 'Home') width.value = SIDEBAR_MIN
  else if (e.key === 'End') width.value = SIDEBAR_MAX
  else return
  e.preventDefault()
}

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
      <!-- 没有工作区时：同一个位置就是一个语义正确的「打开文件夹」入口（用户口径：这个要**保留**；
           空态那三枚按钮才不要）。 -->
      <button
        v-else
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-medium text-ink-2b transition-colors hover:bg-panel-2 hover:text-ink-2"
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
      <!-- 「刷新」只在**列表视图**下出现（用户口径：保留，但只在列表视图下显示）。
           为什么它只对列表视图有意义：树视图看的是「文件夹里有什么」，而主进程的 `fs.watch`
           已经盯住了**结构变化**（新增 / 删除 / 改名），实测外部改动 ~0.33s 就自动进树了；
           列表视图看的是每篇文章的**元数据**（修改时间 / 字数 / 预览），而 `fs.watch` 的
           `change`（只改内容、不 rename）事件按设计被过滤掉了 —— 那种时候刷新才真的有事可做
           （实测：不刷新时「修改于」不变，刷新后才变成文件真实 mtime）。
           工作区根节点的右键菜单里另有同一动作（见 FileTree 的 onRootContextMenu）。 -->
      <button
        v-if="files.root && ui.sidebarFilesView === 'list'"
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
        :class="ui.sidebarTab === tab ? 'text-ink' : 'text-ink-2b hover:text-ink-2'"
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
      <!-- 三栏模式下左栏这份大纲**整块不挂载**（v-if）：它永远不可见，留着只是白渲染一份 ——
           切文档时 DOM 里还会同时存在两套大纲行（用户在右侧看到的"闪"与这类重复渲染有关）。
           关掉三栏时再挂回来；仍然是「常驻 DOM + v-show 切页签」的老规矩（那套是修
           「切走再切回内容空了」的）。 -->
      <Outline v-if="!settings.outlineOnRight" v-show="ui.sidebarTab === 'outline'" />
    </div>

    <!-- 底部原先有一行「设置 / 关于 Lumin / 收起侧边栏」——本轮去掉（用户口径：确认是否还需要，
         不需要就优化掉）。三条功能都另有入口，且都不是唯一入口：
           * 设置 → 顶部菜单「帮助 → 设置」（应用内菜单；原生菜单同源）
           * 关于 → 顶部菜单「帮助 → 关于」
           * 收起侧边栏 → 顶部菜单「视图 → 显示侧边栏」+ Ctrl+Shift+B
         去掉之后侧栏只剩「头部工作区 + 文件/大纲」，底部那条分隔线也不再需要。 -->

    <!-- 拖拽手柄（同时是键盘可调的分隔条：见 onResizeKeydown） -->
    <div
      class="absolute -right-[3px] top-0 z-[var(--z-grip)] h-full w-[5px] cursor-col-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      :class="dragging ? 'opacity-100' : ''"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('sidebar.resize')"
      :aria-valuenow="width"
      :aria-valuemin="SIDEBAR_MIN"
      :aria-valuemax="SIDEBAR_MAX"
      tabindex="0"
      data-sidebar-resize
      @mousedown="onDragStart"
      @keydown="onResizeKeydown"
    >
      <div
        class="mx-auto h-full w-px transition-colors"
        :class="dragging ? 'bg-accent' : 'bg-transparent'"
      />
    </div>
  </aside>
</template>
