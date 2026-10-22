// ─── 启动诊断日志：可单测的纯规则 ─────────────────────────────────────────────
//
// 背景（用户报障：「安装后启动还是超级慢」，本机 545ms、用户机 5–6s）：
// 启动耗时是**机器相关**量，光靠开发机跑探针永远解释不了用户那 5 秒。所以要有
// **默认开启**的落盘打点：用户把 `startup.log` 发回来，就能看到「慢在哪一段」。
//
// 三条口径（本文件只放纯函数，写盘在 main/services/startupLog.ts）：
//   ① **默认开**、开销极小（一次启动十来行 JSON，同步 append 几十微秒）；
//   ② **有界**：单文件 ≤256KB，最多 5 份（`.log` / `.log.1` … `.log.4`），轮转在写前判；
//      留 5 次是为了让用户能对比「第一次慢、第二次快」（冷/热启动差异、Defender 首次扫描）；
//   ③ **不记隐私**：不写文档内容、不写完整文档路径；路径类信息只留
//      「数量」或「脱敏后的顶层名」（userData 折成 `%APPDATA%\Lumin`）。
//
// 为什么单列一个 shared 模块：主进程写盘、设置页/帮助菜单导出、单测读它，三处必须共用同一套
// 轮转/脱敏/格式规则 —— 各写一份一定会漂。

/** 启动日志文件名（轮转后的上一代是 `<name>.1`，再上一代 `.2`…） */
export const STARTUP_LOG_FILE = 'startup.log'
/** 单份启动日志上限：256KB（约 1000+ 行；一次启动约 15–25 行） */
export const MAX_STARTUP_LOG_BYTES = 256 * 1024
/** 最多保留几份（含当前那份）：5 次启动，便于对比冷/热与「第一次慢、第二次快」 */
export const MAX_STARTUP_LOG_FILES = 5

/** 是否该轮转（`>=`：正好等于上限也换一份，保证单文件不会长过上限） */
export function shouldRotateStartup(size: number, max: number = MAX_STARTUP_LOG_BYTES): boolean {
  return size >= max
}

/**
 * 某份日志轮转后的目标文件名（`startup.log` → `.1`）。只留 `MAX_STARTUP_LOG_FILES` 份：
 * 最老那份（`.4`）在下一轮被删掉，而不是继续往后编号 —— 否则目录会无限长大。
 */
export function rotatedStartupName(index: number): string {
  return `${STARTUP_LOG_FILE}.${index}`
}

/** 轮转计划（纯数据，调用方照做）：删掉最老那份，其余依次后移，当前那份改成 `.1` */
export function startupRotationPlan(maxFiles: number = MAX_STARTUP_LOG_FILES): {
  remove: string | null
  renames: { from: string; to: string }[]
} {
  const keep = Math.max(1, Math.floor(maxFiles))
  const renames: { from: string; to: string }[] = []
  for (let i = keep - 1; i >= 1; i--) {
    renames.push({
      from: i === 1 ? STARTUP_LOG_FILE : rotatedStartupName(i - 1),
      to: rotatedStartupName(i)
    })
  }
  return { remove: keep > 1 ? rotatedStartupName(keep - 1) : null, renames }
}

/**
 * 把绝对路径折成**不含用户名**的标签。
 *
 * 口径：
 *   * `%APPDATA%` / `%LOCALAPPDATA%` / `%USERPROFILE%` 之下的，只把前缀换掉；
 *   * 其它绝对路径只留**最后一段**（顶层名），父目录与用户名都不进日志。
 *
 * ⚠️ 这是「路径脱敏」的唯一实现：主进程写启动日志时只允许通过它（或 `topLevelName`）
 * 把路径写进去，别再就地 `path.basename` / 拼字符串。
 */
