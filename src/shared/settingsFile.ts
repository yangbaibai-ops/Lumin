// ─── 设置文件（导出 / 导入）的**纯函数**（审计清单「设置/快捷键导入导出、恢复默认」）──
//
// 缺口是什么：设置面板早就有「恢复默认」（`settings.reset()` + 二次确认），但**没有任何**
// 把当前设置（含自定义快捷键）带走、或从另一台机器带回来的路径 —— 换机只能一项项手点。
//
// 为什么单独成文件、而且全是纯函数：导入的文件是**不可信输入**（可能被人手改过、可能是别的
// 东西），所以三道闸必须能被单测直接钉死，而不是散在 IPC 处理器与 Vue 组件里：
//   ① **信封校验**：`{ app, version, exportedAt, payload }`；`app` 不认得、`version` 比本应用新
//      ⇒ 直接拒绝（"不认识就拒绝"是唯一安全的选择，猜版本的代价是把用户的设置改坏）；
//   ② **白名单过滤**：只认 `defaultSettings` 里存在的**顶层**键；未知键丢弃并记账，绝不原样落库。
//      （落地前还会再过一次 `settingsSchema` 的归一，嵌套里的多余键由那一层丢。）
//   ③ **隐私剔除**：`recentFiles` / `recentFolders`（= 用户看过哪些文件、在哪些目录里翻过）
//      **永不导出、也永不接受**。这份口径与诊断信息共用一处实现
//      （`shared/diagnostics.ts` 的 `PRIVATE_SETTING_KEYS`），不另写第二份。
// 外加一条针对**路径类字段**的判据（见下面的 `PATH_SETTING_KEYS` / `unsafePathKey`）。
//
// 归一（缺键补默认值、形状不符退默认值、老版本走迁移）**一定**要再过一遍
// `shared/settingsSchema.ts` 的 `normalizeSettings()`：导出件与 kv 里读到的老数据是同一类东西，
// 不能因为"它来自我们自己的导出"就跳过迁移 —— 今天的导出件，明天就是老版本的数据。
//
// 导出件的信封字段（也是导入时的校验依据）：
//   app        `'lumin-settings'`（认这个字符串才认这个文件）
//   version    信封格式版本（当前 1）；比本应用新 ⇒ 拒绝
//   exportedAt 导出时刻（ISO 8601；只作展示与排障）
//   appVersion 导出方的应用版本（同上，**不参与校验**：跨版本导入是常态）
//   payload    设置本体：白名单内、已剔除隐私键与本机路径键，并保留 `settingsVersion`
import type { AppSettings } from './types'
// 显式 .ts：本文件会被 tests/*.test.mjs 直接加载，Node 的 ESM 解析不做扩展名补全（同 defaults.ts）
import { defaultSettings } from './defaults.ts'
import { SETTINGS_SCHEMA_VERSION, normalizeSettings, versionOf } from './settingsSchema.ts'
import { PRIVATE_SETTING_KEYS } from './diagnostics.ts'

/** 导出件的 `app` 字段值：只有它等于这个字符串的文件才被当成设置文件 */
export const SETTINGS_FILE_APP = 'lumin-settings'

/**
 * 信封格式版本：**信封本身**的结构变了才 +1（与设置的 `settingsVersion` 是两件事，
 * 后者管的是 `payload` 里那些设置项的形状）。
 */
export const SETTINGS_FILE_VERSION = 1

/** 导入文件的大小上限：设置本体只有几 KB，超过这个数一定是拿错了文件（顺手防一手内存） */
export const SETTINGS_FILE_MAX_BYTES = 4 * 1024 * 1024

/**
 * 值**指向本机某个位置**的设置键：导出时不写进文件，导入时按不可信输入校验。
 *
 * 判据（为什么这样切）：
 *   * 这类值只在这台机器上有意义（另一台机器上 `D:\backups` 未必存在），写进"可移植的设置文件"
 *     等于给对方留一个必然失败的目标目录；
 *   * 但它**留在导入白名单里**：手改过的文件仍可能塞一个路径进来，那必须当场拒掉（见下）。
 * 新增路径类设置项时**必须**加到这里 —— 否则它会以"绝对路径"的形态被静默落库。
 */
export const PATH_SETTING_KEYS = ['backupDir'] as const

/** 绝对路径形状：Windows 盘符（`C:\` / `C:/`）、UNC（`\\srv` 或 `//srv`）、POSIX 根（`/x`） */
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/

