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

/** 左侧边缘触发展开把手的横向阈值（px，可按手感调整） */
const EDGE_TRIGGER_PX = 86

const edgeNear = ref(false)
const handleFocused = ref(false)
const handleShown = computed(() => edgeNear.value || handleFocused.value)

/** 指针在应用内移动：靠近左缘则准备浮现把手，移到阈值外即收起。只在状态翻转时写 ref，
    避免逐帧触发渲染。 */
function onAppPointerMove(e: PointerEvent): void {
  const near = e.clientX <= EDGE_TRIGGER_PX
  if (near !== edgeNear.value) edgeNear.value = near
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

      <!-- 侧边栏折叠时的左缘展开把手：指针进入窗口左缘阈值内（EDGE_TRIGGER_PX）即滑出，
           判定完全基于指针横坐标，不做命中测试，因此该区域不吃任何点击，正文的点击与
           选词不受影响；隐藏时 pointer-events-none，键盘 Tab 聚焦时同样会浮现。 -->
      <button
        v-if="!ui.sidebarVisible"
        type="button"
        class="absolute left-0 top-1/2 z-20 flex h-12 w-[18px] -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-edge bg-elevate text-ink-3 shadow-[var(--shadow-2)] transition-[opacity,transform,color] duration-150 hover:text-accent"
        :class="
          handleShown
            ? 'pointer-events-auto translate-x-0 opacity-100'
            : 'pointer-events-none -translate-x-1 opacity-0'
        "
        :title="t('sidebar.expand')"
        :aria-label="t('sidebar.expand')"
        @click="expandSidebar"
        @focus="handleFocused = true"
        @blur="handleFocused = false"
      >
        <Icon name="panel-left" :size="14" />
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
