// ─── 主进程：IPC 注册 ─────────────────────────────────────────────────────
import {
  app,
  ipcMain,
  dialog,
  BrowserWindow,
  webUtils,
  shell,
  nativeTheme,
  type IpcMainInvokeEvent
} from 'electron'
import path from 'path'
import os from 'os'
import { watch, existsSync, readFileSync, type FSWatcher } from 'fs'
import { mkdir, stat } from 'fs/promises'
import * as fileOps from './fileOps'
import * as exportSvc from './export'
import * as drafts from './drafts'
import * as links from './services/links'
import * as session from './services/session'
import * as openDocs from './services/openDocs'
import * as pathGrants from './services/pathGrants'
import * as taskbar from './services/taskbar'
import * as workspaceIndex from './services/workspaceIndex'
import * as dbBackup from './services/dbBackup'
import * as workspaceBackup from './services/workspaceBackup'
import { onSettingsChanged } from './services/updater'
import { installMenu } from './menu'
import { mainT } from './i18n'
import { scopeOfSender } from './services/windowScope'
import { getRememberedEncoding, rememberEncoding } from './services/encoding'
import type { ConcreteEncoding, EncodingId } from '../shared/encodings'
import type { Eol } from '../shared/eol'
import { untitledDraftKey } from '../shared/drafts'
import { db } from './services/database'
import { defaultSettings } from '../shared/defaults'
import { buildDiagnosticsText, safeLaunchArgs } from '../shared/diagnostics'
import {
  CLOSE_FALLBACK_MS,
  noteCloseProgress,
  shouldForceClose,
  type CloseGuardState
} from '../shared/closeGuard'
import { beginShutdown } from './services/shutdown'
import type {
  AppSettings,
  EpubMeta,
  ExportPayload,
  LinkActivateRecord,
  NotificationInput,
  NotificationListOptions,
  NotificationPatch,
  SessionSlot
} from '../shared/types'

const closeConfirmed = new WeakSet<BrowserWindow>()
/** 每个窗口的关窗兜底计时器（收到心跳就重置） */
const closeTimers = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>()
/** 每个窗口的关窗时序（判据见 shared/closeGuard.ts） */
const closeGuardState = new WeakMap<BrowserWindow, CloseGuardState>()

// ── 工作区文件监听：外部软件增删/改名文件时，实时推送渲染进程刷新目录树 ──
let workspaceWatcher: FSWatcher | null = null
let workspaceWatchTimer: ReturnType<typeof setTimeout> | null = null

function stopWorkspaceWatch(): void {
  workspaceWatcher?.close()
  workspaceWatcher = null
  if (workspaceWatchTimer) {
    clearTimeout(workspaceWatchTimer)
    workspaceWatchTimer = null
  }
}

function startWorkspaceWatch(root: string): void {
  stopWorkspaceWatch()
  try {
    workspaceWatcher = watch(root, { recursive: true }, (eventType) => {
      // 只响应结构变化（新增/删除/改名）；忽略内容写入（自动保存会触发 'change'，
      // 否则每次保存都会引起目录树闪烁）
      if (eventType !== 'rename') return
      if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer)
      // fs.watch 一次改动常触发多次事件，做 300ms 防抖合并
      workspaceWatchTimer = setTimeout(() => {
        workspaceWatchTimer = null
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('workspace:changed')
        }
      }, 300)
    })
  } catch {
    // 部分平台不支持递归监听：忽略错误，用户仍可手动刷新
    workspaceWatcher = null
  }
}

/** 浅层对象深度合并（嵌套对象递归；数组整体替换） */
function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
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

/**
 * 主进程持有、渲染层问不到的两件事：窗口 ↔ 会话槽位归属。
 * 由 index.ts 注入（那里才是窗口生命周期的所有者），避免 ipc.ts 反向 import index.ts 成环。
 */
export interface SlotRegistry {
  /** 某个窗口当前占用的会话槽位（null = 该窗口不参与会话） */
  slotOf: (windowId: number) => number | null
  /** 当前所有活动窗口占用的槽位 */
  liveSlots: () => number[]
  /**
   * 本次运行**已经分配出去**的槽位（含启动时按恢复计划预留、窗口还没建出来的那些）。
   * 草稿归属要它：那些窗口只是错峰创建，它们的草稿不该被启动窗口抢走。
   */
  plannedSlots: () => number[]
  /** 某个窗口实例的 uid（写草稿时落在草稿上，用来区分「谁写的」） */
  uidOf: (windowId: number) => string | null
  /** 当前所有活动窗口实例的 uid（写草稿的窗口还活着 → 那份草稿不叫「无主」） */
  liveUids: () => string[]
  /** 该窗口能不能认领「无主草稿」：只有本次运行的启动窗口可以 */
  mayClaimUntitledDraft: (windowId: number) => boolean
  /** 该窗口的槽位是不是本次启动恢复出来的（草稿归属要用，见 shared/drafts 的 mySlotRestored） */
  slotRestored: (slot: number | null) => boolean
}

