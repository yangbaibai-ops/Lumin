import './assets/style.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { useSettingsStore } from './stores/settings'
import { useFilesStore } from './stores/files'
import { useUiStore } from './stores/ui'
import { useNotificationsStore } from './stores/notifications'
import { useEditorMenuStore } from './stores/editorMenu'

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

  // 通知中心：从 SQLite 恢复上次未关闭的通知（按需求跨会话保留）
  await useNotificationsStore(pinia).hydrate()

  // 右键菜单的「最近使用」：从 SQLite 恢复动作使用记录
  await useEditorMenuStore(pinia).hydrate()

  // 多窗口：本窗口由「在新窗口打开」创建时，启动后直接打开目标文件
  const startupFile = window.luminAPI.app.startupFile
  if (startupFile) {
    if (await files.openPath(startupFile)) {
      await router.push('/editor')
    }
  }

  // 初始化完成后立即结束骨架屏（不再人为拖延 600ms，加快启动/渲染速度）
  ui.booting = false
}

void bootstrap()
