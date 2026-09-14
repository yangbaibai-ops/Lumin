import { watchEffect } from 'vue'
import { useFilesStore } from '../stores/files'

/** 应用名（没有打开文件时窗口就叫它；窗口标题完全由渲染层驱动，主进程不重复维护一份） */
const APP_NAME = 'Lumin'

/**
 * ─── 窗口标题：跟随本窗口打开的文件 ────────────────────────────────────────
 * 多窗口时 Windows 任务栏把每个窗口列成一项，标题全叫「Lumin」根本分不清谁是谁。
 * 这里把标题与本窗口打开的文件绑定，和 Typora（`文件名 - Typora`）、VS Code 的
 * `● 文件名 - 应用名` 是同一套做法：
 *
 *   - 打开了文件       → `文件名.md - Lumin`
 *   - 文件有未保存改动 → `• 文件名.md - Lumin`（`•` 是本项目 Toolbar 上小圆点的文本化）
 *   - 没有打开任何文件 → `Lumin`（只有工作区、或未命名缓冲区，都算「没打开文件」）
 *
 * 「没有打开文件」为什么不带上文件夹名/未命名缓冲区名：
 *  - 未命名缓冲区的编号是每个渲染进程各自从 1 开始的，两个「新建窗口」会同时叫
 *    `Untitled-1.md`，带上它反而制造重名；
 *  - 只开着工作区并不代表「打开了什么」，标题保持纯应用名最干净、也最符合直觉。
 *    未保存内容另有提示通道：状态栏「未保存」+ 工具栏小圆点（工具栏那条 `•` 的
 *    文本化只在本窗口真的有文件时出现在标题里）。
 *
 * 实现要点：
 *  - 只写 `document.title`：Electron 会把它同步成原生窗口标题（任务栏、Alt+Tab、
 *    窗口缩略图都用它），因此**不需要任何 IPC**，也不需要在主进程再存一份标题；
 *  - 每个窗口的渲染层各自计算，天然按窗口隔离（多窗口互不影响）；
 *  - 标题是派生状态而非用户数据，不落 SQLite（下次启动由会话恢复重新算出来）。
 */
export function useWindowTitle(): void {
  const files = useFilesStore()
  watchEffect(() => {
    const doc = files.current
    document.title = doc?.path ? `${files.dirty ? '• ' : ''}${doc.name} - ${APP_NAME}` : APP_NAME
  })
}