/**
 * 写盘前留一份历史快照（本地历史，Wave 2）。
 *
 * 内容来自**磁盘上现有的字节**（即将被覆盖的那一版），而不是渲染层的状态：
 *   * 语义准确 —— 用户想回滚的就是「上次保存时磁盘上的样子」；
 *   * 与调用方解耦 —— 另存为、回滚写回、以后的批量操作都自动有历史。
 * 文件不存在（新建）或读不出来时静默跳过：历史是补充能力，不能因为它让保存失败。
 */
async function recordHistoryBeforeOverwrite(
  filePath: string,
  encoding: ConcreteEncoding,
  eol?: Eol
): Promise<void> {
  try {
    if (!existsSync(filePath)) return
    const { content } = await fileOps.readFileInfo(filePath)
    db.pushHistory({ path: filePath, content, encoding, eol })
  } catch {
    /* 读不到旧内容就算了（权限/被占用），保存本身继续 */
  }
}

export function registerIpc(slots: SlotRegistry): void {
  // ── 应用 ──
  ipcMain.handle('app:getVersion', () => exportSvc.appVersion())
  ipcMain.handle('app:getPlatform', () => process.platform)
  /**
   * 「关于」页需要的事实：真实依赖清单 + 第三方许可声明。
   *
   * 为什么要走主进程：这两样都是**构建产物里的文件**（`package.json` 的 `dependencies`
   * 与根目录的 `THIRD-PARTY-NOTICES.md`），渲染层读不到（也不该读）任意路径 ——
   * 与路径授权闸的口径一致。之前关于页把技术栈**硬编码在组件里**，于是列着 `Marked.js`
   * 与 `highlight.js` 这两个本仓库根本不存在的依赖，而真正的重头
   * （Tiptap / KaTeX / Mermaid / CodeMirror）一个没提。现在改成从产物里读事实，页面不可能再说假话。
   */
  ipcMain.handle('app:getAbout', () => {
    const readJson = (p: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
      } catch {
        return null
      }
    }
    const appPath = app.getAppPath()
    const pkg = readJson(path.join(appPath, 'package.json'))
    const deps = Object.entries((pkg?.dependencies as Record<string, string> | undefined) ?? {})
      .map(([name, range]) => ({ name, version: String(range).replace(/^[\^~]/, '') }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // 许可声明：打包后位于 asar 根（与 package.json 同级）；读不到给 null，由页面隐藏该区块
    let notices: string | null = null
    try {
      notices = readFileSync(path.join(appPath, 'THIRD-PARTY-NOTICES.md'), 'utf-8')
    } catch {
      notices = null
    }
    return { version: exportSvc.appVersion(), platform: process.platform, deps, notices }
  })
  /**
   * 诊断信息（审计 §9 P1）：把"用户说卡/闪退"变成可修问题的前置条件。
   *
   * 只收集**环境事实**：版本、数据位置、日志路径、启动参数、设置快照、最近的错误标题。
   * 组装与"该去掉什么"在 `shared/diagnostics.ts`（纯函数、有单测）；这里只负责取数：
   *   * 设置快照里的 recentFiles/recentFolders 会被那边剔除（那是"看过什么"，不是环境）；
   *   * 错误通知只取 level/title/时间，**不带 body**（body 里可能是文档片段）。
   */
  ipcMain.handle('app:getDiagnostics', (event) => {
    const settings = db.kvGet<AppSettings>('settings', defaultSettings)
    // 通知按「窗口作用域」隔离（见 shared/types 的 AppNotification 说明），
    // 所以取的是**这个窗口**最近的错误 —— 正是用户看到的那些
    const errors = db
      .listNotifications(scopeOfSender(event.sender), { includeClosed: true, limit: 50 })
      .filter((n) => n.level === 'error')
      .slice(-10)
      .map((n) => ({ level: n.level, title: n.title, createdAt: n.createdAt }))
    return buildDiagnosticsText(
      {
        appVersion: exportSvc.appVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
        v8: process.versions.v8 ?? '',
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        dbPath: path.join(app.getPath('userData'), 'lumin.db'),
        logs: [
          { label: 'build', path: path.join(os.tmpdir(), 'lumin-build.log') },
          { label: 'startup', path: path.join(os.tmpdir(), 'lumin-startup.log') }
        ],
        launchArgs: safeLaunchArgs(process.argv),
        settings,
        recentErrors: errors
      },
      mainT
    )
  })
  /**
   * 打开日志目录：**不接受渲染层传路径**（否则就是一个"打开任意目录"的洞），
   * 固定打开我们自己的日志目录（%TEMP%）。
   */
  ipcMain.handle('app:openLogDir', () => shell.openPath(os.tmpdir()))
  ipcMain.handle('app:confirmClose', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      closeConfirmed.add(win)
      // 立即重新触发 close：此时 closeConfirmed 已标记，关闭守卫直接放行，
      // 窗口无需再等 2.5s 兜底定时器（否则每次关窗都固定延迟 2.5 秒）
      win.close()
    }
  })
  /**
   * 关窗流程里的心跳：渲染层还在落盘 → 兜底计时器重置（审计 §2 P1「2.5s 强杀」）。
   * 只在**已经开始关窗**（closeGuardState 里有记录）且还没放行时才有意义；
   * 其它时候是空操作，不需要鉴权（它只是"我还活着"这一个 bit，不携带任何数据）。
   */
  ipcMain.on('app:closeProgress', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || closeConfirmed.has(win)) return
    const state = closeGuardState.get(win)
    if (!state) return
    noteCloseProgress(state, Date.now())
    armCloseFallback(win)
  })
  ipcMain.on('app:minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  ipcMain.on('app:toggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('app:close', () => BrowserWindow.getFocusedWindow()?.close())
  // 原生菜单栏显隐（关闭时彻底隐藏，禁用 Alt 临时唤起）
  ipcMain.on('app:setMenuBar', (event, visible: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.setMenuBarVisibility(!!visible)
    win.setAutoHideMenuBar(false)
  })

  // ── 文件 ──
  /**
   * 读文件。
   *
   * 编码优先级（Wave 2 尾巴「多窗口一致性」）：
   *   1. **调用方显式指定的编码**（「选择编码重新打开」、显式 readAs）—— 用户刚点的，必须听他的；
   *   2. **该文件已记录的编码**（`documents.encoding`，兼容老的 kv 兜底表）—— 但只对
   *      「软默认」生效（`opts.softDefault`，即打开文件时用的设置默认值）。它是"这个文件是什么编码"
   *      的权威答案，比全局默认更具体：用户上次手选的 GBK、或自动判定出的非 UTF-8 都记在这儿，
   *      所以第二个窗口打开同一文件时解出的还是同一份内容；
   *   3. 都没有 → 走 `services/encoding` 的判定链（'auto'）。
   * 判定结果若是非 UTF-8（或用户显式指定过），把它记回去，下次自动打开直接用。
   */
  ipcMain.handle(
    'file:read',
    async (_, p: string, encoding: EncodingId = 'auto', opts: { softDefault?: boolean } = {}) => {
      // 授权校验（见 services/pathGrants 的口径：工作区 / 用户选过 / 会话说 / 打开过 / 拖入）
      const fp = pathGrants.assertAuthorized(p, 'read')
      const remembered = getRememberedEncoding(fp)
      // 软默认（打开文件时的设置默认值）让位给该文件的记录；显式指定则压过记录
      const requested: EncodingId = opts?.softDefault && remembered ? remembered : encoding
      const {
        content,
        mtimeMs,
        encoding: used,
        hadBom,
        eol
      } = await fileOps.readFileInfo(fp, requested, remembered)
      // 记回去的条件：用户显式指定过、或自动判定出非 UTF-8（纯 UTF-8 文件不占条目）
      if (encoding !== 'auto' || (used !== 'utf-8' && used !== 'utf-8-bom')) {
        rememberEncoding(fp, used)
      }
      const name = path.basename(fp)
      // 打开即建立/刷新数据库索引（元数据 + 全文 + 编码/行尾/BOM）
      db.upsertDocument({ path: fp, title: name, content, encoding: used, eol, hadBom })
      db.touchOpened(fp, name)
      return { path: fp, name, content, mtimeMs, encoding: used, hadBom, eol }
    }
  )
  ipcMain.handle(
    'file:write',
    async (
      _,
      p: string,
      content: string,
      encoding: ConcreteEncoding = 'utf-8',
      hadBom = false,
      eol?: Eol
    ) => {
      const fp = pathGrants.assertAuthorized(p, 'write')
      // 本地历史（Wave 2 数据安全）：写盘前把**即将被覆盖的那一版**留一份快照。
      // 放在主进程而不是渲染层：所有写盘路径（保存/另存为/以后的回滚写回）都经过这里，
      // 不会因为某个调用点忘了调用而漏掉历史。
      await recordHistoryBeforeOverwrite(fp, encoding, eol)
      const mtimeMs = await fileOps.writeFile(fp, content, encoding, hadBom, eol)
      // 保存时同步元数据 + 全文索引
      db.upsertDocument({ path: fp, title: path.basename(fp), content, encoding, eol, hadBom })
      // 回真实 mtime：渲染层用它判断「磁盘是否被外部改过」，用 Date.now() 冒充会永远失效
      return { mtimeMs }
    }
  )
  /**
   * 写**二进制**（粘贴进编辑器的图片）：授权闸与文本写一致，但**不碰编码与行尾**。
   * 渲染层把剪贴板里的图片字节交过来，落盘后再由 `lumin-file://` 渲染。
   */
  ipcMain.handle('file:writeBinary', async (_, p: string, bytes: Uint8Array) => {
    const fp = pathGrants.assertAuthorized(p, 'write')
    await fileOps.writeBinary(fp, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  })
  /**
   * 把一张外部图片复制进工作区（拖入 / 「选择文件…」用）。
   * `source` 只需**读**授权（拖入时渲染层已申请过、选择文件时这里刚授权），
   * `dir` 需要**写**授权 —— 只可能落在工作区或已打开文档所在目录里。
   */
  ipcMain.handle('file:importImage', async (_, source: string, dir: string, baseName: string) => {
    const src = pathGrants.assertAuthorized(source, 'read')
    const dest = pathGrants.assertAuthorized(dir, 'write')
    return fileOps.importImage(src, dest, baseName)
  })
  /** 「选择文件…」：原生对话框选一张图片，选中的路径登记读写授权后返回 */
  ipcMain.handle('file:chooseImage', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        {
          name: mainT('dialog.images'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']
        },
        { name: mainT('dialog.allFiles'), extensions: ['*'] }
      ]
    })
    const picked = r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    if (picked) pathGrants.grantFileReadWrite(picked)
    return picked
  })
  /** 本地历史：某个文件的快照列表（新的在前；不含正文） */
  ipcMain.handle('history:list', (_, p: string, limit = 30) =>
    db.listHistory(path.resolve(p), limit)
  )
  /** 本地历史：取某条快照的正文（回滚用） */
  ipcMain.handle('history:get', (_, id: number) => db.getHistory(id))
  /** 本地历史：清空（不传路径 = 清全部） */
  ipcMain.handle('history:clear', (_, p?: string) =>
    db.clearHistory(p ? path.resolve(p) : undefined)
  )
  /** 本地历史：条数 / 文件数 / 字节（设置面板显示 + 抽稀前后对比用） */
  ipcMain.handle('history:stats', () => db.historyStats())
  /** 「选择编码重新打开」用：把用户显式选的编码记进每文件记忆表 */
  ipcMain.handle('file:rememberEncoding', (_, p: string, encoding: ConcreteEncoding) => {
    rememberEncoding(path.resolve(p), encoding)
  })
  ipcMain.handle('file:readDir', (_, dir: string) =>
    fileOps.readDir(fileOps.assertWorkspacePath(dir))
  )
  ipcMain.handle('file:scanWorkspace', (_, dir: string) =>
    fileOps.scanWorkspace(fileOps.assertWorkspacePath(dir))
  )
  ipcMain.handle('file:createFile', async (_, p: string) => {
    const fp = fileOps.assertWorkspacePath(p)
    await fileOps.writeFile(fp, '')
  })
  ipcMain.handle('file:createDir', async (_, p: string) => {
    const fp = fileOps.assertWorkspacePath(p)
    const fs = await import('fs/promises')
    await fs.mkdir(fp, { recursive: true })
  })
  ipcMain.handle('file:remove', async (_, p: string) => {
    const fp = fileOps.assertWorkspacePath(p)
    // 顺序要紧：**先删盘再删索引**。反过来的话 `trashItem`/`rm` 失败时，
    // 文件还在而搜索与最近列表里已经找不到它了（表现为"文件莫名消失"）。
    const result = await fileOps.removeEntry(fp)
    db.deleteDocument(fp)
    return result
  })
  ipcMain.handle('file:rename', async (_, o: string, n: string) => {
    const from = fileOps.assertWorkspacePath(o)
    const to = fileOps.assertWorkspacePath(n)
    // ⚠️ 必须在改盘**之前**判断它是目录还是文件：`from` 改完名就不存在了，
    // 那时 stat 只会失败（第一版就是这么写的 —— 目录被当成文件走 `renameDocument`，
    // 子孙文档的索引与历史全部留在旧路径上，验收套件当场抓住）
    const isDir = await stat(from).then(
      (st) => st.isDirectory(),
      () => false
    )
    // 先改盘再改索引：目标已存在时 `renameEntry` 会抛 TARGET_EXISTS，此时索引不该动
    await fileOps.renameEntry(from, to)
    // 目录改名要把**子孙文档**的索引一起搬（审计 §2 P1 第 124 条）：
    // 只改被重命名那个节点的话，子文档的 path/history 还指着旧路径，
    // 搜索、最近列表、标签、本地历史全部对不上号
    if (isDir) db.renameDirectory(from, to)
    else db.renameDocument(from, to)
  })
  ipcMain.handle('file:exists', (_, p: string) =>
    fileOps.exists(pathGrants.assertAuthorized(p, 'read'))
  )
  ipcMain.handle('file:chooseOpenFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
        { name: mainT('dialog.allFiles'), extensions: ['*'] }
      ]
    })
    const picked = r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    // 用户亲手选的 → 读写授权（见 services/pathGrants）
    if (picked) pathGrants.grantFileReadWrite(picked)
    return picked
  })
  /**
   * 「保存到哪」对话框。`dir` = 对话框**默认落在的文件夹**（渲染层给：未命名文档传侧栏工作区，
   * 另存为传文档自己的文件夹）—— 于是 Ctrl+N → 写两行 → Ctrl+S，默认就是存进侧栏那个工作区。
   * 目录不存在（工作区被移走/删掉）或没给，就退回只给文件名：交给系统记上次的位置，
   * 总比甩一个死路径出去好。
   */
  ipcMain.handle(
    'file:chooseSaveFile',
    async (_, name: string, ext: string, dir?: string | null) => {
      const win = BrowserWindow.getFocusedWindow()
      const defaultPath = dir && existsSync(dir) ? path.join(dir, name) : name
      const r = await dialog.showSaveDialog(win!, {
        defaultPath,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
      const picked = r.canceled || !r.filePath ? null : r.filePath
      // 用户亲手选的保存位置 → 读写授权（否则紧接着的 file:write 会被授权闸拦下）
      if (picked) pathGrants.grantFileReadWrite(picked)
      return picked
    }
  )
  ipcMain.handle('file:chooseFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    const picked = r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    if (picked) pathGrants.grantDir(picked)
    return picked
  })
  /**
   * 把用户**拖进窗口**的那个路径登记为只读授权。
   *
   * 为什么需要这条 IPC：拖放由渲染层收到 `File` 后用 `webUtils.getPathForFile` 取路径，
   * 主进程完全不知道这次用户意图 —— 没有它，拖入文件会被授权闸拦掉（功能回退）。
   * 口径见 services/pathGrants 的说明：它把"静默的任意路径访问"收窄成"一次显式的、可审计的申请"，
   * **不是**沙箱边界；并且只对**已存在**的文件授予只读。
   */
  ipcMain.handle('file:authorizeUserPath', (_, p: string) =>
    pathGrants.grantDroppedRead(path.resolve(p))
  )
  ipcMain.handle('file:getPathForFile', (_, file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  })
  ipcMain.handle('file:fileUrl', (_, p: string) =>
    fileOps.toFileUrl(pathGrants.assertAuthorized(p, 'read'))
  )
  ipcMain.handle('file:dirname', (_, p: string) => path.dirname(p))
  ipcMain.handle('file:join', (_, dir: string, name: string) => path.join(dir, name))
  ipcMain.handle('file:basename', (_, p: string) => path.basename(p))

  // ── 设置 / 工作区（SQLite kv 持久化）──
  ipcMain.handle('settings:getAll', () => db.kvGet<AppSettings>('settings', defaultSettings))
  ipcMain.handle('settings:update', (_, partial: Partial<AppSettings>) => {
    const merged = deepMerge(db.kvGet<AppSettings>('settings', defaultSettings), partial)
    db.kvSet('settings', merged)
    // 同步原生主题（Windows 标题栏颜色 / prefers-color-scheme）：
    // 切换主题时标题栏也要随之切换，否则顶部原生标题栏颜色不跟随应用主题
    nativeTheme.themeSource =
      merged.theme === 'auto' ? 'system' : merged.theme === 'sepia' ? 'light' : merged.theme
    // 任务栏跳转列表里的分类名/任务描述是本地化文案，最近文档也来自设置：
    // 换语言或最近列表变化（含用户在界面上「清空最近」）时顺手重建
    if (partial.language || partial.recentFiles) taskbar.refreshJumpList()
    // 原生菜单也是本地化文案：换语言必须**立刻重建**，否则要重启才生效（用户按 Alt 看到的还是旧语言）
    if (partial.language) installMenu()
    // 用户刚打开「自动检查更新」时立刻查一次，否则要等下次启动，像开关没反应
    onSettingsChanged(partial)
    // 备份：刚打开开关或刚换了目录时，先看该不该立即备一份 ——
    // 换到新目录后目录是空的，`isBackupDue` 会判为"该备"，用户马上就能看到第一份
    if (partial.backupAuto !== undefined || partial.backupDir !== undefined) {
      void dbBackup.maybeAutoBackup()
    }
    return merged
  })
  ipcMain.handle('workspace:getRoot', () => {
    const ws = db.kvGet<{ root: string | null }>('workspace', { root: null })
    return ws.root
  })
  ipcMain.handle('workspace:setRoot', (_, root: string | null) => {
    const ws = db.kvGet<{ root: string | null }>('workspace', { root: null })
    ws.root = root
    db.kvSet('workspace', ws)
    if (root) startWorkspaceWatch(root)
    else stopWorkspaceWatch()
    // 换工作区时顺手清掉上一轮崩溃残留的写盘临时文件（里面是用户全文的副本）——不阻塞返回
    if (root) void sweepTempFiles(root)
    // 全文索引：**后台**把从未打开过的文档也收进搜索（审计 §7 第 17 条）。
    // 不 await：索引是后台行为，返回工作区根目录不该被几千篇文档的读取拖住。
    if (root) {
      void workspaceIndex.indexWorkspace(root).catch(() => {})
    } else {
      workspaceIndex.cancelIndex() // 关掉工作区 = 取消正在跑的索引
    }
  })
  /** 索引进度（设置/搜索面板显示"已索引 n 篇"与"正在索引…"） */
  ipcMain.handle('workspace:indexStatus', () => workspaceIndex.indexStatus())
  /** 手动重建索引（低频：换机器、库被清过、怀疑索引不全时用） */
  ipcMain.handle('workspace:reindex', async () => {
    const ws = db.kvGet<{ root: string | null }>('workspace', { root: null })
    if (!ws.root) return { root: null, scanned: 0, indexed: 0, running: false }
    return workspaceIndex.indexWorkspace(ws.root)
  })
  // 索引进度推给所有窗口（搜索面板据此显示"正在索引… / 已索引 n 篇"）
  workspaceIndex.onIndexProgress((s) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('workspace:indexProgress', s)
    }
  })

  // ── 数据库（文档元数据 / 全文搜索）──
  ipcMain.handle('db:search', (_, query: string, limit?: number) => db.search(query, limit ?? 30))
  ipcMain.handle('db:getDocument', (_, p: string) => db.getDocument(path.resolve(p)))
  ipcMain.handle('db:deleteDocument', (_, p: string) => db.deleteDocument(path.resolve(p)))
  ipcMain.handle('db:listRecent', (_, limit?: number) => db.listRecent(limit ?? 30))
  ipcMain.handle('db:setPinned', (_, p: string, pinned: boolean) =>
    db.setPinned(path.resolve(p), pinned)
  )
  ipcMain.handle('db:setTags', (_, p: string, tags: string[]) => db.setTags(path.resolve(p), tags))
  ipcMain.handle('db:stats', () => db.stats())
  /**
   * 数据库维护（审计 §2 P1：全仓无 VACUUM / integrity_check / 重建索引入口）。
   * 三条都只在用户显式点击时跑 —— 尤其 VACUUM 会重建整个库，不该放在启动路径上。
   */
  ipcMain.handle('db:integrityCheck', () => db.integrityCheck())
  ipcMain.handle('db:rebuildIndex', () => ({ rebuilt: db.rebuildFtsIndex() }))
  ipcMain.handle('db:vacuum', () => {
    // 先把 WAL 收进去再压缩，不然压缩完 -wal 里还留着一份旧数据
    db.checkpoint()
    const { before, after } = db.vacuum()
    return { before, after, saved: Math.max(0, before - after) }
  })

  /**
   * 备份（审计 §2 P1）。两条路都是**用户可见的动作**，所以返回值必须能解释清楚：
   * 库备份失败不 reject（后台行为也会调它），把原因放在返回值里由界面提示；
   * 工作区快照取消（另存为对话框点了取消）返回 null，不是错误。
   */
  ipcMain.handle('backup:status', () => dbBackup.backupStatus())
  ipcMain.handle('backup:run', () => dbBackup.runBackup('manual'))
  ipcMain.handle('backup:chooseDir', async () => {
    const current = dbBackup.backupDir()
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
      title: mainT('settings.backupChooseDir'),
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    })
    const picked = r.canceled || !r.filePaths.length ? null : r.filePaths[0]
    if (picked) {
      const merged = deepMerge(db.kvGet<AppSettings>('settings', defaultSettings), {
        backupDir: picked
      })
      db.kvSet('settings', merged)
      // 换目录后目录是空的 → 立刻补第一份（不然用户要等到"明天"才看到有备份）
      void dbBackup.maybeAutoBackup()
    }
    return dbBackup.backupStatus()
  })
  ipcMain.handle('backup:useDefaultDir', () => {
    const merged = deepMerge(db.kvGet<AppSettings>('settings', defaultSettings), {
      backupDir: null
    })
    db.kvSet('settings', merged)
    return dbBackup.backupStatus()
  })
  ipcMain.handle('backup:revealDir', async () => {
    const dir = dbBackup.backupDir()
    // 目录可能还没建过（新 profile / 刚换目录）：先建出来，否则 shell 打开会报错
    await mkdir(dir, { recursive: true }).catch(() => {})
    return shell.openPath(dir)
  })
  ipcMain.handle('backup:snapshotWorkspace', async () => {
    const root = db.kvGet<{ root: string | null }>('workspace', { root: null }).root
    if (!root) throw new Error('WORKSPACE_NOT_OPEN')
    return workspaceBackup.snapshotWorkspace(root)
  })

  // ── 通知中心（SQLite 持久化，按窗口作用域隔离）──
  // 通知属于「产生它的那个窗口」：作用域由主进程从 IPC 发送方反查（渲染进程无法指定），
  // 读写都带 scope 条件，变更信号也只回给发起窗口——多窗口下各窗口的通知互不干扰。
  const scopeOf = (event: IpcMainInvokeEvent): string => scopeOfSender(event.sender)
  const notifySender = (event: IpcMainInvokeEvent): void => {
    if (!event.sender.isDestroyed()) event.sender.send('notifications:changed')
  }
  ipcMain.handle('notifications:list', (event, options?: NotificationListOptions) =>
    db.listNotifications(scopeOf(event), options)
  )
  ipcMain.handle('notifications:add', (event, input: NotificationInput) => {
    const saved = db.addNotification(scopeOf(event), input)
    notifySender(event)
    return saved
  })
  ipcMain.handle('notifications:update', (event, id: number, patch: NotificationPatch) => {
    const saved = db.updateNotification(scopeOf(event), id, patch)
    notifySender(event)
    return saved
  })
  ipcMain.handle('notifications:close', (event, id: number) => {
    db.closeNotification(scopeOf(event), id)
    notifySender(event)
  })
  ipcMain.handle('notifications:closeAll', (event) => {
    const n = db.closeAllNotifications(scopeOf(event))
    notifySender(event)
    return n
  })
  ipcMain.handle('notifications:remove', (event, id: number) => {
    db.removeNotification(scopeOf(event), id)
    notifySender(event)
  })
  ipcMain.handle('notifications:clearClosed', (event) => {
    const n = db.clearClosedNotifications(scopeOf(event))
    notifySender(event)
    return n
  })

  // ── 编辑器右键菜单的动作使用记录（SQLite 持久化）──
  ipcMain.handle('menu:usage:list', (_, limit?: number) => db.listMenuUsage(limit ?? 8))
  ipcMain.handle('menu:usage:bump', (_, actionId: string) => db.bumpMenuUsage(actionId))
  ipcMain.handle('menu:usage:forget', (_, actionId: string) => db.forgetMenuUsage(actionId))
  ipcMain.handle('menu:usage:reset', () => db.resetMenuUsage())

  // ── 「一个文件只开一个窗口」：文档归属上报 + 打开前先看有没有别处已开着 ──
  // 渲染层在文档切换时上报（见 renderer lib/openFile.ts）；要打开的文件若已在别的
  // 窗口开着，`window:focusByDoc` 直接把那个窗口唤到前面（返回 focused），
  // 渲染层据此不再新建窗口；返回 not-open 时才走原本的「在新窗口打开」。
  ipcMain.on('window:docPath', (event, docPath: string | null) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) openDocs.setWindowDoc(win, docPath)
    // 文档换了就顺手重建任务栏跳转列表的「最近打开」（延迟到落库后再读，见 services/taskbar）
    if (docPath) taskbar.scheduleRefresh()
  })
  ipcMain.handle('window:focusByDoc', (event, docPath: string) => {
    const self = BrowserWindow.fromWebContents(event.sender)
    const target = openDocs.findWindowWithDoc(docPath, self?.id)
    if (!target) return 'not-open'
    if (target.id !== self?.id) openDocs.focusWindow(target)
    return 'focused'
  })
  // 应用内快速切换窗口（默认 Ctrl+Tab / Ctrl+Shift+Tab）：
  // 按窗口创建顺序循环（1 个窗口时不动，2 个时来回切，N 个时依次走），
  // 与浏览器 Ctrl+Tab 切标签页的直觉一致。
  ipcMain.handle('window:cycle', (event, delta: number) => {
    const self = BrowserWindow.fromWebContents(event.sender)
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length < 2) return null
    const idx = Math.max(
      0,
      wins.findIndex((w) => w.id === self?.id)
    )
    const step = delta < 0 ? -1 : 1
    const next = wins[(idx + step + wins.length) % wins.length]
    openDocs.focusWindow(next)
    return next.id
  })

  // ── 草稿 ──
  ipcMain.handle('drafts:save', (event, key: string, content: string, p: string | null) => {
    // 落上「是哪个窗口实例写的」：槽位号会被复用，只有 uid 答得准「这格草稿是不是我的」
    const win = BrowserWindow.fromWebContents(event.sender)
    return drafts.saveDraft(key, content, p, win ? slots.uidOf(win.id) : null)
  })
  ipcMain.handle('drafts:load', (_, key: string) => drafts.loadDraft(key))
  ipcMain.handle('drafts:remove', (_, key: string) => drafts.removeDraft(key))
  /**
   * 本窗口该用的未命名草稿。两种来源（见 main/drafts.ts）：
   *  1. 我自己上次写的那份（uid 相同，reload 不丢内容）→ 任何窗口都给；
   *  2. 「无主草稿」（写它的窗口已经不在 / 上一次运行留下的）→ **只有启动窗口**认领。
   * Ctrl+N / 新建窗口是用户明确要一篇空白，冒出「检测到上次未保存的内容」是错的（实测踩过）。
   */
  ipcMain.handle('drafts:untitledDraft', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const mySlot = slots.slotOf(win.id)
    return drafts.takeUntitledDraft({
      ownKey: untitledDraftKey(mySlot),
      myUid: slots.uidOf(win.id),
      liveUids: slots.liveUids(),
      liveSlots: slots.liveSlots(),
      plannedSlots: slots.plannedSlots(),
      mySlotRestored: slots.slotRestored(mySlot),
      mayClaimOrphan: slots.mayClaimUntitledDraft(win.id)
    })
  })

  // ── 导出 ──
  ipcMain.handle('export:pdf', (_, payload: ExportPayload, s: AppSettings['export']['pdf']) =>
    exportSvc.exportPdf(payload, s)
  )
  ipcMain.handle('export:html', (_, payload: ExportPayload) => exportSvc.exportHtml(payload))
  ipcMain.handle('export:word', (_, payload: ExportPayload) => exportSvc.exportWord(payload))
  ipcMain.handle('export:epub', (_, meta: EpubMeta) => exportSvc.exportEpub(meta))

  // ── 会话恢复：按窗口槽位读写（窗口生命周期在 index.ts）──
  ipcMain.handle('session:get', () => session.readSession())
  ipcMain.handle('session:save', (_, index: number, slot: SessionSlot | null) =>
    session.writeSessionSlot(index, slot)
  )

  // ── 外部链接与「用默认应用打开」（链接逻辑见 services/links.ts）──
  // 统一走白名单校验：文档里的链接不可信，绝不让任意 scheme 落到系统处理器
  ipcMain.on('shell:openExternal', (_, url: string) => {
    const safe = links.safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
  })
  ipcMain.handle('shell:openPath', async (_, p: string) => {
    const abs = path.resolve(p)
    /**
     * 纵深防御：可执行 / 脚本类**永远不交给系统 shell**。
     * 正常路径上渲染层已经用 `links:resolve` 的 `unsafe-target` 拦过一次（有提示、有记录），
     * 这里是最后一道闸 —— 渲染层任何一处漏判都不会变成"文档里点一下就运行本地程序"。
     * 返回一句可识别的原因（而不是静默失败），渲染层会把它显示出来。
     */
    if (links.isUnsafeOpenTarget(abs)) return 'UNSAFE_OPEN_TARGET'
    // shell.openPath 返回空字符串表示成功，否则是系统给的错误信息
    return shell.openPath(abs)
  })

  // ── 链接目标：解析 / 创建 / 历史记录 ──
  ipcMain.handle('links:resolve', (_, target: string, baseDir: string | null) =>
    links.resolveLinkTarget(target, baseDir)
  )
  ipcMain.handle('links:create', (_, p: string, type: 'file' | 'directory') =>
    links.createLinkTarget(p, type)
  )
  ipcMain.handle('links:record', (_, record: LinkActivateRecord) => db.recordLinkOpen(record))
  ipcMain.handle('links:history', (_, limit?: number) => db.listLinkHistory(limit ?? 50))
  ipcMain.handle('links:forget', (_, target: string) => db.forgetLinkOpen(target))
  ipcMain.handle('links:clear', () => db.clearLinkHistory())

  // 启动时若已记住工作区，恢复对根目录的监听 + 扫一遍崩溃残留的写盘临时文件
  const existingRoot = db.kvGet<{ root: string | null }>('workspace', { root: null }).root
  if (existingRoot) {
    startWorkspaceWatch(existingRoot)
    void sweepTempFiles(existingRoot)
  }
}

