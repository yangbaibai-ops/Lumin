import { defineStore } from 'pinia'
import type { RecentFile, RecentFolder } from '../../../shared/types'
import { useSettingsStore } from './settings'
import {
  planRecentFolderList,
  planRemoveRecent,
  planRemoveRecentFolder,
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
    removeFile(path: string): void {
      const settings = useSettingsStore()
      settings.set('recentFiles', planRemoveRecent(settings.recentFiles, path))
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
      settings.set('recentFolders', planRemoveRecentFolder(settings.recentFolders ?? [], dir))
    },
    /** 最近文件夹列表：并入「当前工作区」（老用户可能没记录过，避免空列表） */
    folderList(root: string | null): RecentFolder[] {
      const settings = useSettingsStore()
      return planRecentFolderList(settings.recentFolders ?? [], root, Date.now())
    },
    clearFiles(): void {
      useSettingsStore().set('recentFiles', [])
    },
    clearFolders(): void {
      useSettingsStore().set('recentFolders', [])
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
