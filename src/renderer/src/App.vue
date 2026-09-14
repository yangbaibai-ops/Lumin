<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
import NotificationCenter from './components/NotificationCenter.vue'
import ModalHost from './components/ModalHost.vue'
import ContextMenu from './components/ContextMenu.vue'
import EditorContextMenu from './components/EditorContextMenu.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import SkeletonScreen from './components/SkeletonScreen.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import GlobalTooltip from './components/GlobalTooltip.vue'
import Icon from './components/Icon.vue'
import { installGlobalTooltip } from './lib/tooltip'
import { installLinkNotificationActions } from './lib/linkOpen'

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
    @pointermove="onAppPointerMove"
    @pointerleave="onAppPointerLeave"
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

    <NotificationCenter />
    <ModalHost />
    <ContextMenu />
    <EditorContextMenu />
    <GlobalSearch />
    <SettingsDialog />
    <GlobalTooltip />
    <Transition name="fade">
      <SkeletonScreen v-if="ui.booting" />
    </Transition>
  </div>
</template>
