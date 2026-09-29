/**
 * ─── 对话框：未保存更改确认的**唯一实现**──────────────────────────────────────
 *
 * 背景：这段「脏了就先问」的逻辑此前散在四处（`composables/useAppActions.ts`、
 * `stores/files.ts` 的 reopenWithEncoding、`TreeNode.vue` 的打开文件、`FileList.vue`），
 * 每处各写一遍 `ui.confirm({ title: t('editor.dirtyConfirmTitle'), ... })`。
 * 文案改一次要改四处，漏一处的表现是「两个入口问的话不一样」——典型的一致性债务。
 *
 * 为什么放在 `lib/` 而不是像整改方案里写的 `services/dialog`：
 * 本仓库的 `services/` 是**主进程**的约定（`src/main/services/*`），渲染层没有这一层；
 * 放 `lib/` 与 `lib/errors.ts`、`lib/pathUtils.ts` 同一层级。
 *
 * 关键的依赖方向：这里**只依赖 ui store 与 i18n**，不认识 files store。
 * 「脏不脏」由调用方作为参数传进来 —— 于是 `stores/files.ts` 也能用它，
 * 不会形成 `store → composable → store` 的循环导入（那正是当初复制一份的原因）。
 */

import { useUiStore } from '../stores/ui'
import i18n from '../i18n'
import { flushEditorBeforeReplace } from './editorFlush'
import { planClosePrompt, type CloseReason } from '../../../shared/closePrompt'

/** 直接问「未保存的更改要丢弃吗」（调用方已确认确实有未保存内容） */
export async function confirmDiscardChanges(): Promise<boolean> {
  const ui = useUiStore()
  return ui.confirm({
    title: i18n.global.t('editor.dirtyConfirmTitle'),
    body: i18n.global.t('editor.dirtyConfirmBody'),
    danger: true
  })
}

/**
 * 「脏不脏」的判据：常量，或**惰性求值**的探针。
 *
 * 为什么允许传函数：实时渲染面是**防抖 250ms** 才把内容写进 store 的，调用方若在进入本函数
 * **之前**就 eager 地算好 `files.dirty`，那段时间里的输入不在账上 —— 于是"刚打完字点另一个
 * 文件"既不弹确认、内容也丢（本轮修掉的那条）。传函数则在 flush **之后**才取判据，账是准的。
 */
export type DirtyProbe = boolean | (() => boolean)

/**
 * 脏了才问；干净直接放行（返回 true = 可以继续）。
 *
 * ⚠️ 进入任何"要不要丢弃"的判断之前，先把编辑器里挂起的变更刷进 store
 * （见 `lib/editorFlush.ts`）。这是所有换文档/关闭入口的公共前置动作，放在这里
 * 比在每个调用点各写一遍可靠。
 */
export async function confirmDiscardIfDirty(dirty: DirtyProbe): Promise<boolean> {
  flushEditorBeforeReplace()
  const isDirty = typeof dirty === 'function' ? dirty() : dirty
  if (!isDirty) return true
  return confirmDiscardChanges()
}

/**
 * ─── 关窗前的「是否保存更改？」（用户口径，对齐 Typora）────────────────────────
 *
 * 规则（纯函数 `planClosePrompt` 钉住，单测在 tests/closePrompt.test.mjs）：
 *   * 自动保存开着 → 不问（改动本来就在写盘路上）；
 *   * 系统关机/注销（`session-end`）→ 不问（没人能点那个按钮，问了只会把窗口卡住）；
 *   * 手动保存 + 有未保存改动 → 弹一次「保存 / 不保存 / 取消」。
 *
 * 返回值（`proceed` = 没什么要问的，调用方照旧落盘放行）：
 *   * `save`    —— 用户要保存：调用方去 `files.save()`（未命名文档会走「另存为」）；
 *   * `discard` —— 用户不要这些改动：调用方**不要保存**，并且把草稿一起丢掉；
 *   * `cancel`  —— 用户改主意了：**不关窗**（调用方必须让主进程撤掉这一轮的关窗守卫）。
 *
 * 与 `confirmDiscardIfDirty` 的两个区别：① 那个是二选一（丢/不丢），这个是三选一；
 * ② 那个用于**切换文档**（问的是"离开这篇"），这个用于**关窗**（问的是"要不要保存"）。
 */
export async function resolveCloseIntent(input: {
  autoSave: boolean
  reason: CloseReason
  dirty: DirtyProbe
}): Promise<'save' | 'discard' | 'cancel' | 'proceed'> {
  flushEditorBeforeReplace()
  const isDirty = typeof input.dirty === 'function' ? input.dirty() : input.dirty
  if (
    planClosePrompt({ autoSave: input.autoSave, dirty: isDirty, reason: input.reason }) === 'flush'
  ) {
    return 'proceed'
  }
  const ui = useUiStore()
  const choice = await ui.confirmTriple({
    title: i18n.global.t('close.saveTitle'),
    body: i18n.global.t('close.saveBody'),
    confirmLabel: i18n.global.t('common.save'),
    altLabel: i18n.global.t('close.dontSave')
  })
  if (choice === 'confirm') return 'save'
  if (choice === 'alt') return 'discard'
  return 'cancel'
}
