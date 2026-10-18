import type { Editor } from '@tiptap/core'

/**
 * ─── 编辑器右键菜单：类型契约 ────────────────────────────────────────────────
 * 架构：菜单 = 「上下文识别」+「提供者注册表」+「动作目录」三部分拼装。
 *  - 上下文（EditorMenuContext）：纯粹从编辑器 state 推导出的场景快照，
 *    新增识别场景只需往这里加字段（如数学块、脚注、批注…）；
 *  - 提供者（EditorMenuProvider）：`when(ctx)` 决定是否出场，`build(ctx)` 产出分区，
 *    新增一类功能＝新增一个提供者文件并注册，菜单组件完全不用改；
 *  - 动作（EditorMenuAction）：带稳定 id 的可执行项，id 供提供者按表引用。
 * 菜单组件只认识 EditorMenuSection[]，不认识编辑器命令，因此 UI 与编辑器解耦。
 */

/** 动作在菜单中的视觉分组类型：toolbar = 顶部横向图标行，list = 下方列表分区，
 *  spell = 拼写建议（顶部独立区块：建议词 + 添加到词典 + 忽略） */
export type EditorMenuVariant = 'toolbar' | 'list' | 'spell'

export interface EditorMenuAction {
  /** 稳定标识（如 table.rowBelow）：提供者按它从动作表里取项 */
  id: string
  /** i18n key（editorMenu.*） */
  labelKey: string
  /**
   * 覆盖显示文本（**用户数据**，不是 i18n key）。目前只有拼写建议用它 ——
   * 词典给的候选词必须原样显示，不能走 `t()`。
   */
  label?: string
  /** spell 分区里的视觉/语义分类：建议词 vs 动作（添加到词典/忽略） */
  kind?: 'suggestion' | 'action'
  /** 图标名（见 components/Icon.vue） */
  icon?: string
  /** 展示用快捷键提示（本地化文本） */
  shortcut?: string
  /** 悬停说明（i18n key；用于"忽略"这类需要讲清取舍的项） */
  hintKey?: string
  /** 危险动作（删除表格/行/列）用红色呈现 */
  danger?: boolean
  disabled?: boolean
  /** 执行；返回 false 表示未执行（例如用户取消了对话框） */
  run: () => boolean | void | Promise<boolean | void>
  /** 执行后是否把焦点交还编辑器（默认 true） */
  refocus?: boolean
}

export interface EditorMenuSection {
  id: string
  /** 分区标题的 i18n key；toolbar 分区不需要标题 */
  labelKey?: string
  variant: EditorMenuVariant
  items: EditorMenuAction[]
  /** spell 分区：被判定拼错的词（纯文本，来自 Chromium 的 misspelledWord） */
  word?: string
}

/** 右键时刻的编辑器场景快照 */
export interface EditorMenuContext {
  editor: Editor
  /** 是否有文本选区（决定复制/剪切是否可用） */
  hasSelection: boolean
  inTable: boolean
  inList: boolean
  inTaskList: boolean
  inBlockquote: boolean
  inCodeBlock: boolean
  /** 当前标题级别；null = 正文 */
  headingLevel: number | null
  /** 光标所在表格的几何信息（不在表格内为 null） */
  table: TableInfo | null
}

export interface TableInfo {
  rows: number
  cols: number
  rowIndex: number
  colIndex: number
}

export interface EditorMenuProvider {
  id: string
  /** 是否在当前场景出场 */
  when: (ctx: EditorMenuContext) => boolean
  /** 产出分区（可返回多个；sortOrder 小的排前面） */
  build: (ctx: EditorMenuContext) => EditorMenuSection[]
  /** 分区排序权重，默认 50 */
  sortOrder?: number
}
