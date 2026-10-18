/**
 * ─── 全局撤销/重做的「按键归属」判定（纯函数）─────────────────────────────
 *
 * 背景（用户报障）：把 mermaid 源码框里的修改提交、焦点落到块外之后按 `Ctrl+Z`
 * 撤不掉。实测真因是 **事件没到编辑器**，不是历史没记：
 *   * `commitMermaid()` 的写回事务是普通事务（`tr.getMeta('addToHistory') === undefined`），
 *     `editor.commands.undo()` 一条命令就能把源码逐字还原；
 *   * 但点状态栏 / 正文下方留白之后 `document.activeElement === <body>`，
 *     ProseMirror 的 keymap 挂在编辑器 DOM 上，根本收不到这个按键。
 *
 * 修法是在**应用层**兜底：焦点不在任何编辑面里时，把 `Ctrl/Cmd+Z` 交给主编辑器的
 * `undo()/redo()`（复用同一份 history，不另建撤销栈）。这里只放判定逻辑，便于单测：
 *
 *   * `historyIntent()`：这个按键是不是撤销/重做（含 `Shift` 重做、`Ctrl+Y`）；
 *   * `isNestedEditorTarget()`：焦点/事件目标是否属于**某个编辑面** —— 是就绝不抢。
 *     嵌套编辑面各自有本地历史：mermaid 源码框（textarea）、公式源码框、代码块里的
 *     CodeMirror、源码模式的 textarea。抢过来会变成「一次按键同时撤两处」。
 *
 * 注意 `.ProseMirror` 也算编辑面：焦点在正文里时由 ProseMirror 自己的 keymap 处理，
 * 应用层不重复接（同一个按键只允许一个主人）。
 */

export type HistoryIntent = 'undo' | 'redo'

/** 判定按键所需的字段子集（KeyboardEvent 天然满足；单测可传普通对象） */
export interface HistoryKeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

/**
 * 这个按键要不要触发全局撤销/重做。
 *
 * 口径与 ProseMirror / CodeMirror 的内置绑定一致：
 *   * `Ctrl/Cmd+Z` = 撤销；
 *   * `Ctrl/Cmd+Shift+Z` = 重做；
 *   * `Ctrl+Y`（Windows 习惯）= 重做。
 * `Alt` 参与的组合一律让行（避免和窗口/菜单快捷键撞车）；IME 组字期间的按键不接。
 * 调用方在 **window 捕获阶段**（见 views/EditorView.vue），此时内层处理器还没跑，
 * 所以不需要读 `defaultPrevented`（读了反而会被拖放那边 `@*.prevent` 的陷阱误伤）。
 */
export function historyIntent(e: HistoryKeyLike): HistoryIntent | null {
  if (e.isComposing) return null
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  // 大写 Z（Shift）也要认：`e.key` 在 Shift 下是 'Z'
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (key !== 'z' && key !== 'y') return null
  return key === 'y' || e.shiftKey ? 'redo' : 'undo'
}

/** 判定编辑面所需的最小元素形状（DOM Element 天然满足；单测可传普通对象） */
export interface EditorTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** 这些容器里的按键归各自编辑器：mermaid/公式 textarea、CodeMirror、源码模式、正文 */
const EDITOR_SURFACE_SELECTOR = '.ProseMirror, .cm-editor, .source-editor'

/**
 * 事件目标是否在某个编辑面里（是 ⇒ 全局撤销不接这个按键）。
 *
 * 为什么 textarea/input/contenteditable 要单独判：它们可能不在任何编辑面容器里
 * （查找栏、设置对话框、命令面板…），但这些控件自己的撤销语义必须保留。
 */
export function isNestedEditorTarget(target: EditorTargetLike | null | undefined): boolean {
  if (!target) return false
  const tag = String(target.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  if (typeof target.closest !== 'function') return false
  return !!target.closest(EDITOR_SURFACE_SELECTOR)
}
