// ─── 启动诊断日志（主进程侧）：默认开启、有界、脱敏 ─────────────────────────────
//
// 为什么要有它：用户报「装完启动 5–6 秒」，而我们只有开发机上的 545ms —— 中间那 5 秒
// 全是**机器相关**的（Defender、磁盘、userData 里的大库/大工作区、首次加载…）。
// 没有用户机的分段数据，任何"优化"都是猜。所以把启动打成一条可发回来的日志：
// `<userData>/logs/startup.log`（轮转/上限/脱敏规则见 shared/startupLog.ts）。
//
// 设计取舍：
//   * **默认开**：只在 `LUMIN_STARTUP_LOG=0` 时关（给已经知道自己在测什么的人一个开关）。
//     一次启动 15–25 行、同步 append 几十微秒 —— 比"让用户复现一次却什么都拿不到"便宜得多。
//   * **失败绝不影响启动**：与 appLog 一样，整段包在 try/catch 里（日志是辅助能力）。
//   * **路径脱敏**：这里所有入口都只接受数量/顶层名/已脱敏标签；渲染层上报会先过
//     `sanitizeRendererStartupReport`（只认数字），不给"往日志灌任意文本"留口子。
import { app } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import os from 'os'
import { dirname, join } from 'path'
import {
  MAX_STARTUP_LOG_FILES,
  STARTUP_LOG_FILE,
  buildStartupExportText,
  countLogLines,
  redactStartupPath,
  rotatedStartupName,
  sanitizeRendererStartupReport,
  shouldRotateStartup,
  startupLogLine,
  startupRotationPlan,
  type RendererStartupReport,
  type StartupExportEnvironment
} from '../../shared/startupLog'

/** 进程内起点：模块求值即开始计时（main/index.ts 的第一个 import 就会拉起它） */
const T0 = performance.now()
/** 启动时刻（ISO）：导出文件头里的 startedAt */
const STARTED_AT = new Date().toISOString()

let initialized = false
let enabled = true
let logFile = ''
let firstRun = false
let env: StartupExportEnvironment | null = null
let environmentLogged = false
let appVersion = ''

function roundMs(value: number): number {
  return Math.round(value)
}

/** userData 脱敏标签只在初始化时算一次（`app.getPath` 在 ready 前后都可用） */
function userDataLabel(): string {
  try {
    return redactStartupPath(app.getPath('userData'))
  } catch {
    return '<unknown>'
  }
}

function cpuModel(): string {
  try {
    return os.cpus()[0]?.model?.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function collectEnvironment(): StartupExportEnvironment {
  return {
    appVersion,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    locale: (() => {
      try {
        return app.getLocale()
      } catch {
        return ''
      }
    })(),
    totalmemMb: Math.round(os.totalmem() / (1024 * 1024)),
    cpuModel: cpuModel(),
    cpuCount: os.cpus().length,
    packaged: (() => {
      try {
        return app.isPackaged
      } catch {
        return false
      }
    })(),
    userData: userDataLabel(),
    firstRun,
    startedAt: STARTED_AT
  }
}

/**
 * 轮转（写前判）：`startup.log` → `.1` → … → `.4`，最老的删掉。最多 5 份
 * （保留最近 5 次启动，便于对比「第一次慢、第二次快」）。
 * 任何一步失败都继续（宁可多写一点，也不要因为轮转失败把诊断能力整个关掉）。
 */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(logFile)) return
    if (!shouldRotateStartup(statSync(logFile).size)) return
    const dir = dirname(logFile)
    const plan = startupRotationPlan(MAX_STARTUP_LOG_FILES)
    if (plan.remove) {
      try {
        unlinkSync(join(dir, plan.remove))
      } catch {
        /* 最老那份不存在也无所谓 */
      }
    }
    for (const step of plan.renames) {
      const from = join(dir, step.from)
      const to = join(dir, step.to)
      try {
        if (existsSync(from)) renameSync(from, to)
      } catch {
        /* 单步失败就跳过，下一条更老的仍可轮转 */
      }
    }
  } catch {
    /* 轮转失败不影响继续追加 */
  }
}

