import { app, shell } from 'electron'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type { JumpListCategory, JumpListItem } from 'electron'
import { db } from './database'
import { defaultSettings } from '../../shared/defaults'
import type { AppSettings, Language } from '../../shared/types'
// 应用图标的 ICO：任务栏/开始菜单只认 exe/dll/ico 里的图标资源，PNG 在这里没用
import appIconIco from '../../../resources/icon.ico?asset'

/**
 * ─── Windows 任务栏跳转列表与「应用标识」（右键图标的那份菜单）─────────────────
 * 目标：和 Typora 一致 —— 右键任务栏图标时
 *   ① 第一项显示**应用名**（Typora 里就是「Typora」），点它打开一个**全新的窗口**；
 *   ② 还能看到 Tasks（「新建窗口」）与一栏最近打开的文档。
 *
 * 三个必须踩准的点（都是「看起来能用、其实点下去会出事」的地方）：
 *
 *  1. **菜单第一项的名字与点击行为，来自该 AUMID 注册的那条开始菜单快捷方式。**
 *     Windows 只认「标识 → 快捷方式」这条链：名字取快捷方式的显示名，点击执行它的 target + args。
 *     开发态跑的是 electron.exe，而 @electron-toolkit/utils 的 setAppUserModelId() 在开发态用的
 *     正是 process.execPath —— 那个标识在 Windows 眼里就是 electron.exe 本身：名字显示成
 *     「Electron」，点击执行的是**不带参数**的 electron.exe（= Electron 自带的示例窗口），
 *     「固定到任务栏」固定下来的也是这条无参数快捷方式。
 *     所以：标识改用 appId()（开发态 `com.lumin.app.dev`），并用 ensureAppShortcut() 写一条
 *     **带参数**的开始菜单快捷方式（细节见该函数注释）。
 *
 *  2. **Tasks / 最近文档里的启动命令要显式写 program + args**：program = process.execPath，
 *     开发态再把**应用目录**作为第一个参数带上，否则又是一个无参数的 electron.exe。
 *     打包后 execPath 就是 Lumin.exe，不需要应用目录。
 *
 *  3. **最近文件用自定义分类，而不是 `app.addRecentDocument()`**：后者把点击交给系统的
 *     「最近文档」+**文件关联**，开发态 electron.exe 没有 .md 关联，点下去会跑去打开别的程序
 *     （机器上装了 Typora 就开 Typora）。自己写 program/args 则永远拉起本应用。
 */

/**
 * 运行期图标副本放哪个目录。
 *  * **默认配置目录**：放 userData 的 `icons/`（跟用户数据一起、随卸载保留）；
 *  * **隔离实例**：放一个**稳定**的公共目录。它的配置目录跑完就被删，而它写的那条
 *    `[test]` 快捷方式还指着这个图标文件 —— 放 userData 里必然变成「找不到图标」
 *    （实测踩过：跑完验收套件后，开始菜单/任务栏那条只剩缺省图标）。
 */
function iconDir(): string {
  return isDefaultProfile() ? join(app.getPath('userData'), 'icons') : join(tmpdir(), 'lumin-icons')
}

/**
 * ─── 运行期真正使用的图标路径（内容寻址）────────────────────────────────────
 * 为什么不能直接用仓库里的 resources/icon.ico：**Windows 的图标缓存与跳转列表缓存都按「路径」
 * 记忆**，同一个 .lnk / 同一个 .ico 路径被覆盖时缓存不失效 —— 实测出现过「图标文件已经换成新设计，
 * 任务栏右键那条却还显示上一版的图」，重建快捷方式、ie4uinit 都不管用。
 * 做法：把 icon.ico 复制到用户目录下一个**名字里带内容哈希**的文件（内容变 → 路径变 → 缓存必然失效），
 * 并让**所有运行时位置**（窗口图标 / 开始菜单快捷方式 / 跳转列表条目）都用这一个文件，保持单一来源。
 * 旧设计留下的副本顺手清掉，不会越积越多。
 */
export function runtimeIconPath(): string {
  const src = appIconIco
  try {
    const hash = createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 8)
    const dir = iconDir()
    const dst = join(dir, `lumin-${hash}.ico`)
    if (!existsSync(dst)) {
      mkdirSync(dir, { recursive: true })
      copyFileSync(src, dst)
      // 清理旧设计的副本（只留当前这一份）
      for (const f of readdirSync(dir)) {
        if (/^lumin-[0-9a-f]{8}\.ico$/.test(f) && f !== `lumin-${hash}.ico`) {
          try {
            unlinkSync(join(dir, f))
          } catch {
            /* 正被别的进程占用也无所谓 */
          }
        }
      }
    }
    return dst
  } catch {
    // 复制失败就退回仓库里的原件：功能不受影响，最多是缓存问题重现
    return src
  }
}

