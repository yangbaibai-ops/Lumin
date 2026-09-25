// ─── 主进程：持久化存储 ────────────────────────────────────────────────────
// 设置 / 工作区状态统一落 SQLite kv 表（见 services/database.ts）；
// electron-store 仅保留为历史版本配置的一次性迁移源。
import Store from 'electron-store'
import { defaultSettings } from '../shared/defaults'
import { db } from './services/database'

export const settingsStore = new Store({
  name: 'config',
  defaults: defaultSettings
})

interface WorkspaceState {
  root: string | null
  expanded: string[]
}

export const workspaceStore = new Store<WorkspaceState>({
  name: 'workspace',
  defaults: { root: null, expanded: [] }
})

/** 一次性迁移：老版本 electron-store 数据种入 SQLite kv（kv 已有数据时跳过） */
export function migrateLegacyStores(): void {
  if (!db.kvHas('settings')) {
    db.kvSet('settings', settingsStore.store)
  }
  if (!db.kvHas('workspace')) {
    db.kvSet('workspace', {
      root: workspaceStore.get('root'),
      expanded: workspaceStore.get('expanded')
    })
  }
}
