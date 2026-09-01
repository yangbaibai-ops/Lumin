// ─── 主进程：持久化存储（electron-store）──────────────────────────────────
import { app } from 'electron'
import Store from 'electron-store'
import { defaultSettings } from '../shared/defaults'

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

/** 应用数据目录（草稿等） */
export const dataDir = app.getPath('userData')
