/**
 * ─── Ctrl+F 该去哪边：侧栏的文件名搜索，还是正文的查找栏 ──────────────────────────
 *
 * 用户口径（第九轮，原话）：「当在左侧侧边栏区域点击 ctrl+f 时，打开的是侧栏的搜索，
 * 而不是当前文档内容的搜索。」第八轮已经做过分流，但当时把"侧栏"限定在
 * 文件面板 `[data-sidebar-files]` **内部**，于是三个边界都还开着正文查找：
 *   * 焦点在侧栏**页签**（文件 / 大纲）上；
 *   * 焦点在侧栏的**空白处**（点空白不会把焦点挪进面板，焦点仍留在编辑器里）；
 *   * 鼠标在侧栏里、但焦点在编辑区（"我在侧栏里操作，然后按 Ctrl+F"）。
 * 本轮把判据放宽到**整个左侧栏**，并且把"指针在不在侧栏里"也算作证据。
 *
 * 为什么仍然要留着"正文查找"这一侧：Ctrl+F 是编辑器的基本功（`_verify-find-replace` 24 条），
 * 把全局 Ctrl+F 无条件改成侧栏搜索等于把它弄丢。所以这里是**分流**，不是替换。
 *
 * 三条仍然要走正文查找的边界（各有理由，别当成漏改）：
 *   1. **没有工作区**：侧栏里根本没有搜索框（没有文件名可筛），开了也没东西可筛；
 *   2. **左栏正在显示大纲**：那份搜索框此刻不可见（`files` 面板被 `v-show` 藏着），
 *      而大纲是对正文的导航 —— 在它上面按 Ctrl+F，想找的仍是正文；
 *   3. 焦点与指针都不在侧栏（编辑区、状态栏、菜单…）—— 照旧正文查找。
 *
 * 纯函数：不碰 DOM（调用方把四个事实读出来喂进来），`node --test` 直接跑
 * （`tests/ctrlFRoute.test.mjs`）。
 */
export type CtrlFTarget = 'sidebar-files' | 'document'

export function ctrlFTarget(input: {
  /** 有没有打开工作区（没有就没有"文件名搜索"这回事） */
  workspaceOpen: boolean
  /** 左栏此刻显示的是不是**文件面板**（大纲页签 / 三栏模式下的大纲不算） */
  filesPanelVisible: boolean
  /** 焦点是否落在左侧栏内（页签、树行、底部工具带、拖宽手柄都算） */
  focusInSidebar: boolean
  /** 指针是否停在左侧栏上（`aside:hover`）——"人在侧栏里操作"的另一半证据 */
  pointerInSidebar: boolean
}): CtrlFTarget {
  if (!input.workspaceOpen) return 'document'
  if (!input.filesPanelVisible) return 'document'
  return input.focusInSidebar || input.pointerInSidebar ? 'sidebar-files' : 'document'
}