/**
 * 清掉工作区里残留的写盘临时文件（`<name>.<8位随机>.lumin-tmp`）。
 * 只在**打开/恢复工作区**时跑一次；失败只记一行 ASCII 日志，不影响任何主流程。
 */
async function sweepTempFiles(root: string): Promise<void> {
  try {
    const removed = await fileOps.cleanStaleTempFiles(root)
    if (removed) console.log(`[tempfiles] swept ${removed} stale lumin-tmp file(s)`)
  } catch {
    /* 清理失败不该影响打开工作区 */
  }
}

/**
 * 窗口关闭前：给渲染进程保存机会（quitting 用于区分「整体退出」与「单独关窗」）。
 *
 * ─── 兜底为什么不再是"固定 2.5 秒"（审计 §2 P1）────────────────────────────────
 * 原来到点无条件 `win.close()`，慢盘 / 大文件下 `flushAll()` 还没跑完窗口就没了 ——
 * 丢的正是"用户以为已经保存"的那一段。现在：
 *   * 渲染层在关窗流程里**按秒发心跳**（`app:closeProgress`，见 useAppActions 的 requestClose）；
 *   * 每收到一次心跳就把兜底计时器重置（"还在落盘就继续等"）；
 *   * 连续 `CLOSE_FALLBACK_MS` 没有心跳 → 认定它卡住，强制关闭；
 *   * 总时长到 `CLOSE_FALLBACK_MAX_MS` → 无论有没有心跳都强制关闭
 *     （不能让一个挂死的渲染进程把"关不掉窗口"变成新问题）。
 * 判据本身是纯函数 `shouldForceClose`（shared/closeGuard.ts，有单测）。
 */
