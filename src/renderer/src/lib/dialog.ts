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

/** 直接问「未保存的更改要丢弃吗」（调用方已确认确实有未保存内容） */
export async function confirmDiscardChanges(): Promise<boolean> {
  const ui = useUiStore()
  return ui.confirm({
    title: i18n.global.t('editor.dirtyConfirmTitle'),
    body: i18n.global.t('editor.dirtyConfirmBody'),
    danger: true
  })
}

/** 脏了才问；干净直接放行（返回 true = 可以继续） */
export async function confirmDiscardIfDirty(dirty: boolean): Promise<boolean> {
  if (!dirty) return true
  return confirmDiscardChanges()
}
