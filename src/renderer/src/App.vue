<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppActions } from './composables/useAppActions'
import { usePageVisible } from './composables/usePageVisible'
import { useUiStore } from './stores/ui'
import AppSidebar from './components/AppSidebar.vue'
import Toast from './components/Toast.vue'
import ModalHost from './components/ModalHost.vue'
import ContextMenu from './components/ContextMenu.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import SkeletonScreen from './components/SkeletonScreen.vue'

const router = useRouter()
const ui = useUiStore()
const { pageVisible } = usePageVisible()

useAppActions()

onMounted(() => {
  // 文件树点击打开文件后跳转编辑器
  document.addEventListener('lumin:file-opened', () => {
    if (router.currentRoute.value.name !== 'editor') void router.push('/editor')
  })
})
</script>

<template>
  <div class="flex h-full min-h-0">
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

    <Toast />
    <ModalHost />
    <ContextMenu />
    <GlobalSearch />
    <Transition name="fade">
      <SkeletonScreen v-if="ui.booting" />
    </Transition>
  </div>
</template>
