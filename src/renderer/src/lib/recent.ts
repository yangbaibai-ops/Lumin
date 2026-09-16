/**
 * ─── 最近文档 / 最近文件夹 / 置顶 的列表规则（纯函数，可单测）────────────────────
 *
 * 这些规则原先写在 `stores/files.ts` 里、直接读写 settings store，于是：
 *   * 无法单测（要跑一个 Pinia 实例）；
 *   * 「去重 + 置顶 + 截断」这类**容易写错又不容易发现**的逻辑散在四个 action 里。
 * 现在把「列表怎么变」抽成纯函数（输入旧列表 → 输出新列表），store 只负责落盘。
 */

export interface RecentItem {
  path: string
  title: string
  openedAt: number
}

export interface RecentFolderItem {
  path: string
  name: string
  openedAt: number
}

/** 最近文档最多留多少条 */
export const RECENT_FILES_LIMIT = 30
/** 最近文件夹最多留多少条 */
export const RECENT_FOLDERS_LIMIT = 12

/** 路径最后一段（文件名/文件夹名）；纯字符串处理，不碰文件系统 */
export function baseNameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** 打开文档：去重 + 置顶 + 截断 */
export function planTouchRecent(
  list: RecentItem[],
  path: string,
  now: number,
  limit = RECENT_FILES_LIMIT
): RecentItem[] {
  const rest = (list ?? []).filter((r) => r.path !== path)
  return [{ path, title: baseNameOf(path), openedAt: now }, ...rest].slice(0, limit)
}

export function planRemoveRecent(list: RecentItem[], path: string): RecentItem[] {
  return (list ?? []).filter((r) => r.path !== path)
}

/** 置顶/取消置顶（顺序无关：只当集合用） */
export function planTogglePin(list: string[], path: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(path)) set.delete(path)
  else set.add(path)
  return [...set]
}

export function planTouchRecentFolder(
  list: RecentFolderItem[],
  dir: string,
  now: number,
  limit = RECENT_FOLDERS_LIMIT
): RecentFolderItem[] {
  const rest = (list ?? []).filter((f) => f.path !== dir)
  return [{ path: dir, name: baseNameOf(dir), openedAt: now }, ...rest].slice(0, limit)
}

export function planRemoveRecentFolder(list: RecentFolderItem[], dir: string): RecentFolderItem[] {
  return (list ?? []).filter((f) => f.path !== dir)
}

/**
 * 菜单里显示的最近文件夹列表：把「当前工作区」并进去。
 *
 * 为什么要并：历史版本没记过最近文件夹的用户（或刚清空过的）打开菜单会是空的，
 * 而当前工作区明明就在那儿 —— 列表里必须有它，且不重复。
 */
export function planRecentFolderList(
  list: RecentFolderItem[],
  currentRoot: string | null,
  now: number
): RecentFolderItem[] {
  const out = [...(list ?? [])]
  if (currentRoot && !out.some((f) => f.path === currentRoot)) {
    out.unshift({ path: currentRoot, name: baseNameOf(currentRoot), openedAt: now })
  }
  return out
}
