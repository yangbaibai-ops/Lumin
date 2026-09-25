/**
 * ─── 最近文档 / 最近文件夹 / 置顶 的列表规则（纯函数，可单测）────────────────────
 *
 * 这些规则原先写在 `stores/files.ts` 里、直接读写 settings store，于是：
 *   * 无法单测（要跑一个 Pinia 实例）；
 *   * 「去重 + 置顶 + 截断」这类**容易写错又不容易发现**的逻辑散在四个 action 里。
 * 现在把「列表怎么变」抽成纯函数（输入旧列表 → 输出新列表），store 只负责落盘。
 */
// 目录改名/删除时的路径搬迁与清理：目录边界判定与"搬相对后缀"的唯一实现在 shared/paths.ts
// （显式 .ts：本文件会被 tests/filesRules.test.mjs 直接加载，Node 的 ESM 不做扩展名补全）
import { isInsideByString, migratePathWithin } from '../../../shared/paths.ts'

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

/**
 * 通知负载的 kind：点「撤销」时由 `lib/recentUndo.ts` 接手的处理器按它派发。
 * 常量放在这个**纯函数模块**里，是为了让 store 与处理器双方都能引用而不形成循环 import。
 */
export const RECENT_REMOVE_KIND = 'recent-removed'

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

/**
 * 撤销「从列表移除」：把条目按原 `openedAt` 放回列表（审计 §8 P2「危险/不可逆操作还缺撤销」）。
 *
 * 规则与 `planTouchRecent` 不同：**不刷新时间**、**不置顶**，只把它插回按时间排序的原位置，
 * 并重新受上限约束（列表本来就被截断过）。同路径已存在时原样返回 —— 连点两次「撤销」不会插两条。
 */
export function planRestoreRecent(
  list: RecentItem[],
  entry: RecentItem,
  limit = RECENT_FILES_LIMIT
): RecentItem[] {
  if ((list ?? []).some((r) => r.path === entry.path)) return list ?? []
  return [...(list ?? []), entry].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
}

/**
 * 目录改名/搬家：把列表里**落在该目录内**的路径一起搬到新目录下（审计 §2 P1 第 124 条）。
 *
 * 为什么最近列表也要跟着搬：`documents` 索引与本地历史都由主进程按前缀重写了，
 * 但"最近打开过什么"这份列表活在渲染层的设置里 —— 不搬的话，菜单里的最近文档
 * 仍然指向旧路径，点一下就是"文件不存在"。搬的时候用 `migratePathWithin`
 * （目录边界 + 保留条目自己的名字与时间），列表顺序完全不动。
 */
export function planMigrateWithin<T extends { path: string }>(
  list: T[],
  fromDir: string,
  toDir: string
): T[] {
  return (list ?? []).map((item) => {
    const next = migratePathWithin(item.path, fromDir, toDir)
    return next && next !== item.path ? { ...item, path: next } : item
  })
}

/** 目录被删：把落在它里面的条目从列表里去掉（留着就是一堆点了报错的死链） */
export function planRemoveWithin<T extends { path: string }>(list: T[], dir: string): T[] {
  return (list ?? []).filter((item) => !isInsideByString(dir, item.path))
}

/** 置顶路径列表的两种变更（置顶只是个字符串集合） */
export function planMigratePinned(list: string[], fromDir: string, toDir: string): string[] {
  return planMigrateWithin(
    (list ?? []).map((path) => ({ path })),
    fromDir,
    toDir
  ).map((x) => x.path)
}

export function planRemovePinnedWithin(list: string[], dir: string): string[] {
  return planRemoveWithin(
    (list ?? []).map((path) => ({ path })),
    dir
  ).map((x) => x.path)
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

/** 撤销「从列表移除」（最近文件夹）：同上一条，只插回原位、不刷新时间 */
export function planRestoreRecentFolder(
  list: RecentFolderItem[],
  entry: RecentFolderItem,
  limit = RECENT_FOLDERS_LIMIT
): RecentFolderItem[] {
  if ((list ?? []).some((f) => f.path === entry.path)) return list ?? []
  return [...(list ?? []), entry].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit)
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
