import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
// 路径比较**一份实现**：纯字符串那份在 shared（有单测），主进程不再自己抄一份 norm
import { samePath } from '../../shared/paths'

/**
 * ─── 启动意图解析（纯函数，可单测）─────────────────────────────────────────────
 * 「进程命令行 → 该打开什么」这件事以前塞在 services/taskbar.ts 里，但它跟任务栏没关系：
 * 它同时服务于 ① 双击文件/文件关联 ② 任务栏跳转列表 ③ 第二实例转发 ④ macOS open-file。
 * 抽到这里做成**没有副作用、不依赖 electron** 的纯函数，任何一处都能复用同一套规则，
 * 也不会再出现「两份解析逻辑各说各话」。
 *
 * ─── 为什么以前双击 .md 打不开 ────────────────────────────────────────────────
 * 老实现只认自己那几个开关（`--lumin-open=` 等）。文件关联把文件传进来时是**裸路径**
 * （`Lumin.exe D:\a\b.md`），没有开关前缀 → 被无视 → 「注册了关联却双击没反应」。
 * 这里补上裸路径识别，文件关联才真的能用。
 */

/** 打开指定文档（与 preload/additionalArguments 用的是同一套格式：encodeURIComponent 编码） */
export const OPEN_FILE_PREFIX = '--lumin-open='
/** 把某个目录作为工作区打开 */
export const OPEN_FOLDER_PREFIX = '--lumin-open-folder='
/** 「新建窗口」：开一个不继承当前工作区的干净窗口 */
export const NEW_WINDOW_SWITCH = '--lumin-new-window'
/** 干净窗口标记（渲染层据此不继承工作区） */
export const NO_WORKSPACE_SWITCH = '--lumin-no-workspace=1'

export interface LaunchIntent {
  /** 打开这篇文档（绝对路径） */
  openFile: string | null
  /** 把这个目录作为工作区打开（绝对路径） */
  openFolder: string | null
  /** 要求开一个新窗口 */
  newWindow: boolean
  /** 干净窗口（不继承当前工作区） */
  noWorkspace: boolean
  /**
   * 解析过程中被忽略、但值得记一笔的参数。
   * 之所以作为返回值而不是在这里打日志：本模块是纯函数（可单测、可复用），日志由调用方决定。
   */
  ignored: string[]
}

export interface ParseOptions {
  /** 应用目录（开发态 electron 会把项目目录作为第一个参数传进来，必须忽略它） */
  appPath: string
  /** 相对路径的解析基准（通常是 process.cwd()） */
  cwd: string
}

/** Windows 路径比较：大小写不敏感 + 分隔符统一（与主进程其余地方的口径一致） */
/** 解析失败（抛异常）时返回 null，绝不因为一个坏参数让启动挂掉 */
function safeResolve(p: string, cwd: string): string | null {
  try {
    return resolve(cwd, p)
  } catch {
    return null
  }
}

function decodeArg(value: string): string | null {
  try {
    return decodeURIComponent(value) || null
  } catch {
    // 编码坏了就当没有：宁可不开，也不要开到一个乱码路径
    return null
  }
}

/**
 * 解析一次启动（或第二实例被拉起）时携带的意图。
 *
 * 规则（顺序即优先级）：
 *  1. 跳过 `argv[0]`（进程自己的可执行文件路径）；
 *  2. `--` 之后一律忽略 —— Chromium 的约定是「其后不是开关」，我们的启动参数从不放在它后面，
 *     而系统/其它工具可能塞些奇怪东西进来；
 *  3. 认我们自己的开关（`--lumin-open=` / `--lumin-open-folder=` / `--lumin-new-window` /
 *     `--lumin-no-workspace=1`）；
 *  4. **其余以 `-` 开头的一律忽略**：那是 Chromium/Electron 自己的开关
 *     （`--user-data-dir=`、`--remote-debugging-port=`、`--inspect`、`--no-sandbox`、
 *     `--enable-logging`、`--type=` …），绝不能当成文件路径去打开；
 *  5. **裸路径**（不以 `-` 开头）：等于可执行文件自身或应用目录 → 忽略（开发态 `electron .`
 *     会把它传进来）；真实存在 → 目录进 `openFolder`、文件进 `openFile`；不存在 → 记一笔忽略。
 *     相对路径按 `opts.cwd` 解析成绝对路径。
 */
export function parseLaunchIntent(argv: string[], opts: ParseOptions): LaunchIntent {
  const intent: LaunchIntent = {
    openFile: null,
    openFolder: null,
    newWindow: false,
    noWorkspace: false,
    ignored: []
  }
  const selfPath = argv[0] ? safeResolve(argv[0], opts.cwd) : null
  const appPath = opts.appPath ? safeResolve(opts.appPath, opts.cwd) : null

  let afterTerminator = false
  for (let i = 0; i < argv.length; i++) {
    if (i === 0) continue
    const arg = argv[i]
    if (arg === '') continue

    if (arg === '--') {
      afterTerminator = true
      // 诊断文本（写进 %TEMP%\lumin-build.log 的 `ignored` 字段）一律 ASCII：
      // 主进程的文本落点可能是控制台/日志查看器，中文在 Windows 代码页下会乱码
      intent.ignored.push('-- (remaining args ignored per Chromium convention)')
      continue
    }
    if (afterTerminator) continue

    if (arg.startsWith(OPEN_FILE_PREFIX)) {
      const p = decodeArg(arg.slice(OPEN_FILE_PREFIX.length))
      if (p) intent.openFile ??= p
      continue
    }
    if (arg.startsWith(OPEN_FOLDER_PREFIX)) {
      const p = decodeArg(arg.slice(OPEN_FOLDER_PREFIX.length))
      if (p) intent.openFolder ??= p
      continue
    }
    if (arg === NEW_WINDOW_SWITCH) {
      intent.newWindow = true
      continue
    }
    if (arg === NO_WORKSPACE_SWITCH) {
      intent.noWorkspace = true
      continue
    }
    // 其余开关前缀：Chromium/Electron 自己的参数，绝不当作路径
    if (arg.startsWith('-')) continue

    const abs = safeResolve(arg, opts.cwd)
    if (!abs) {
      intent.ignored.push(`${arg} (path could not be resolved)`)
      continue
    }
    // 可执行文件自身 / 应用目录：开发态 `electron .`、以及我们自己的快捷方式都会传进来
    if (selfPath && samePath(abs, selfPath)) continue
    if (appPath && samePath(abs, appPath)) continue

    if (!existsSync(abs)) {
      intent.ignored.push(`${arg} (path does not exist)`)
      continue
    }
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      intent.ignored.push(`${arg} (unreadable)`)
      continue
    }
    if (isDir) intent.openFolder ??= abs
    else intent.openFile ??= abs
  }

  return intent
}
