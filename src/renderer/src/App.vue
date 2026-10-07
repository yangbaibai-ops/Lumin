<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppActions } from './composables/useAppActions'
import { useKeymap } from './composables/useKeymap'
import { usePageVisible } from './composables/usePageVisible'
import { useWindowTitle } from './composables/useWindowTitle'
import { useUiStore } from './stores/ui'
import { useSettingsStore } from './stores/settings'
import AppSidebar from './components/AppSidebar.vue'
import TopMenuBar from './components/TopMenuBar.vue'
import ModalHost from './components/ModalHost.vue'
import GlobalTooltip from './components/GlobalTooltip.vue'
import Icon from './components/Icon.vue'
import { installGlobalTooltip } from './lib/tooltip'
import { installLinkNotificationActions } from './lib/linkOpen'
import { installRecentUndoAction } from './lib/recentUndo'
import { installRenameUndoAction } from './lib/renameUndo'
import { handleDroppedEvent } from './lib/droppedPath'

/**
 * 「按需出现」的浮层一律异步加载（第二十五轮轻量化）。
 *
 * 这批组件（设置面板 49KB 源码、全局搜索、查找栏、本地历史、两个右键菜单）**首屏一个都不显示**：
 * 设置要 Ctrl+,、查找要 Ctrl+F、右键菜单要真的右键。此前它们在 `App.vue` 里静态 import，
 * 于是「欢迎页 + 一个文档都没打开」也要解析执行它们（含其依赖）—— 而 App.vue 在 entry chunk 里。
 * 改成 `defineAsyncComponent` 之后，它们只在被 `v-if` 真正渲染时拉取。
 *
 * 保留静态 import 的是**首屏就要看到**的那几个：外壳（AppSidebar / TopMenuBar）、
 * 启动骨架、通知中心（任何时刻都可能来一条通知）、浮层宿主、图标与全局 tooltip。
 */
const ContextMenu = defineAsyncComponent(() => import('./components/ContextMenu.vue'))
const EditorContextMenu = defineAsyncComponent(() => import('./components/EditorContextMenu.vue'))
const GlobalSearch = defineAsyncComponent(() => import('./components/GlobalSearch.vue'))
const FindReplaceBar = defineAsyncComponent(() => import('./components/FindReplaceBar.vue'))
const LocalHistoryDialog = defineAsyncComponent(() => import('./components/LocalHistoryDialog.vue'))
const SettingsDialog = defineAsyncComponent(() => import('./components/SettingsDialog.vue'))
// 命令面板（Ctrl+Shift+P）：与上面那批同一条理由 —— 不按快捷键就不该被解析执行
const CommandPalette = defineAsyncComponent(() => import('./components/CommandPalette.vue'))

const router = useRouter()
const { t } = useI18n()
const ui = useUiStore()
const settings = useSettingsStore()
const { pageVisible } = usePageVisible()

const actions = useAppActions()
// 快捷键：命令注册表 + 可自定义键位（设置 → 快捷键）；与菜单共用同一份实现
useKeymap(actions)
// 窗口标题跟随本窗口打开的内容（任务栏里才能分辨多个窗口）
useWindowTitle()
installGlobalTooltip()
// 通知卡片上的按钮按 payload.kind 派发，需在启动时把业务处理器接上
installLinkNotificationActions()
// 最近列表「移除」的撤销按钮（同样按 payload.kind 派发）
installRecentUndoAction()
// 文件树「重命名」的撤销按钮（审计 §8 P2：改名此前是单向的）
installRenameUndoAction()

/**
 * 左缘展开把手的热区（px，可按手感调整）。
 * 用**两个**阈值做迟滞（hysteresis）：进入 120px 内浮现，退到 200px 外才收起——
 * 单阈值时指针停在边界上会反复闪现，是「忽有忽无」的根源。
 */
const EDGE_SHOW_PX = 120
const EDGE_HIDE_PX = 200

const edgeNear = ref(false)
const handleFocused = ref(false)
/** 是否应该浮现把手（侧边栏已展开时永不显示） */
const handleShown = computed(() => !ui.sidebarVisible && (edgeNear.value || handleFocused.value))

/** 指针在应用内移动：靠近左缘则浮现把手，退到迟滞阈值外才收起。
    只在状态翻转时写 ref，避免逐帧触发渲染。 */
function onAppPointerMove(e: PointerEvent): void {
  const x = e.clientX
  if (!edgeNear.value && x <= EDGE_SHOW_PX) edgeNear.value = true
  else if (edgeNear.value && x > EDGE_HIDE_PX) edgeNear.value = false
}

/** 指针真正移出窗口时收起。只认 relatedTarget 为空的场景：窗口内元素之间的 enter/leave
    会被 Chromium 一并派发到祖先上（指针移到把手上时会误报「离开内容区」），据此判断会
    让把手闪一下甚至吞掉点击，因此一律交给 pointermove 的位置判定。 */
function onAppPointerLeave(e: PointerEvent): void {
  if (!e.relatedTarget) edgeNear.value = false
}

