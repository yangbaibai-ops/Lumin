import { app } from 'electron'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type { JumpListCategory, JumpListItem } from 'electron'
import { db } from './database'
import { defaultSettings } from '../../shared/defaults'
import type { AppSettings, Language } from '../../shared/types'

/**
 * ─── Windows 任务栏跳转列表（右键图标的那份菜单）──────────────────────────────
 * 目标：和 Typora 一致 —— 右键任务栏图标时，除系统自带项外还能看到
 *   ① 一条以应用名命名的任务（Typora 里就叫「Typora」），点它打开**一个新的 Lumin 窗口**；
 *   ② 一栏最近打开的文档，点哪篇开哪篇。
 *
 * 三个必须踩准的点（都是「看起来能用、其实点下去会出事」的地方）：
 *
 *  1. **开发态跑的是 electron.exe**：任务里的 `program` 必须显式给 `process.execPath`，
 *     并且把**应用目录**一起塞进参数，否则 Windows 拉起的是一个不带参数的 electron.exe ——
 *     那就是 Electron 自带的示例窗口。用户报的「点一下就出现 Electron 原生窗口」正是这个。
 *     打包后 execPath 就是 Lumin.exe，不需要再传应用目录。
 *
 *  2. **最近文件用自定义分类 + 显式 program/args**，而不是 `app.addRecentDocument()`：
 *     后者把文件交给系统的「最近文档」，点击时由**文件关联**决定用谁打开；开发态
 *     electron.exe 并没有 .md 关联，点下去会跑去打开别的程序（机器上装了 Typora 就开 Typora）。
 *     自己写 program/args 则永远拉起本应用。
 *
 *  3. **AUMID 不用动**：`electronApp.setAppUserModelId()` 在开发态用的是 `process.execPath`
 *     （见 @electron-toolkit/utils），也就是「用户固定的那个 electron.exe 按钮」的 AUMID；
 *     跳转列表是按 AUMID 注册的，所以开发态这些条目正好出现在用户右键的那个按钮上。
 *     打包态则用 `com.lumin.app`，与安装器建的快捷方式一致。
 */

/** 跳转列表里「打开新窗口」的开关（主进程解析：冷启动与第二实例两条路都要认） */
export const NEW_WINDOW_SWITCH = '--lumin-new-window'
/** 跳转列表里「打开某篇文档」的参数前缀（与 additionalArguments 的 --lumin-open 同一套格式） */
export const OPEN_FILE_PREFIX = '--lumin-open='

/** 任务名就用应用名（与 Typora 的做法一致） */
const TASK_TITLE = 'Lumin'
/** 最多列几篇最近文档：跳转列表不宜过长 */
export const MAX_RECENT = 8

const CATEGORY_NAME: Record<Language, string> = {
  'zh-CN': '最近打开',
  'en-US': 'Recent',
  'ru-RU': 'Недавние'
}

const NEW_WINDOW_DESC: Record<Language, string> = {
  'zh-CN': '在新的 Lumin 窗口中打开',
  'en-US': 'Open in a new Lumin window',
  'ru-RU': 'Открыть в новом окне Lumin'
}

/** 主进程没有 i18n 实例，这里按落库的语言取词（与渲染层共用同一份 Language 联合） */
function language(): Language {
  const s = db.kvGet<AppSettings>('settings', defaultSettings)
  return s.language ?? 'zh-CN'
}

/** 最近文档取「应用里那份」列表（settings.recentFiles）：用户在界面上清空它时，跳转列表也跟着空 */

/**
 * 只用于自检：开了 LUMIN_DEBUG_PORT / LUMIN_STARTUP_LOG 时，把注册结果写进 %TEMP%\lumin-taskbar.log
 * 供验收脚本读取。
 * 为什么不是 console.log：Windows 上主进程是 GUI 子系统进程，没有控制台，stdout 重定向也拿不到
 * 主进程的 console 输出（实测只收到 Chromium 那行 DevTools listening），所以自检信息落文件最可靠。
 */
