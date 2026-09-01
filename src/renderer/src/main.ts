import './assets/style.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { useSettingsStore } from './stores/settings'
import { useFilesStore } from './stores/files'
import { useUiStore } from './stores/ui'

async function bootstrap(): Promise<void> {
  // Pinia 必须先于 store 使用被安装
  const pinia = createPinia()

  const settings = useSettingsStore(pinia)
  await settings.init()
  settings.applyAll()

  const ui = useUiStore(pinia)
  ui.sidebarVisible = settings.sidebarVisible
  ui.editorMode = settings.editorMode

  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  app.use(i18n)

  await router.isReady()
  app.mount('#app')

  const files = useFilesStore(pinia)
  await files.init()

  // 骨架屏最短展示时长，优化感知性能
  setTimeout(() => {
    ui.booting = false
  }, 600)
}

void bootstrap()
