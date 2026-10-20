// ─── 主进程：持久化存储 ────────────────────────────────────────────────────
// 设置 / 工作区状态统一落 SQLite kv 表（见 services/database.ts）；
// electron-store 仅保留为历史版本配置的一次性迁移源。
//
// ─── 为什么改成「用到时候才 require」（启动性能，实测）──────────────────────────
// 这里原先在**模块顶层** `new Store(...)` 两个实例，于是每次启动都要：
//   ① 加载 electron-store 的模块图（conf → ajv → …，实测 ≈48ms）；
//   ② 读一遍 <userData>/config.json 与 workspace.json，并用 ajv 编译 schema。
// 但这两份历史配置**只在 kv 还没有对应数据时才需要**（全新安装 / 从旧版本升级的第一次），
// 正常启动时 `migrateLegacyStores()` 的两个 `kvHas` 都是 true，上面两笔开销纯属白付。
// 现在改成：先查 kv，确实缺数据才 `createRequire` 加载并构造实例。正常启动零成本。
import { createRequire } from 'node:module'
import type Store from 'electron-store'
import { defaultSettings } from '../shared/defaults'
import type { AppSettings } from '../shared/types'
import { db } from './services/database'

/** 主进程由 electron-vite 打成 CommonJS，`__filename` 在运行时一定存在 */
const requireCjs = createRequire(__filename)

interface WorkspaceState {
  root: string | null
  expanded: string[]
}

/** 迁移专用的 electron-store 实例（只在真的缺 kv 数据时才构造，见文件头说明） */
function openLegacyStores(): {
  settings: Store<AppSettings>
  workspace: Store<WorkspaceState>
} {
  // 类型用 `import type`（编译期擦除），值走 createRequire（运行期才加载）
  const StoreCtor = requireCjs('electron-store') as typeof Store
  return {
    settings: new StoreCtor<AppSettings>({ name: 'config', defaults: defaultSettings }),
    workspace: new StoreCtor<WorkspaceState>({
      name: 'workspace',
      defaults: { root: null, expanded: [] }
    })
  }
}

/** 一次性迁移：老版本 electron-store 数据种入 SQLite kv（kv 已有数据时跳过） */
export function migrateLegacyStores(): void {
  const needSettings = !db.kvHas('settings')
  const needWorkspace = !db.kvHas('workspace')
  // 绝大多数启动走到这里就返回：不加载 electron-store、不读旧 JSON
  if (!needSettings && !needWorkspace) return

  const { settings, workspace } = openLegacyStores()
  if (needSettings) {
    db.kvSet('settings', settings.store)
  }
  if (needWorkspace) {
    db.kvSet('workspace', {
      root: workspace.get('root'),
      expanded: workspace.get('expanded')
    })
  }
}