function debugLog(msg: string): void {
  if (!process.env['LUMIN_DEBUG_PORT'] && !process.env['LUMIN_STARTUP_LOG']) return
  try {
    appendFileSync(join(tmpdir(), 'lumin-taskbar.log'), `[taskbar] ${msg}\n`)
  } catch {
    /* 自检失败不影响功能 */
  }
}

/** 带空格的路径要加引号，否则 CreateProcess 会把一个路径拆成两个参数 */
function quote(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}

/**
 * 组装跳转列表条目的命令行参数。
 * 开发态第一个参数固定是「应用目录」（见文件头第 1 点），打包态直接就是开关本身。
 */
function launchArgs(extra: string[]): string {
  const parts = app.isPackaged ? extra : [app.getAppPath(), ...extra]
  return parts.map(quote).join(' ')
}

/** 本次进程启动（或第二实例被拉起）时携带的跳转列表意图 */
export interface LaunchIntent {
  /** 要求开一个新窗口 */
  newWindow: boolean
  /** 要求打开这篇文档（绝对路径） */
  openFile: string | null
}

/** 解析 `process.argv` / `second-instance` 的 argv 里的跳转列表意图 */
export function parseLaunchIntent(argv: string[]): LaunchIntent {
  let openFile: string | null = null
  const arg = argv.find((a) => a.startsWith(OPEN_FILE_PREFIX))
  if (arg) {
    try {
      openFile = decodeURIComponent(arg.slice(OPEN_FILE_PREFIX.length)) || null
    } catch {
      openFile = null
    }
  }
  return { newWindow: argv.includes(NEW_WINDOW_SWITCH), openFile }
}

export interface JumpListStatus {
  /** 注册结果：setJumpList 的返回值（'ok' 才算真的注册上） */
  status: string
  tasks: number
  recent: number
}

/**
 * 重建跳转列表。幂等，可反复调用（系统会替换上一次的自定义列表）。
 * 任何失败都不该影响启动，所以调用方与内部都做了兜底。
 */
export function refreshJumpList(): JumpListStatus {
  if (process.platform !== 'win32') return { status: 'skipped', tasks: 0, recent: 0 }
  try {
    const lang = language()
    const recents = db
      .kvGet<AppSettings>('settings', defaultSettings)
      .recentFiles.slice(0, MAX_RECENT)
      .filter((r) => !!r?.path)

    const tasks: JumpListItem[] = [
      {
        type: 'task',
        program: process.execPath,
        args: launchArgs([NEW_WINDOW_SWITCH]),
        title: TASK_TITLE,
        description: NEW_WINDOW_DESC[lang],
        iconPath: process.execPath,
        iconIndex: 0
      }
    ]

    const recentItems: JumpListItem[] = recents.map((r) => ({
      type: 'task',
      program: process.execPath,
      args: launchArgs([OPEN_FILE_PREFIX + encodeURIComponent(r.path)]),
      title: r.title || basename(r.path),
      // description 上限 260 字符，超了整个条目会被系统丢掉
      description: dirname(r.path).slice(0, 240),
      iconPath: process.execPath,
      iconIndex: 0
    }))

    const categories: JumpListCategory[] = [
      { type: 'tasks', items: tasks },
      ...(recentItems.length
        ? [{ type: 'custom' as const, name: CATEGORY_NAME[lang], items: recentItems }]
        : [])
    ]

    const status = app.setJumpList(categories)
    debugLog(
      `jumplist status=${status} tasks=${tasks.length} recent=${recentItems.length} ` +
        `args="${launchArgs([NEW_WINDOW_SWITCH])}"`
    )
    return { status, tasks: tasks.length, recent: recentItems.length }
  } catch (err) {
    debugLog('jumplist failed: ' + String(err))
    return { status: 'error', tasks: 0, recent: 0 }
  }
}

let refreshTimer: NodeJS.Timeout | null = null

/**
 * 文档切换后延迟重建：渲染层这次「打开」要先落库（documents.last_opened），
 * 立刻重建会拿到上一版的最近列表，所以等一会儿再读。
 */
export function scheduleRefresh(): void {
  if (process.platform !== 'win32') return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refreshJumpList()
  }, 1500)
}
