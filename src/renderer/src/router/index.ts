import { createRouter, createWebHashHistory } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'

// ─── 路由 ──────────────────────────────────────────────────────────────────
// 不再有「欢迎页」：Lumin 是写作工具，没有文档时编辑器直接以空白未命名缓冲区出现
// （EditorView 挂载时会保证这一点），「新建 / 打开文件 / 打开文件夹 / 最近文档」
// 分别由侧栏空态、工具栏「打开」分裂按钮与文件菜单承担。
// `/` 一律重定向到 `/editor`，于是「无文档」只有一种表现、异常降级也走同一条路。
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/editor'
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
      redirect: '/editor'
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
