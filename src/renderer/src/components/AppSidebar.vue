<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import FileTree from './FileTree.vue'
import Outline from './Outline.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const settings = useSettingsStore()
const ui = useUiStore()

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
 * 页签的键盘路径（ARIA tabs 模式）：← → 在两项之间移动并把焦点带过去，Home/End 到两端。
 * 为什么要有：页签此前只能用鼠标点（`role=tablist` + `tabindex` 的 roving 规则要求
 * "选中项可 Tab 进入、其余项用方向键到达"），键盘用户否则永远够不到「大纲」页签。
 */
function onTabsKeydown(e: KeyboardEvent): void {
  const order = ['files', 'outline'] as const
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const cur = order.indexOf(ui.sidebarTab as (typeof order)[number])
  const next =
    e.key === 'ArrowRight'
      ? order[(Math.max(0, cur) + 1) % order.length]
      : e.key === 'ArrowLeft'
        ? order[(Math.max(0, cur) + order.length - 1) % order.length]
        : e.key === 'Home'
          ? order[0]
          : order[order.length - 1]
  ui.sidebarTab = next
  void nextTick(() => {
    document.querySelector<HTMLElement>(`[data-sidebar-tab="${next}"]`)?.focus()
  })
}

/**
 * 收起侧栏：用户口径要一个**看得见的鼠标入口**（菜单 / 快捷键之外）。
 * 放在头部页签行右端（不是底部整行）；状态沿用既有的 `ui.sidebarVisible` +
 * `settings.sidebarVisible`，与「视图 → 显示侧边栏」/ Ctrl+Shift+B(L) 同一份持久化。
 * 收起后左缘有 `sidebar-handle` 展开把手（App.vue），窄窗断点行为不变。
 */
function hideSidebar(): void {
  ui.sidebarVisible = false
  settings.set('sidebarVisible', false)
}
</script>

<template>
  <aside
    class="sidebar-root relative z-[var(--z-raise)] flex h-full flex-none flex-col border-r border-edge bg-app"
    data-sidebar-root
    :style="{
      '--sidebar-w': width + 'px',
      transition: dragging ? 'none' : 'width .28s cubic-bezier(.4,0,.2,1)'
    }"
    :class="ui.focusMode ? 'opacity-40 saturate-50' : ''"
  >
    <!-- 顶部原先有一行「打开文件夹」（**只在没有工作区时**出现）——本轮去掉（用户口径）：
         没有工作区时，侧栏除了「文件 / 大纲」页签之外**什么都不放**（见 §4.84）。
         去掉的是"没开文件夹时那一小行工具栏"，有工作区时那一行本来就不存在
         （文件夹名是目录树的顶层节点，见 FileTree.vue）。
         打开文件夹的入口仍在：顶部菜单「文件 → 打开文件夹」、Ctrl+O 打开文件、
         以及窗口跳转列表里的最近文件夹 —— 侧栏空着就是空着。
         `data-sidebar-root` 是给"Ctrl+F 该去哪边"用的区域锚点（见 lib/ctrlFRoute.ts）：
         焦点或指针落在这一块里，Ctrl+F 就进侧栏的文件名搜索。 -->

    <!-- 标签页：仅在**非三栏模式**下出现。
         打开「大纲放在编辑区右侧」后，左栏只承担文件树，页签行整行隐藏
         （这样目录与大纲才能同时看到，而且左栏不再有两套并存的导航语义）。
         ── ARIA（报告 §5.2 P1-5）：这一组此前是**裸 button**，没有 role=tablist/tab、没有
         aria-selected，而 `_verify-a11y.js` 里那条"分段控件"断言量到的其实是文件树里的
         树/列表控件 —— 顶部页签是零覆盖。本轮补齐 tabs 语义 + 左右方向键切换。 -->
    <div v-if="!settings.outlineOnRight" class="flex flex-none items-center gap-1 px-2.5 pt-2">
      <div
        class="flex min-w-0 flex-1 gap-1"
        role="tablist"
        :aria-label="t('sidebar.files') + ' / ' + t('sidebar.outline')"
        data-sidebar-tablist
        @keydown="onTabsKeydown"
      >
        <button
          v-for="tab in ['files', 'outline'] as const"
          :id="`sidebar-tab-${tab}`"
          :key="tab"
          role="tab"
          :aria-selected="ui.sidebarTab === tab ? 'true' : 'false'"
          :aria-controls="`sidebar-panel-${tab}`"
          :tabindex="ui.sidebarTab === tab ? 0 : -1"
          class="relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-ui font-medium transition-all duration-200"
          :class="ui.sidebarTab === tab ? 'text-ink' : 'text-ink-2b hover:text-ink-2'"
          :data-sidebar-tab="tab"
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
      <button
        type="button"
        class="icon-btn !h-6.5 !w-6.5 flex-none"
        data-sidebar-hide
        :title="t('sidebar.hide')"
        :aria-label="t('sidebar.hide')"
        :aria-pressed="'true'"
        :aria-expanded="'true'"
        @click="hideSidebar"
      >
        <Icon name="panel-left" :size="15" />
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
      <FileTree
        v-show="settings.outlineOnRight || ui.sidebarTab === 'files'"
        id="sidebar-panel-files"
        role="tabpanel"
        :aria-labelledby="`sidebar-tab-files`"
      />
      <!-- 三栏模式下左栏这份大纲**整块不挂载**（v-if）：它永远不可见，留着只是白渲染一份 ——
           切文档时 DOM 里还会同时存在两套大纲行（用户在右侧看到的"闪"与这类重复渲染有关）。
           关掉三栏时再挂回来；仍然是「常驻 DOM + v-show 切页签」的老规矩（那套是修
           「切走再切回内容空了」的）。 -->
      <Outline
        v-if="!settings.outlineOnRight"
        v-show="ui.sidebarTab === 'outline'"
        id="sidebar-panel-outline"
        role="tabpanel"
        :aria-labelledby="`sidebar-tab-outline`"
      />
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
