/**
 * ─── 「编辑器里挂起的变更，现在就得落地」的唯一登记口 ──────────────────────────
 *
 * 问题：实时渲染面（Tiptap）是**防抖 250ms** 序列化进 store 的（见 TyporaEditor 的 syncTimer）。
 * 于是「刚打完字 250ms 内换文档 / 关窗」时，那段输入还在编辑器里、没进 store：
 *   * 脏判定（`files.dirty` 读的是 store）看不见它 → 不弹「未保存」确认；
 *   * 换文档时旧编辑器被 `:key` 卸载 → 那段输入直接消失；
 *   * 关窗时 `flushAll` 读的也是 store → 既不保存也不写草稿。
 * 这是"静默丢字"，也是本轮修掉的一类缺陷。
 *
 * 为什么用登记口而不是让 store 直接调编辑器：
 *   `stores/files.ts` 不该认识 Tiptap（那会形成 store → 组件 → store 的循环依赖，
 *   而且会把「编辑器实现」绑进数据层）。这里只留一个**回调**：
 *   拥有编辑器实例的那个组件（EditorView）挂载时登记、卸载时摘掉；
 *   数据层的任何"内容即将被替换"的入口只管调 `flushEditorBeforeReplace()`。
 *
 * 语义要求（调用方据此放心地重复调用）：
 *   * **幂等**：编辑器不脏时是空操作（真正的判断在 `useEditorMode.flushWysiwyg` 里）；
 *   * **绝不抛**：这是收尾路径，不能因为它把换文档/关窗本身弄失败。
 */
type FlushFn = () => void

let impl: FlushFn | null = null

/** 登记（传 null 摘掉）。同一时刻只认最后一个 —— 本项目一个窗口只有一个编辑器实例 */
export function registerEditorFlush(fn: FlushFn | null): void {
  impl = fn
}

/** 当前登记的 flush（用于"摘掉的必须是我自己登记的那一个"这种身份比对，见 EditorView 卸载） */
export function currentEditorFlush(): FlushFn | null {
  return impl
}

/**
 * 把编辑器里挂起的变更刷进数据层。**任何"当前文档要被替换 / 要落盘 / 要关窗"的入口
 * 都应当在做判断之前先调它一次**（见 lib/dialog.confirmDiscardIfDirty、
 * stores/files 的 openPath / close / flushAll）。
 */
export function flushEditorBeforeReplace(): void {
  try {
    impl?.()
  } catch {
    /* 收尾路径：失败也不能把调用方（换文档/关窗）拦下来 */
  }
}
