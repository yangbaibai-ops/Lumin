// ─── 诊断信息：一处生成、**可单测**的纯函数（审计 §9 P1）─────────────────────
//
// 用户报「卡 / 闪退 / 保存不了」时，我们需要的是一组**可复现的环境事实**：
// 版本、平台、Electron/Chromium/Node 版本、启动参数、设置快照、最近的错误通知、日志路径。
// 而**绝对不需要**文档内容 —— 那既涉及隐私，也不是诊断问题所需。
//
// 所以这里做成纯函数：主进程只负责把原始数据收集起来（`app:getDiagnostics`），
// 组装与"该去掉什么"全在这一个可单测的地方（`tests/diagnostics.test.mjs`）：
//   * `recentFiles` / `recentFolders` 这类**路径清单**必须去掉（那是用户看过什么，不是环境）；
//   * 最近错误只留 level/title/时间，**不带 body**（body 里可能是文档片段）；
//   * 明确标注"本文件不含文档内容"，让用户敢直接贴出来。
import type { AppSettings, AppNotification } from './types'

/** 主进程收集到的原始事实（渲染层不再加工） */
export interface DiagnosticsInput {
  appVersion: string
  platform: string
  arch: string
  electron: string
  chrome: string
  node: string
  v8?: string
  packaged: boolean
  userData: string
  dbPath: string
  /** 日志文件的绝对路径（构建指纹 / 启动日志等） */
  logs: { label: string; path: string }[]
  /** 启动参数（已由主进程剔除个人路径类参数） */
  launchArgs: string[]
  settings: AppSettings
  /** 最近的**错误级**通知（只取标题与时间） */
  recentErrors: Pick<AppNotification, 'level' | 'title' | 'createdAt'>[]
  startedAt?: string
}

/** 翻译函数（主进程传 `mainT`，单测传假的）：诊断文本的头尾标题也走语言包 */
export type DiagnosticsTranslate = (key: string, params?: Record<string, string | number>) => string

/**
 * 设置快照里必须去掉的键：它们记的是"用户看过哪些文件"，不是环境事实。
 * 导出（`export`）成唯一口径：设置文件的导出/导入也用这一份（见 `shared/settingsFile.ts`），
 * 免得"哪些字段算隐私"出现第二份清单。
 */
export const PRIVATE_SETTING_KEYS = ['recentFiles', 'recentFolders'] as const

/** 设置快照：去掉私有路径清单后按 JSON 输出（键排序，便于对比两次诊断） */
export function settingsSnapshot(settings: AppSettings): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(settings as unknown as Record<string, unknown>) }
  for (const k of PRIVATE_SETTING_KEYS) delete copy[k]
  return Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b)))
}

/** 启动参数里剔除可能是个人路径的项（`--lumin-open=…` / `--lumin-open-folder=…`） */
export function safeLaunchArgs(argv: string[]): string[] {
  return argv.filter((a) => !/^--lumin-(open|open-folder)=/.test(a))
}

/** 最近错误：只留 level/title/时间，最多 10 条（body 可能含文档片段，一律不带） */
export function recentErrorLines(errors: DiagnosticsInput['recentErrors']): string[] {
  return errors
    .filter((e) => e.level === 'error')
    .slice(0, 10)
    .map((e) => `- [${e.createdAt}] ${e.title}`)
}

/**
 * 组装成一段可直接贴进 issue 的文本。
 * 结构固定、无嵌套缩进超过两级 —— 贴进 issue 后仍然可读，也方便我们 gist 解析。
 */
export function buildDiagnosticsText(d: DiagnosticsInput, t: DiagnosticsTranslate): string {
  const lines: string[] = [
    `# ${t('diagnostics.title')}`,
    '',
    `> ${t('diagnostics.note')}`,
    '',
    `## ${t('diagnostics.versions')}`,
    `- Lumin: ${d.appVersion}${d.packaged ? '' : t('diagnostics.devBuild')}`,
    `- ${t('diagnostics.platform')}: ${d.platform} ${d.arch}`,
    `- Electron: ${d.electron}`,
    `- Chromium: ${d.chrome}`,
    `- Node: ${d.node}${d.v8 ? ` (V8 ${d.v8})` : ''}`,
    ...(d.startedAt ? [`- ${t('diagnostics.startedAt')}: ${d.startedAt}`] : []),
    '',
    `## ${t('diagnostics.paths')}`,
    `- userData: ${d.userData}`,
    `- ${t('diagnostics.db')}: ${d.dbPath}`,
    ...d.logs.map((l) => `- ${t('diagnostics.log', { label: l.label })}: ${l.path}`),
    '',
    `## ${t('diagnostics.args')}`,
    ...(d.launchArgs.length ? d.launchArgs.map((a) => `- ${a}`) : [`- ${t('diagnostics.none')}`]),
    '',
    `## ${t('diagnostics.settings')}`,
    '```json',
    JSON.stringify(settingsSnapshot(d.settings), null, 2),
    '```',
    '',
    `## ${t('diagnostics.errors')}`,
    ...(recentErrorLines(d.recentErrors).length
      ? recentErrorLines(d.recentErrors)
      : [`- ${t('diagnostics.none')}`]),
    ''
  ]
  return lines.join('\n')
}
