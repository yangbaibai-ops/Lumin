import { createRouter, createWebHashHistory } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { confirmDiscardIfDirty } from '../lib/dialog'

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

// 离开编辑器且存在未保存更改时确认。
// 走 `lib/dialog.ts` 的**唯一实现**：这里原先自己写了一份 `ui.confirm({ title: '有未保存的更改' … })`
// （硬编码中文），与 `lib/dialog.ts` 顶部「这是唯一实现」的注释直接矛盾 —— 改文案时必漏一处。
router.beforeEach(async (to, from) => {
  if (from.name === 'editor' && to.name !== 'editor') {
    const ok = await confirmDiscardIfDirty(() => useFilesStore().dirty)
    if (!ok) return false
  }
  return true
})

export default router