// 开关常量的单一来源在 services/launchIntent.ts（解析也在那里，这里只负责**拼**跳转列表的命令行）
export { NEW_WINDOW_SWITCH, OPEN_FILE_PREFIX } from './launchIntent'
import { NEW_WINDOW_SWITCH, OPEN_FILE_PREFIX } from './launchIntent'

/** 任务名（Tasks 分类里的那条）：与「应用名」那条区分开，见文件头的说明 */
const TASK_TITLE: Record<Language, string> = {
  'zh-CN': '新建窗口',
  'en-US': 'New Window',
  'ru-RU': 'Новое окно'
}
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

/** 只用于自检：开了 LUMIN_DEBUG_PORT / LUMIN_STARTUP_LOG 时，把注册结果写进 %TEMP%\lumin-taskbar.log
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

/**
 * 应用的 Windows 标识（AppUserModelID）。
 * 打包态用安装器同一套；开发态加 `.dev` 后缀 —— 上面第 3 点解释了为什么不能沿用
 * @electron-toolkit/utils 的 `process.execPath`：那个标识在 Windows 眼里就是 electron.exe
 * 本身（名字显示成「Electron」），点它的启动命令是**不带参数**的 electron.exe。
 *
 * ─── 为什么隔离实例还要再分一层（`.test`）───────────────────────────────────
 * 任务栏按钮的**图标与名字**由「AUMID → 开始菜单快捷方式」这条链决定，而这条链是按 AUMID
 * 去开始菜单里找的。隔离实例（`--user-data-dir` / `dev:isolated`）也会写自己那条快捷方式
 * （`Lumin (dev) [test].lnk`）；只要 AUMID 跟用户的一样，用户的应用就可能被解析到**测试实例
 * 那条**快捷方式上 —— 测试实例的配置目录跑完就被删，它的图标文件跟着没了，用户的任务栏
 * 图标于是变成缺省（实测踩过：跑完验收套件后，任务栏图标变白）。给隔离实例一个独立标识，
 * 两边的「标识 → 快捷方式」各归各的，互不干扰。
 */
export function appId(): string {
  if (app.isPackaged) return 'com.lumin.app'
  return isDefaultProfile() ? 'com.lumin.app.dev' : 'com.lumin.app.dev.test'
}

/**
 * 当前是否跑在「默认配置目录」上。
 * 验收/多开场景会用 --user-data-dir 起隔离实例，而那些实例**绝不能碰用户自己开始菜单里那条快捷方式**
 * （实测踩过：隔离实例把用户的 Lumin (dev) 快捷方式改成了指向临时目录的图标）。
 */
function isDefaultProfile(): boolean {
  const def = join(app.getPath('appData'), app.getName())
  return app.getPath('userData').toLowerCase() === def.toLowerCase()
}

/** 开始时菜单里那条「应用」快捷方式的路径（也是任务栏用来解析标识与启动命令的那条） */
export function shortcutPath(): string {
  const dir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const base = app.isPackaged ? 'Lumin.lnk' : 'Lumin (dev).lnk'
  // 非默认配置目录（验收隔离实例）用单独的名字，绝不覆盖用户那条
  return join(dir, isDefaultProfile() ? base : base.replace(/\.lnk$/, ' [test].lnk'))
}

/**
 * 安装器创建的那条开始菜单快捷方式的路径。
 *
 * 与 shortcutPath() 的区别（很容易搞混，所以分成两个函数）：
 *  * shortcutPath() 是**开发态由我们自己创建/刷新**的那条，名字按 profile 区分（隔离实例不会覆盖用户的）；
 *  * installedShortcutPath() 是**安装器写的**那条，名字由 electron-builder.yml 的 nsis.shortcutName 决定
 *    （= Lumin），与当前进程用什么 profile 无关 —— 因为它是安装到系统里的那一条。
 * 打包态的 AUMID 补写必须用后者：用前者的话，带 --user-data-dir 的实例会去找 "Lumin [test].lnk"，
 * 永远补不到安装器那条（实测踩过这个前提）。
 */
export function installedShortcutPath(): string {
  return join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    app.isPackaged ? 'Lumin.lnk' : 'Lumin (dev).lnk'
  )
}

export interface ShortcutStatus {
  ok: boolean
  path: string
  aumid: string
  target: string
  args: string
}