/** 只有这些位置的路径字段才是合法的：`null`（用默认位置）或**相对**路径 */
export function unsafePathKey(raw: Record<string, unknown>): string | null {
  for (const key of PATH_SETTING_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    // 非字符串、空串/空白、含 NUL、绝对路径、含 `..` 段（`/` 与 `\` 都切分）—— 一律拒
    if (typeof value !== 'string') return key
    if (!value.trim()) return key
    if (value.includes('\0')) return key
    if (ABSOLUTE_PATH_RE.test(value)) return key
    if (value.split(/[\\/]/).includes('..')) return key
  }
  return null
}

/** 白名单过滤的产物（三个都记账，调用方/界面才能说清"文件里有什么被丢了"） */
export interface SettingsKeyFilterResult {
  /** 通过白名单的键值（**原样**，形状归一不在这里做） */
  kept: Record<string, unknown>
  /** 不在白名单里的未知键（丢弃，不猜） */
  unknownKeys: string[]
  /** 命中隐私口径被剔除的键 */
  removedPrivate: string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 只在 `raw` 是普通对象时有内容；否则三项皆空 */
export function filterSettingsKeys(raw: unknown): SettingsKeyFilterResult {
  const kept: Record<string, unknown> = {}
  const unknownKeys: string[] = []
  const removedPrivate: string[] = []
  if (!isPlainObject(raw)) return { kept, unknownKeys, removedPrivate }
  const privateKeys = new Set<string>(PRIVATE_SETTING_KEYS)
  for (const [key, value] of Object.entries(raw)) {
    if (privateKeys.has(key)) {
      removedPrivate.push(key)
      continue
    }
    // ⚠️ 必须用 hasOwnProperty：`'__proto__' in defaultSettings` 为真（原型链），
    // 而 `kept['__proto__'] = …` 改的是原型而不是数据键 —— 那是原型污染，不是设置项。
    if (!Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
      unknownKeys.push(key)
      continue
    }
    kept[key] = value
  }
  return { kept, unknownKeys, removedPrivate }
}

/**
 * 从一份设置里取出**可以写进文件**的那部分：defaults 的顶层键 − 隐私键 − 本机路径键。
 *
 * 用 `Object.keys(defaultSettings)` 而不是另写一份键名表：设置项增删时这里自动跟上，
 * 不会出现"新设置项导不出去"这种需要人去对照两份清单才会发现的漂移。
 */
export function exportableSettings(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const excluded = new Set<string>([...PRIVATE_SETTING_KEYS, ...PATH_SETTING_KEYS])
  const source = settings as unknown as Record<string, unknown>
  for (const key of Object.keys(defaultSettings)) {
    if (excluded.has(key)) continue
    if (key in source) out[key] = source[key]
  }
  return out
}

/** 导出件（信封 + 设置本体）；字段含义见文件头的说明 */
export interface SettingsFileEnvelope {
  app: string
  version: number
  exportedAt: string
  appVersion?: string
  payload: Record<string, unknown>
}

/** 组装导出件。`settings` 就是界面上那份当前设置（导出所见即所得） */
export function buildSettingsFile(
  settings: AppSettings,
  meta: { appVersion?: string; exportedAt?: string } = {}
): SettingsFileEnvelope {
  const envelope: SettingsFileEnvelope = {
    app: SETTINGS_FILE_APP,
    version: SETTINGS_FILE_VERSION,
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    payload: exportableSettings(settings)
  }
  if (meta.appVersion) envelope.appVersion = meta.appVersion
  return envelope
}

/** 序列化：2 空格缩进（人要能读、能手改）+ 结尾换行（文本文件的惯例，diff 也干净） */
export function serializeSettingsFile(envelope: SettingsFileEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/** 默认文件名：`lumin-settings-YYYYMMDD-HHmm.json`（本地时刻，一个目录里能放多份） */
export function settingsFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `lumin-settings-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

/**
 * 把导入的补丁应用到本机当前设置上：**顶层整体替换，不是深合并**。
 *
 * 为什么不能像 `settings:update` 那样递归合并（这是本功能最容易写错的一处）：
 * `keybindings` 是 `{ 命令 id: 键位 }`。深合并下，"导出方只改过 file.save"的补丁会与本机
 * 既有的覆盖项**合并出第三份快捷键表**（两台机器都没有的那份），而 `keybindings: {}`
 * （导出方不用任何自定义键）**永远清不掉**本机的旧键 —— 那就不叫"把设置搬过去"了。
 * 口径：**文件里给了的键整块替换，没给的键保留本机现值**（所以本机的 recentFiles 之类
 * 只可能被"本机自己"改；隐私键也从不进 patch）。
 */
export function mergeImportedSettings(
  current: AppSettings,
  patch: Partial<AppSettings>
): AppSettings {
  return { ...current, ...patch }
}

/** 导入失败的**原因码**（界面按码取语言包文案；码是稳定契约，文案可以随便改） */
export type SettingsImportErrorCode =
  | 'not-json'
  | 'bad-envelope'
  | 'wrong-app'
  | 'unknown-version'
  | 'unsafe-path'
  | 'too-large'
  | 'read-failed'

/** 导入失败：`detail` 只放**字段名 / 解析器给的一句话**（用于定位），不放整份文件内容 */
export interface SettingsImportFailure {
  ok: false
  code: SettingsImportErrorCode
  detail?: string
}

/** 导入成功：`patch` 可以直接交给落库（见 main 的 `settings:applyImport`） */
export interface SettingsImportSuccess {
  ok: true
  /**
   * 归一后的补丁 —— **只含文件里真的给了的顶层键**（缺的键保留本机现值，
   * 隐私键与本机路径键不会出现在这里）。
   */
  patch: Partial<AppSettings>
  /** 生效的顶层键名（界面用来报告"导入了 n 项"） */
  applied: string[]
  /** 被白名单丢掉的未知键 */
  unknownKeys: string[]
  /** 命中隐私口径被剔除的键（导出件里本来不该有；有 = 文件被手改过） */
  removedPrivate: string[]
  /** `settingsSchema` 归一过程中丢掉的键（嵌套路径，如 `export.pdf.legacyFlag`） */
  dropped: string[]
}

export type SettingsImportOutcome = SettingsImportSuccess | SettingsImportFailure

/**
 * 「选文件 + 读文本」这一步的结果（主进程 → 渲染层）。
 * `null` = 用户在对话框里取消；`ok: false` 是**读文件本身**失败（太大 / 读不出来），
 * 内容是否合法由上面的 `parseSettingsFile` 判定。
 */
export type SettingsFileReadResult =
  | { ok: true; path: string; text: string }
  | { ok: false; path: string; code: SettingsImportErrorCode; size?: number }

/**
 * 解析并校验一个设置导出文件（**纯函数**：不碰 fs、不碰 IPC）。
 *
 * 顺序是刻意的：**先校验到能确认"这是一份我们认识的设置文件"，再动任何数据**。
 * 任何一步不过都返回明确的 `code`，绝不"能读多少算多少"地半套用 —— 用户看到的要么是
 * "已导入 n 项"，要么是一句能定位原因的失败，没有第三种。
 */
export function parseSettingsFile(text: string): SettingsImportOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, code: 'not-json', detail: err instanceof Error ? err.message : undefined }
  }
  if (!isPlainObject(raw)) return { ok: false, code: 'bad-envelope', detail: 'root' }
  if (raw.app !== SETTINGS_FILE_APP) return { ok: false, code: 'wrong-app' }
  const version = raw.version
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > SETTINGS_FILE_VERSION
  ) {
    return { ok: false, code: 'unknown-version', detail: 'version' }
  }
  if (!isPlainObject(raw.payload)) return { ok: false, code: 'bad-envelope', detail: 'payload' }
  // 设置项形状的版本：比本应用新 ⇒ 拒绝（我们不知道那些新字段的语义，硬套等于写坏设置）
  if (versionOf(raw.payload) > SETTINGS_SCHEMA_VERSION) {
    return { ok: false, code: 'unknown-version', detail: 'settingsVersion' }
  }
  const { kept, unknownKeys, removedPrivate } = filterSettingsKeys(raw.payload)
  const unsafe = unsafePathKey(kept)
  if (unsafe) return { ok: false, code: 'unsafe-path', detail: unsafe }
  // 必过归一：迁移 → 缺键补默认值 → 形状不符退默认值 → 盖 `settingsVersion`
  const { settings, dropped } = normalizeSettings(kept, defaultSettings)
  const normalized = settings as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(kept)) patch[key] = normalized[key]
  return {
    ok: true,
    patch: patch as Partial<AppSettings>,
    applied: Object.keys(kept),
    unknownKeys,
    removedPrivate,
    dropped
  }
}
