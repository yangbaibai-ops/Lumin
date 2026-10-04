// ─── 设置的 schema 版本与归一（审计 §6 P2「设置没有 schema 版本，删改设置项会留孤儿值」）──
//
// 问题是什么：设置是**一坨 JSON 落在 kv 里**的（`settings` 键），启动时 `{...defaults}` 再 patch，
// 所以"新加的键"能自动补上（缺键回落默认值），但**删掉或改名的键会永远留在里面**：
//   * kv 里攒着一堆没人读的字段（老用户升级后越攒越多）；
//   * 下一次 `settings:update` 把整份 state 写回去时，这些孤儿又跟着回来；
//   * 想给"改名后的键"做迁移时无法判断数据到底是哪一版写的。
//
// 这里给出一条**唯一的口径**：`normalizeSettings()` —— 只认 defaults 里有的键（其余记为
// `dropped`）、缺的补默认值、形状不对的（类型不符）也退回默认值，最后盖上 `settingsVersion`。
// 纯函数、不碰 fs/DB，`node --test` 直接跑（tests/settingsSchema.test.mjs）。
//
// 边界（有意不做的事）：**只查形状，不查取值域** —— 例如 `theme: 'darkk'` 这种"类型对、
// 值非法"的项会被原样保留。取值域校验要维护第二份枚举表（defaults 里已经有真值），
// 收益不抵漂移风险；真出问题时的表现是"那一项看起来没生效"，而不是崩溃。
import type { AppSettings } from './types'

/**
 * 当前 schema 版本。**改设置项的形状/语义（删键、改名、改单位）时必须 +1**，
 * 并在下面的 `MIGRATIONS` 里补一条迁移；只"新增带默认值的键"不需要动版本
 * （缺键回落默认值这条路径本来就覆盖了）。
 */
export const SETTINGS_SCHEMA_VERSION = 1

/**
 * 历史版本的迁移（版本号 → 把老结构改成新结构）。键名是**起始版本**：
 * `MIGRATIONS[1]` 表示"把 v1 的数据迁到 v2"。
 *
 * 目前只有 v1，表是空的 —— 留着它是因为"迁移该写在哪"这件事必须在**第一次改 schema 之前**
 * 就有答案，否则那次改动会顺手把迁移逻辑塞进 IPC 处理器里（散落、无测试、无版本判断）。
 */
export const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> =
  {}

/**
 * 值本身是**用户自定义映射**的键：不能用 defaults 的键集合去裁剪（会被裁成空对象）。
 * `keybindings` 是 `{ 命令 id: 键位 }`，命令 id 由代码侧的注册表决定，defaults 里只有 `{}`。
 */
const FREE_FORM = new Set<string>(['keybindings'])

/** 形状兼容的取值：类型不合就退回默认值（`null` 作默认值时不判类型，如 backupDir 是 string|null） */
function pickValue(
  key: string,
  raw: Record<string, unknown>,
  fallback: unknown,
  path: string
): {
  value: unknown
  changed: boolean
  dropped: string[]
} {
  const value = raw[key]
  if (value === undefined) return { value: fallback, changed: true, dropped: [] }
  if (FREE_FORM.has(key)) return { value, changed: false, dropped: [] }
  if (Array.isArray(fallback)) {
    return Array.isArray(value)
      ? { value, changed: false, dropped: [] }
      : { value: fallback, changed: true, dropped: [] }
  }
  if (fallback === null) return { value, changed: false, dropped: [] }
  if (typeof fallback === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { value: fallback, changed: true, dropped: [] }
    }
    const nested = normalizeObject(
      value as Record<string, unknown>,
      fallback as Record<string, unknown>,
      path ? `${path}.${key}` : key
    )
    return { value: nested.value, changed: nested.changed, dropped: nested.dropped }
  }
  return typeof value === typeof fallback
    ? { value, changed: false, dropped: [] }
    : { value: fallback, changed: true, dropped: [] }
}

/** 逐键归一（顶层与嵌套对象共用）；`path` 只用于把丢掉的键写成 `export.foo` 这种可读形式 */
function normalizeObject(
  raw: Record<string, unknown>,
  defaults: Record<string, unknown>,
  path = ''
): { value: Record<string, unknown>; changed: boolean; dropped: string[] } {
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  let changed = false
  for (const key of Object.keys(defaults)) {
    const picked = pickValue(key, raw, defaults[key], path)
    out[key] = picked.value
    if (picked.changed) changed = true
    dropped.push(...picked.dropped)
  }
  for (const key of Object.keys(raw)) {
    if (key in defaults) continue
    dropped.push(path ? `${path}.${key}` : key)
  }
  return { value: out, changed: changed || dropped.length > 0, dropped }
}

/** 归一结果：`changed` = 与 kv 里存的那份不同（不同就要写回一次） */
export interface NormalizeResult {
  settings: AppSettings
  /** 被丢掉的键（含嵌套路径），便于调用方决定要不要记日志 */
  dropped: string[]
  /** 归一后的结果与原值是否不同（不同就要写回，否则每次启动都在原地打转） */
  changed: boolean
}

/**
 * 把 kv 里读到的任意东西归一成一份合法的 `AppSettings`。
 * 输入不是对象（null / 字符串 / 数组）时整份回落默认值 —— kv 被外部改坏也不该让启动崩。
 */
export function normalizeSettings(raw: unknown, defaults: AppSettings): NormalizeResult {
  const source = normalizeSource(raw)
  for (let v = versionOf(source); v < SETTINGS_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v]
    if (migrate) Object.assign(source, migrate(source))
  }
  const { value, changed, dropped } = normalizeObject(
    source,
    defaults as unknown as Record<string, unknown>
  )
  const settings = {
    ...(value as unknown as AppSettings),
    settingsVersion: SETTINGS_SCHEMA_VERSION
  }
  return {
    settings,
    dropped,
    /**
     * ⚠️ 判据里**不要**加"原值 ⇄ 归一结果逐字段比较"：kv 里的键顺序与 defaults 不同，
     * 那种比较会恒为"变了"，于是每次启动都写一次库。这里只用三个**会收敛**的信号：
     * 缺键/形状不符（写回后消失）、丢了孤儿键（写回后消失）、版本号不同（写回后消失）。
     */
    changed: changed || dropped.length > 0 || versionOf(source) !== SETTINGS_SCHEMA_VERSION
  }
}

function normalizeSource(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) }
  }
  return {}
}

/** 已记录的版本号；缺字段/非法值都按 0 处理（= 比任何版本都老，会依次走完所有迁移） */
export function versionOf(raw: Record<string, unknown>): number {
  const v = raw.settingsVersion
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/**
 * 浅层对象深度合并（嵌套对象递归；数组整体替换；`undefined` 不覆盖）。
 *
 * 从 `main/ipc.ts` 搬到这里（报告 §3.2 P0-1 的顺手收口）：主进程现在有两个调用方
 * （IPC 的 `settings:update` 与原生菜单的主题项），留着两份实现迟早会漂。
 * 纯函数、无 IO，`tests/settingsPatch.test.mjs` 直接钉住语义（数组替换 / undefined 跳过 / 深合并）。
 */
export function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}