/**
 * ─── 注册「Windows 认识本应用」所需的那条开始菜单快捷方式 ──────────────────────
 *
 * 这是任务栏右键菜单第一项的真正来源：**名字**取自该标识注册的快捷方式显示名，**点击后执行的
 * 命令**也取自这条快捷方式（target + args）。没有它时，Windows 只能退回进程路径 —— 于是名字叫
 * 「Electron」，点它就是「无参数的 electron.exe = Electron 自带的示例窗口」，而「固定到任务栏」
 * 固定下来的也是这条无参数快捷方式。有了它：名字是 Lumin，点它是「electron.exe + 应用目录 +
 * --lumin-new-window」→ 一个全新的 Lumin 窗口，固定到任务栏也会连参数一起固定。
 *
 * 用 'create' 幂等写入（它会覆盖已存在的），每次启动都刷新一遍，改了图标/参数也跟着更新。
 * 注意别用 'replace'：那个是「只替换已存在的」，文件还没建出来时直接失败。
 *
 * **打包态直接跳过**（见函数内注释）：安装器负责创建快捷方式，运行时不该插一脚。
 */
/**
 * ─── 打包态：确保安装器那条快捷方式带 AppUserModelID（幂等）────────────────────
 *
 * 背景（含一条**被修正过的**结论，别照抄旧说法）：
 *  * NSIS 那套快捷方式脚本本身写不了 .lnk 的 AppUserModelID —— 它属于 .lnk 的扩展属性存储，
 *    不是注册表值；而这条属性决定任务栏把窗口与哪条快捷方式认成同一个应用；
 *  * 但 electron-builder 会按 appId 写这条属性。**实测（第二轮）：安装器创建的 Lumin.lnk 里
 *    本来就有 com.lumin.app**，shell.readShortcutLink 直接读得到。
 *    第一轮报告 P4 说的「lnk 里没有 AUMID」是**测量方法错了**：当时拿原始字节去搜 UTF-16
 *    字符串，搜不到不等于属性不存在。结论更正见 docs/packaging-install-test.md。
 *
 * 所以这个函数是**兜底**，不是补救：正常情况走下面「已存在」那条分支直接返回；
 * 只有当快捷方式被换成了不带 AUMID 的版本（换安装器、被别的工具重写过）时才真的补写。
 * 做法：只读取并补这一个属性，其余字段（target/args/cwd/description/icon/iconIndex）原样保留 ——
 * 绝不新建文件、绝不改启动参数，仍然遵守「打包态不创建快捷方式，快捷方式归安装器」的原则。
 * 失败只记日志：拿不到这条属性最多是任务栏身份弱一些，不该影响启动。
 */
export function backfillInstalledShortcutAumid(): boolean {
  if (process.platform !== 'win32') return false
  const path = installedShortcutPath()
  try {
    if (!existsSync(path)) {
      debugLog(`shortcut aumid backfill skipped (not found) path="${path}"`)
      return false
    }
    const cur = shell.readShortcutLink(path)
    if (cur.appUserModelId) {
      debugLog(`shortcut aumid already present path="${path}" aumid=${cur.appUserModelId}`)
      return true
    }
    // 显式逐字段写回，而不是展开 cur：readShortcutLink 返回的对象里有些字段（如空字符串的
    // toastActivatorClsid）不适合原样回传，逐字段更可控，也更容易看出「我们只动了 AUMID」。
    const ok = shell.writeShortcutLink(path, 'update', {
      target: cur.target,
      args: cur.args,
      cwd: cur.cwd,
      description: cur.description,
      icon: cur.icon,
      iconIndex: cur.iconIndex,
      appUserModelId: appId()
    })
    debugLog(`shortcut aumid backfilled ok=${ok} path="${path}" aumid=${appId()}`)
    return ok
  } catch (err) {
    debugLog(`shortcut aumid backfill failed: ${String(err)}`)
    return false
  }
}

/**
 * ─── 默认配置目录启动时，清掉「名字里带 [test] 的快捷方式」─────────────────────
 *
 * 任务栏按钮的**图标与名字**由「AUMID → 开始菜单快捷方式」这条链决定。只要开始菜单里还留着
 * **另一条**同 AUMID 的快捷方式，用户的应用就可能被解析到那条上 —— 隔离实例写的那条
 * `Lumin (dev) [test].lnk` 正是重灾区：它的配置目录跑完就被删，图标文件跟着没了，
 * 用户的任务栏图标于是变成缺省（实测踩过：跑完验收套件后图标变白）。
 *
 * `appId()` 已给隔离实例发了独立标识，从源头隔开；这条自愈用来清掉**历史版本**留下的那份
 * 残留（它带的是用户的 AUMID）。`[test]` 这个名字默认配置目录从不用，删它绝不会碰到用户那条。
 */
