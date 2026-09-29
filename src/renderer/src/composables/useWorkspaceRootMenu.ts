// ─── 工作区根的右键菜单（一处实现，两处弹出）────────────────────────────────────
//
// 两处都要弹它：
//   * `FileTree.vue` 容器空白处（树的空白、列表视图的空白）；
//   * `TreeNode.vue` 的**顶层文件夹那一行**（`isRoot` 分支）—— 侧栏头部那颗
//     「新建文件」按钮去掉之后，这条右键菜单成了鼠标用户最快的建文件路径。
//
// 为什么不各写一份：菜单项 = 「根上能做什么」的口径。两处各写一份，改一处忘一处
// 就会出现"在空白处能新建、在文件夹那一行不能"的怪现象（本项目在别处已经吃过同款亏）。
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'

export function useWorkspaceRootMenu(): {
  openWorkspaceRootMenu: (x: number, y: number) => void
} {
  const { t } = useI18n()
  const files = useFilesStore()
  const ui = useUiStore()

  function openWorkspaceRootMenu(x: number, y: number): void {
    const root = files.root
    if (!root) return
    ui.openContextMenu({
      x,
      y,
      ariaLabel: `${root} — ${t('context.menuLabel')}`,
      items: [
        { label: t('context.newFile'), icon: 'file-plus', action: 'new-file' },
        { label: t('context.newFolder'), icon: 'folder-plus', action: 'new-folder' },
        { label: t('sidebar.refresh'), icon: 'refresh', action: 'refresh' },
        { label: t('sidebar.closeWorkspace'), icon: 'x', action: 'close', danger: true }
      ],
      onSelect: (action) => void run(action)
    })
  }

  async function run(action: string): Promise<void> {
    const root = files.root
    if (!root) return
    if (action === 'new-file') {
      // 新建即就地重命名（不再弹窗输名）
      await files.newFileAt(root)
    } else if (action === 'new-folder') {
      const name = await ui.prompt(
        t('context.newFolder'),
        t('sidebar.newFolderHint'),
        t('context.newFolder')
      )
      if (name) await files.createDirAt(root, name)
    } else if (action === 'refresh') {
      await files.refreshDir(root)
    } else if (action === 'close') {
      // 关闭工作区不发通知：文件树立刻清空，结果已在界面上
      await files.setRoot(null)
    }
  }

  return { openWorkspaceRootMenu }
}
