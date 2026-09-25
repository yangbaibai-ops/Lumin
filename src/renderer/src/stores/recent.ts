import { defineStore } from 'pinia'
import type { RecentFile, RecentFolder } from '../../../shared/types'
import { useSettingsStore } from './settings'
import { useNotificationsStore } from './notifications'
import i18n from '../i18n'
import {
  RECENT_REMOVE_KIND,
  planMigratePinned,
  planMigrateWithin,
  planRecentFolderList,
  planRemovePinnedWithin,
  planRemoveRecent,
  planRemoveRecentFolder,
  planRemoveWithin,
  planRestoreRecent,
  planRestoreRecentFolder,
  planTogglePin,
  planTouchRecent,
  planTouchRecentFolder
} from '../lib/recent'

/**
 * ─── 最近文档 / 最近文件夹 / 置顶 ─────────────────────────────────────────────
 *
 * 为什么单独一个 store（而不是继续挂在 `files` 上）：
 * 这些数据的归属是「用户开过什么」，与「当前工作区 / 当前文档」是**两件事** ——
 * 关掉所有文档、切换工作区、甚至工作区打不开时，这份历史都还在。挂在 `files` 上时
 * 它既管文档生命周期又管历史列表，职责与行数一起膨胀（评审报告 Wave 5 那条「store 拆分」）。
 *
 * 边界很清楚：
 *   * 「列表怎么变」（去重、置顶优先、截断、并入当前工作区）全在 `lib/recent.ts` 的纯函数里，
 *     有单测；**本 store 只负责把结果落盘 + 给 UI 一个排好序的视图**；
 *   * 落盘仍走 `settings`（SQLite kv），所以键名与既有数据完全不变（升级不需要迁移）；
 *   * 不反过来 import `files` store：需要工作区根目录的地方（`folders()`）由调用方传进来，
 *     避免两个 store 互相引用。
 */