function append(entry: Record<string, unknown>): void {
  if (!enabled || !initialized || !logFile) return
  try {
    rotateIfNeeded()
    appendFileSync(logFile, startupLogLine(entry))
  } catch {
    /* 日志写不进去不该影响启动/编辑/保存 */
  }
}

/**
 * 初始化（在 `applyPortableDataDir()` 之后、任何 userData 读取之前调用）。
 * 首次运行判定必须**在开库之前**取值：库一建出来就再也分不清"这次是第一次"了。
 */
export function initStartupLog(): void {
  if (initialized) return
  initialized = true
  try {
    enabled = process.env['LUMIN_STARTUP_LOG'] !== '0'
  } catch {
    enabled = true
  }
  if (!enabled) return
  try {
    const userData = app.getPath('userData')
    const dir = join(userData, 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, STARTUP_LOG_FILE)
    firstRun = !existsSync(join(userData, 'lumin.db'))
    appVersion = app.getVersion()
    env = collectEnvironment()
    append({
      kind: 'stage',
      stage: 'process-start',
      ms: roundMs(performance.now() - T0),
      uptimeMs: roundMs(process.uptime() * 1000),
      version: appVersion,
      packaged: env.packaged,
      firstRun,
      userData: env.userData
    })
    // 环境摘要放到 app-ready 再落（`app.getLocale()` 在 ready 之前返回空串）
  } catch {
    /* 启动日志是辅助能力：初始化失败就静默关掉 */
  }
}

/** 记一段（`data` 只许放数量/布尔/已脱敏标签/耗时，禁止文档路径或正文） */
export function startupMark(stage: string, data: Record<string, unknown> = {}): void {
  if (!enabled || !initialized) return
  if (stage === 'app-ready' && env && !environmentLogged) {
    environmentLogged = true
    try {
      env.locale = app.getLocale()
    } catch {
      /* 拿不到就留空 */
    }
    append({ kind: 'environment', ...env })
  }
  append({
    kind: 'stage',
    stage,
    ms: roundMs(performance.now() - T0),
    uptimeMs: roundMs(process.uptime() * 1000),
    ...data
  })
}

/** 渲染层上报首屏可交互（只接受清洗后的 stage + 数字 marks） */
export function recordRendererStartup(input: unknown): void {
  const report: RendererStartupReport | null = sanitizeRendererStartupReport(input)
  if (!report) return
  append({
    kind: 'stage',
    stage: `renderer-${report.stage}`,
    ms: roundMs(performance.now() - T0),
    uptimeMs: roundMs(process.uptime() * 1000),
    rendererMarks: report.marks
  })
}

/** 当前 + 历史日志（旧→新；用于导出） */
export function readStartupLogs(): { name: string; text: string }[] {
  const logs: { name: string; text: string }[] = []
  try {
    const dir = join(app.getPath('userData'), 'logs')
    const names: string[] = []
    for (let i = MAX_STARTUP_LOG_FILES - 1; i >= 1; i--) names.push(rotatedStartupName(i))
    names.push(STARTUP_LOG_FILE)
    for (const name of names) {
      try {
        const text = readFileSync(join(dir, name), 'utf-8')
        if (text) logs.push({ name, text })
      } catch {
        /* 该代还没生成 */
      }
    }
  } catch {
    /* 读不到就返回空 */
  }
  return logs
}

/**
 * 写「导出启动诊断」文件。`target` 由调用方给（对话框或测试钩子）。
 * 返回行数 —— 验收里要报"产物路径 + 行数"。
 */
export function writeStartupExport(
  target: string
): { path: string; lines: number; bytes: number } | null {
  try {
    const environment = env ?? collectEnvironment()
    const logs = readStartupLogs()
    const text = buildStartupExportText(environment, logs)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf-8')
    return { path: target, lines: countLogLines(text), bytes: Buffer.byteLength(text, 'utf-8') }
  } catch {
    return null
  }
}

/** 日志文件绝对路径（诊断信息里展示；内部使用，不写进启动日志自身） */
export function startupLogPath(): string {
  return logFile
}