export function attachCloseGuard(win: BrowserWindow): void {
  /**
   * Windows 关机 / 注销（审计 §2 P2：此前全仓没有 `session-end`）。
   *
   * ⚠️ 这是 **BrowserWindow** 的事件（不是 app 的）：每个窗口各收到一次。系统不会等我们，
   * 也不保证逐窗 `close` 事件都来得及走完 —— 能做的只有"**尽早**让这个窗口开始落盘"
   * （草稿是原子写的，半途被杀也不会留下坏文件），而不是等兜底强杀那一刻（那时窗口里
   * 没写出去的内容就真没了）。所以这里直接复用关窗那条路：`before-close` → `flushAll`。
   */
  win.on('session-end', () => {
    session.markQuitting()
    beginShutdown('session-end')
    if (!win.isDestroyed() && !closeConfirmed.has(win)) {
      win.webContents.send('app:before-close', { quitting: true })
    }
  })

  win.on('close', (e) => {
    if (closeConfirmed.has(win)) return
    e.preventDefault()
    const now = Date.now()
    closeGuardState.set(win, { startedAtMs: now, lastProgressMs: now })
    win.webContents.send('app:before-close', { quitting: session.isQuitting() })
    armCloseFallback(win)
    win.once('closed', () => {
      const timer = closeTimers.get(win)
      if (timer) clearTimeout(timer)
      closeTimers.delete(win)
      closeGuardState.delete(win)
    })
  })
}

/** 排一轮兜底：到点先问判据，该等就再排一轮（心跳会把它重置得更早） */
function armCloseFallback(win: BrowserWindow): void {
  const prev = closeTimers.get(win)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    if (win.isDestroyed()) return
    const state = closeGuardState.get(win)
    const decision = state
      ? shouldForceClose(state, Date.now())
      : { force: true, waitedMs: 0, reason: 'stalled' as const }
    if (!decision.force) {
      armCloseFallback(win)
      return
    }
    // 主进程 console 一律 ASCII（tests/mainConsoleAscii.test.mjs）
    console.log(`[close] force after ${decision.waitedMs}ms (${decision.reason})`)
    closeConfirmed.add(win)
    win.close()
  }, CLOSE_FALLBACK_MS)
  closeTimers.set(win, timer)
}