export const useRecentStore = defineStore('recent', {
  getters: {
    /** 最近文档：置顶优先 + 按打开时间倒序（不截断，UI 按需 `slice`） */
    files(state): RecentFile[] {
      void state
      const settings = useSettingsStore()
      const pinned = new Set(settings.pinnedFiles)
      return [...settings.recentFiles].sort(
        (a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.openedAt - a.openedAt
      )
    },
    /** 被置顶的路径（集合化，供列表做 O(1) 判断） */
    pinnedPaths(): Set<string> {
      return new Set(useSettingsStore().pinnedFiles)
    },
    /** 是否有任何历史（空列表时 UI 直接给一句「暂无」） */
    isEmpty(): boolean {
      const settings = useSettingsStore()
      return settings.recentFiles.length === 0 && (settings.recentFolders ?? []).length === 0
    }
  },
  actions: {
    /** 打开文件时记一笔（去重 + 置顶优先 + 上限 30，跨会话保留在 SQLite kv） */
    touchFile(path: string): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', planTouchRecent(settings.recentFiles, path, Date.now()))
    },
    /**
     * 从最近列表里去掉一条。
     * @param undo 要不要给「撤销」通知。**默认给**（用户在列表上亲手点的移除）；
     *   文件被删除/改名等"顺带清掉死链"的场景传 `false` —— 那时用户已经在处理别的事，
     *   再飘一张"已从列表移除"的卡只会让人觉得应用在自言自语（`files.removeNode`）。
     */
    removeFile(path: string, undo = true): void {
      const settings = useSettingsStore()
      const entry = (settings.recentFiles ?? []).find((r) => r.path === path)
      if (!entry) return
      settings.set('recentFiles', planRemoveRecent(settings.recentFiles, path))
      if (undo) offerUndo('files', entry)
    },
    /** 置顶/取消置顶（置顶项在列表里永远排前面，不受 30 条上限挤掉） */
    togglePin(path: string): void {
      const settings = useSettingsStore()
      settings.set('pinnedFiles', planTogglePin(settings.pinnedFiles, path))
    },
    /** 打开文件夹时记一笔（去重 + 置顶 + 上限 12） */
    touchFolder(dir: string): void {
      const settings = useSettingsStore()
      settings.set(
        'recentFolders',
        planTouchRecentFolder(settings.recentFolders ?? [], dir, Date.now())
      )
    },
    removeFolder(dir: string): void {
      const settings = useSettingsStore()
      const entry = (settings.recentFolders ?? []).find((f) => f.path === dir)
      if (!entry) return
      settings.set('recentFolders', planRemoveRecentFolder(settings.recentFolders ?? [], dir))
      offerUndo('folders', entry)
    },
    /** 最近文件夹列表：并入「当前工作区」（老用户可能没记录过，避免空列表） */
    folderList(root: string | null): RecentFolder[] {
      const settings = useSettingsStore()
      return planRecentFolderList(settings.recentFolders ?? [], root, Date.now())
    },
    clearFiles(): void {
      useSettingsStore().set('recentFiles', [])
    },
    /**
     * 目录被改名/搬家：把最近文档、置顶、最近文件夹里落在该目录内的路径一起搬过去。
     * 不搬的话菜单里的"最近打开"点一下就是"文件不存在"（审计 §2 P1 第 124 条）。
     */
    migrateWithin(fromDir: string, toDir: string): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', planMigrateWithin(settings.recentFiles, fromDir, toDir))
      settings.set('pinnedFiles', planMigratePinned(settings.pinnedFiles, fromDir, toDir))
      settings.set('recentFolders', planMigrateWithin(settings.recentFolders ?? [], fromDir, toDir))
    },
    /** 目录被删除：把落在它里面的条目从三份列表里去掉（留着就是一堆死链） */
    dropWithin(dir: string): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', planRemoveWithin(settings.recentFiles, dir))
      settings.set('pinnedFiles', planRemovePinnedWithin(settings.pinnedFiles, dir))
      settings.set('recentFolders', planRemoveWithin(settings.recentFolders ?? [], dir))
    },
    clearFolders(): void {
      useSettingsStore().set('recentFolders', [])
    },
    /**
     * 撤销一次「从列表移除」：按原时间放回（`planRestoreRecent*`）。
     * 由 `lib/recentUndo.ts` 注册的通知处理器调用 —— 点通知卡上的「撤销」走到这里。
     */
    restoreFile(entry: RecentFile): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', planRestoreRecent(settings.recentFiles, entry))
    },
    restoreFolder(entry: RecentFolder): void {
      const settings = useSettingsStore()
      settings.set('recentFolders', planRestoreRecentFolder(settings.recentFolders ?? [], entry))
    },
    /** 清空全部历史（含置顶）：最近列表的下拉里有这个入口 */
    clearAll(): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', [])
      settings.set('recentFolders', [])
      settings.set('pinnedFiles', [])
    }
  }
})

/**
 * 移除一条记录后给一张带「撤销」的通知（审计 §8 P2「危险/不可逆操作还缺确认与撤销」）。
 *
 * 为什么这里用**撤销**而不是二次确认：这份列表是"我开过什么"，删掉一条不碰磁盘上的文件，
 * 也不影响任何数据 —— 弹模态反而比误点更烦。给一张能撤销的通知是更合适的代价。
 * 而**整份清空**（RecentList 的「清除记录」、链接历史的「清空」）是不可逆的，那些走确认。
 *
 * 负载里带上被移除的整条记录（可 JSON 序列化），重启后卡片上的按钮仍然可用；
 * 处理器按 `RECENT_REMOVE_KIND` 在启动时注册（`lib/recentUndo.ts`）。
 */
function offerUndo(list: 'files' | 'folders', entry: RecentFile | RecentFolder): void {
  const name = 'title' in entry ? entry.title : entry.name
  void useNotificationsStore()
    .notify({
      level: 'info',
      title: i18n.global.t('open.removeRecentDone', { name }),
      actions: [{ id: 'undo', label: i18n.global.t('common.undo'), tone: 'ghost' }],
      /**
       * ⚠️ `{ ...entry }` 不是多余的：`entry` 来自 settings store 的 state，
       * 是个 **Pinia 响应式 Proxy**，而 Proxy 过不了 IPC 的结构化克隆
       * （`An object could not be cloned`）—— 通知会静默退化成"只在本会话可见"，
       * 重启后卡片和它的撤销按钮一起消失。展开一次拿到普通对象再发。
       */
      payload: { kind: RECENT_REMOVE_KIND, list, entry: { ...entry } },
      // 同一个路径只占一个卡片位（反复移除/撤销不会刷屏）
      mergeKey: `recent-removed:${entry.path}`
    })
    .catch(() => {})
}