function removeStaleTestShortcut(): void {
  if (process.platform !== 'win32' || !isDefaultProfile()) return
  const base = app.isPackaged ? 'Lumin' : 'Lumin (dev)'
  const stale = join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${base} [test].lnk`
  )
  try {
    if (!existsSync(stale)) return
    unlinkSync(stale)
    debugLog(`stale test shortcut removed path="${stale}"`)
  } catch (err) {
    debugLog(`stale test shortcut removal failed: ${String(err)}`)
  }
}

/**
 * 启动时管理快捷方式的**唯一入口**，按运行形态分流：
 *  * 打包态：快捷方式归安装器，我们只做 AUMID 幂等补写（见上）；
 *  * 开发态：由我们自己创建/刷新那条带参数的快捷方式（因为开发态没有安装器，
 *    而 Windows 的任务栏身份又依赖「AUMID → 快捷方式」这条链）。
 * 无论哪种形态，都先做一次「清掉同 AUMID 的测试残留」自愈。
 */
export function ensureShortcut(): void {
  removeStaleTestShortcut()
  if (app.isPackaged) {
    backfillInstalledShortcutAumid()
    return
  }
  ensureAppShortcut()
}

export function ensureAppShortcut(): ShortcutStatus {
  const path = shortcutPath()
  const args = launchArgs([NEW_WINDOW_SWITCH])
  const target = process.execPath
  if (process.platform !== 'win32') {
    return { ok: false, path, aumid: appId(), target, args }
  }
  // 打包态**什么都不做**：开始菜单/桌面快捷方式由 NSIS 安装器创建，而且它写的那条才是「正品」
  // （AUMID、图标、启动参数、卸载信息都由安装器登记）。运行时再写一遍等于用开发态那套
  // （electron.exe 或 Lumin.exe + 我们的参数）去覆盖安装器那条，纯属添乱。
  if (app.isPackaged) {
    debugLog(`shortcut creation skipped (packaged; installer owns it) path="${path}"`)
    return { ok: true, path, aumid: appId(), target, args }
  }
  try {
    // 先删再写：**换掉文件标识**，逼 Windows 重新提取快捷方式图标。
    // 直接覆盖同一个 .lnk 时，shell 的图标缓存会继续显示改写前的旧图标（实测踩过：
    // 图标文件早换成新设计，右键菜单里那条却还是上一版的图）。删掉重建等于换了个文件，
    // 缓存必然失效；万一中途崩了也只是少一条快捷方式，下次启动会补回来。
    try {
      unlinkSync(path)
    } catch {
      /* 本来就不存在 */
    }
    const ok = shell.writeShortcutLink(path, 'create', {
      target,
      args,
      cwd: app.getAppPath(),
      description: 'Lumin',
      icon: runtimeIconPath(),
      iconIndex: 0,
      appUserModelId: appId()
    })
    debugLog(
      `shortcut ok=${ok} path="${path}" aumid=${appId()} target="${target}" args="${args}" icon="${runtimeIconPath()}"`
    )
    // 再读回来一次：证明**磁盘上那条**快捷方式（Windows 真正会读的）确实带上了标识、参数与图标
    try {
      const back = shell.readShortcutLink(path)
      debugLog(
        `shortcut-readback target="${back.target}" args="${back.args}" aumid=${back.appUserModelId ?? ''} icon="${back.icon ?? ''}"`
      )
    } catch (err) {
      debugLog(`shortcut-readback failed: ${String(err)}`)
    }
    return { ok, path, aumid: appId(), target, args }
  } catch (err) {
    debugLog(`shortcut failed: ${String(err)}`)
    return { ok: false, path, aumid: appId(), target, args }
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

export interface JumpListStatus {
  /** 注册结果：setJumpList 的返回值（'ok' 才算真的注册上） */
  status: string
  tasks: number
  recent: number
}

/**
 * 跳转列表条目用哪个图标文件。
 * 打包态用 **exe 自身**：图标已经嵌进 `Lumin.exe`，这正是「确实需要另一种图标类型」的正当场景
 * —— exe 资源不需要额外文件，也不会被 Windows 的图标缓存按路径记住；
 * 开发态跑的是 electron.exe（自带图标是 Electron 的 logo），必须用我们那份内容寻址的 ico。
 */
function jumpListIconPath(): string {
  return app.isPackaged ? process.execPath : runtimeIconPath()
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
        title: TASK_TITLE[lang],
        description: NEW_WINDOW_DESC[lang],
        iconPath: jumpListIconPath(),
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
      iconPath: jumpListIconPath(),
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
        `title="${TASK_TITLE[lang]}" args="${launchArgs([NEW_WINDOW_SWITCH])}"`
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