export function redactStartupPath(p: string): string {
  if (!p) return ''
  const norm = p.replace(/\//g, '\\')
  const roaming = /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Roaming\\(.+)$/.exec(norm)
  if (roaming) return `%APPDATA%\\${roaming[1]}`
  const local = /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\(.+)$/.exec(norm)
  if (local) return `%LOCALAPPDATA%\\${local[1]}`
  const profile = /^[A-Za-z]:\\Users\\[^\\]+(?:\\(.*))?$/.exec(norm)
  if (profile) return profile[1] ? `%USERPROFILE%\\${profile[1]}` : '%USERPROFILE%'
  return topLevelName(p)
}

/** 路径的最后一段（顶层名）；空串/末尾分隔符都安全 */
export function topLevelName(p: string): string {
  if (!p) return ''
  const norm = p.replace(/[\\/]+$/, '')
  if (!norm) return ''
  const parts = norm.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * 渲染层上报的打点清洗：只接受**已知形状**（stage 名 + 有限数字），
 * 任何字符串/对象/超大值一律丢掉 —— 渲染层被注入时也不能往日志里灌任意内容。
 */
export interface RendererStartupReport {
  stage: string
  marks: Record<string, number>
}
export function sanitizeRendererStartupReport(input: unknown): RendererStartupReport | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as { stage?: unknown; marks?: unknown }
  const stage =
    typeof raw.stage === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(raw.stage) ? raw.stage : ''
  if (!stage) return null
  const marks: Record<string, number> = {}
  if (raw.marks && typeof raw.marks === 'object') {
    for (const [key, value] of Object.entries(raw.marks as Record<string, unknown>)) {
      if (Object.keys(marks).length >= 40) break
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3_600_000)
        continue
      marks[key] = Math.round(value)
    }
  }
  return { stage, marks }
}

/** 一条启动日志行（单行 JSON，带 ISO 时间戳；与 app.log 同一风格，便于 grep/jq） */
export function startupLogLine(
  entry: Record<string, unknown>,
  at: string = new Date().toISOString()
): string {
  return JSON.stringify({ at, ...entry }) + '\n'
}

/** 导出文件头（不含任何文档内容；环境摘要是**白名单字段**，不是拼对象） */
export interface StartupExportEnvironment {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  locale: string
  totalmemMb: number
  cpuModel: string
  cpuCount: number
  packaged: boolean
  userData: string
  firstRun: boolean
  startedAt: string
}

export function formatStartupEnvironment(env: StartupExportEnvironment): string {
  return [
    `Lumin: ${env.appVersion}${env.packaged ? '' : ' (dev)'}`,
    `Electron: ${env.electron}`,
    `Chromium: ${env.chrome}`,
    `Node: ${env.node}`,
    `Platform: ${env.platform} ${env.arch}`,
    `Locale: ${env.locale}`,
    `Memory: ${env.totalmemMb} MB`,
    `CPU: ${env.cpuModel} (${env.cpuCount} cores)`,
    `userData: ${env.userData}`,
    `firstRun: ${env.firstRun}`,
    `startedAt: ${env.startedAt}`
  ].join('\n')
}

/** 组装「导出启动诊断」的全文：头 + 环境摘要 + 历史日志（旧→新） */
export function buildStartupExportText(
  env: StartupExportEnvironment,
  logs: { name: string; text: string }[]
): string {
  const parts: string[] = [
    '# Lumin startup diagnostics',
    '> No document content. No full personal paths (userData is redacted, workspace/docs are counts only).',
    '',
    '## Environment',
    formatStartupEnvironment(env),
    '',
    '## Startup log',
    ''
  ]
  for (const log of logs) {
    if (!log.text) continue
    parts.push(`### ${log.name}`, '```json', log.text.replace(/\s+$/, ''), '```', '')
  }
  return parts.join('\n')
}

/** 文本行数（空行不计；导出验收按它报"多少行"） */
export function countLogLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length
}

/**
 * 启动期「工作区目录树要不要现在扫」的判定（纯函数，单测见 tests/startupLazy.test.mjs）。
 *
 * 背景（模拟慢环境实测）：5000 个文件的工作区，`files.init()` 里那次 `readDir(root)` +
 * IPC 序列化 + 递归渲染要 **~800ms**（本机 486ms 扫描 + ~320ms 渲染），而它压在
 * 「窗口已出现 → 文档可见」之间，用户感知就是"窗口开了、正文半天不来"。
 *
 * 口径：**首屏路径上不扫**。工作区根立即落地（会话恢复/打开文件都要它），
 * 目录树推到空闲时段（`requestIdleCallback`）或用户真正展开侧栏时再拉。
 * 已缓存（同一窗口二次初始化）时不重复扫。
 */
export function planStartupTreeLoad(input: { hasRoot: boolean; cached: boolean }): 'skip' | 'idle' {
  if (!input.hasRoot) return 'skip'
  if (input.cached) return 'skip'
  return 'idle'
}
