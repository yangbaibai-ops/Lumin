<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppActions } from './composables/useAppActions'
import { usePageVisible } from './composables/usePageVisible'
import { useUiStore } from './stores/ui'
import { useSettingsStore } from './stores/settings'
import AppSidebar from './components/AppSidebar.vue'
import TopMenuBar from './components/TopMenuBar.vue'
import Toast from './components/Toast.vue'
import ModalHost from './components/ModalHost.vue'
import ContextMenu from './components/ContextMenu.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import SkeletonScreen from './components/SkeletonScreen.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import GlobalTooltip from './components/GlobalTooltip.vue'
import { installGlobalTooltip } from './lib/tooltip'

const router = useRouter()
const ui = useUiStore()
const settings = useSettingsStore()
const { pageVisible } = usePageVisible()

useAppActions()
installGlobalTooltip()

onMounted(() => {
  // 文件树点击打开文件后跳转编辑器
  document.addEventListener('lumin:file-opened', () => {
    if (router.currentRoute.value.name !== 'editor') void router.push('/editor')
  })
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 应用内顶部菜单栏（Alt+F/E/V/H，位置精确、确定性） -->
    <TopMenuBar v-if="settings.nativeMenuBar" />

    <div class="flex min-h-0 flex-1">
      <Transition name="sidebar" :css="pageVisible">
        <AppSidebar v-if="ui.sidebarVisible" />
      </Transition>

      <main class="flex min-w-0 flex-1 flex-col">
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in" :css="pageVisible">
            <component :is="Component" class="h-full" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <Toast />
    <ModalHost />
    <ContextMenu />
    <GlobalSearch />
    <SettingsDialog />
    <GlobalTooltip />
    <Transition name="fade">
      <SkeletonScreen v-if="ui.booting" />
    </Transition>
  </div>
</template>