/** 从左侧边缘把手展开侧边栏（与工具栏/菜单的开关保持同一份持久化） */
function expandSidebar(): void {
  handleFocused.value = false
  ui.sidebarVisible = true
  settings.set('sidebarVisible', true)
}

/**
 * ─── 从系统拖入文件 / 文件夹：**整个窗口**都是落点 ───────────────────────────────
 *
 * 落点语义只有一份，在 `lib/droppedPath.ts`（文件 → 打开文件；目录 → 打开文件夹）。
 * 这里只负责两件 DOM 层的事：
 *
 *  ① `dragover` 必须 `preventDefault`：不 preventDefault 浏览器就**不会派发 drop**
 *     （改前这条挂在 EditorView 的根 div 上，于是"拖到侧栏里"落在 FileTree 上，
 *      虽然它也 preventDefault，但没有任何人去处理 → 拖半天没反应）；
 *  ② 光标反馈：只有"从系统拖进来的东西"才把 `dropEffect` 改成 copy。**不能无条件改** ——
 *     应用内拖动（编辑器里拖图片节点、文件树里拖文件行）有自己的 `move` 语义，
 *     无条件覆盖会让它们的"禁止/移动"光标失真。
 *
 * ⚠️ `@drop.prevent` 的 `.prevent` 会在处理函数**之前** `preventDefault()`，
 *   所以处理函数里 `event.defaultPrevented` 恒为 true —— 别拿它做判据（见 droppedPath.ts）。
 * 内层（编辑器内核的图片拖入）认领一次拖放的方式是 `stopPropagation`，不会冒泡到这里。
 */
async function onWindowDragOver(e: DragEvent): Promise<void> {
  e.preventDefault()
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types ?? []) : []
  if (types.includes('Files')) e.dataTransfer!.dropEffect = 'copy'
}
async function onWindowDrop(e: DragEvent): Promise<void> {
  await handleDroppedEvent(e)
}

onMounted(() => {
  // 文件树点击打开文件后跳转编辑器
  document.addEventListener('lumin:file-opened', () => {
    if (router.currentRoute.value.name !== 'editor') void router.push('/editor')
  })
})
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col"
    data-drop-window
    @pointermove="onAppPointerMove"
    @pointerleave="onAppPointerLeave"
    @dragover="onWindowDragOver"
    @drop.prevent="onWindowDrop"
  >
    <!-- 应用内顶部菜单栏（Alt+F/E/V/H，位置精确、确定性） -->
    <TopMenuBar v-if="settings.nativeMenuBar" />

    <div class="relative flex min-h-0 flex-1">
      <Transition name="sidebar" :css="pageVisible">
        <AppSidebar v-if="ui.sidebarVisible" />
      </Transition>

      <!-- 侧边栏折叠时的左缘展开把手：指针进入窗口左缘热区（EDGE_SHOW_PX）即滑出，
           退到 EDGE_HIDE_PX 之外才收起（双阈值迟滞，避免边界处闪烁）。
           判定完全基于指针横坐标，不做命中测试，因此该区域不吃任何点击，正文的点击与
           选词不受影响；隐藏时 pointer-events-none，键盘 Tab 聚焦时同样会浮现。
           动效与样式见 style.css 的 .sidebar-handle（位移走 transform 而非 Tailwind 的
           translate 长属性，否则过渡根本作用不到位移上 → 看起来就是「跳一下」）。 -->
      <button
        v-if="!ui.sidebarVisible"
        type="button"
        class="sidebar-handle"
        :class="{ 'is-shown': handleShown }"
        :title="t('sidebar.expand')"
        :aria-label="t('sidebar.expand')"
        @click="expandSidebar"
        @focus="handleFocused = true"
        @blur="handleFocused = false"
      >
        <Icon name="panel-left" :size="15" />
      </button>

      <main class="flex min-w-0 flex-1 flex-col">
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in" :css="pageVisible">
            <component :is="Component" class="h-full" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <!-- 通知中心不再挂在这里：它现在出现在**编辑区上方**（像 Typora，与「检测到未保存的草稿」
         横幅同一条节奏），由 views/EditorView.vue 在工具栏之下、内核之上渲染。 -->
    <ModalHost />
    <ContextMenu />
    <EditorContextMenu />
    <GlobalSearch />
    <FindReplaceBar />
    <LocalHistoryDialog />
    <SettingsDialog />
    <CommandPalette />
    <GlobalTooltip />
    <!-- 启动遮罩（骨架屏）**已移除**（用户口径：取消打开应用时的进场动画，去掉骨架图）。
         原先这里在 `ui.booting` 期间盖一层 SkeletonScreen（外加一层淡出 Transition），
         代价是：启动全程被一块不透明遮罩挡住 + 组件与它内嵌的图标 PNG 进了首屏路径。
         现在初始化期间界面就是正常界面（外壳立刻可见，文档到位就出现）——
         `ui.booting` 这个**就绪信号**保留（启动打点与套件仍用它判断"是否已就绪"）。 -->
  </div>
</template>
