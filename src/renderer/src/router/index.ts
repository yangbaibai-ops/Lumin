import { createRouter, createWebHashHistory } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'welcome',
      component: () => import('../views/WelcomeView.vue')
    },
    {
      path: '/editor/:fileId?',
      name: 'editor',
      component: () => import('../views/EditorView.vue')
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('../views/AboutView.vue')
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/'
    }
  ]
})

// 离开编辑器且存在未保存更改时确认
router.beforeEach(async (to, from) => {
  if (from.name === 'editor' && to.name !== 'editor') {
    const files = useFilesStore()
    const ui = useUiStore()
    if (files.dirty) {
      const ok = await ui.confirm({
        title: '有未保存的更改',
        body: '当前文档有未保存的更改，确定要离开吗？',
        danger: true
      })
      if (!ok) return false
    }
  }
  return true
})

export default router
