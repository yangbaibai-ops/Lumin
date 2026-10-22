// ─── 快捷键设置：按「按下的组合键」筛选命令（纯函数）─────────────────────────────
//
// 用户口径：「在搜索框里按下 Ctrl+Shift+P，直接把该键已绑定的命令筛出来」。
//
// 规则（全部可单测，不依赖 Vue）：
//   * 只认**带 Ctrl/Cmd/Alt** 的组合键 —— 裸字母/退格属于正常文字输入；
//   * Escape / 单个修饰键 / 纯 Shift 组合不进入按键筛选；
//   * 返回值一律是**规范化**后的表达式（`Ctrl+Alt+T`），与 `resolveCommands().keys` 同口径，
//     否则「按下的键」和「设置里显示的键」会因大小写/别名对不上而筛空。
import { eventToSpec, normalizeSpec } from './keys'

/** 按键事件 → 筛选用的规范表达式；不构成「组合键」时返回 null（交给文字输入） */
export function keyQueryFromEvent(e: KeyboardEvent): string | null {
  if (e.isComposing) return null
  if (e.key === 'Escape') return null
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  // 没有 Ctrl/Cmd/Alt 的一律不算组合键：保证用户还能正常打字/退格
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return null
  const spec = eventToSpec(e)
  if (!spec) return null
  return normalizeSpec(spec)
}

/** 按生效键筛选命令（null = 不筛）；比较前两边都走规范化口径 */
export function filterCommandsByKey<T extends { keys: string | null }>(
  commands: readonly T[],
  keys: string | null
): T[] {
  if (!keys) return [...commands]
  const target = normalizeSpec(keys)
  if (!target) return [...commands]
  return commands.filter((c) => c.keys === target)
}

/** 该组合键是否被多条命令占用（用于「按键筛选」时的冲突提示） */
export function isConflictingKey<T extends { conflictWith: string[] }>(
  commands: readonly T[]
): boolean {
  return commands.some((c) => c.conflictWith.length > 0)
}
