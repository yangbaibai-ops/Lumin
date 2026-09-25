// ─── 主进程：IPC 注册 ─────────────────────────────────────────────────────
import {
  ipcMain,
  dialog,
  BrowserWindow,
  webUtils,
  shell,
  nativeTheme,
  type IpcMainInvokeEvent
} from 'electron'
import path from 'path'
import { watch, existsSync, type FSWatcher } from 'fs'
import * as fileOps from './fileOps'
import * as exportSvc from './export'
import * as drafts from './drafts'
import * as links from './services/links'
import * as session from './services/session'
import * as openDocs from './services/openDocs'
import * as taskbar from './services/taskbar'
import { onSettingsChanged } from './services/updater'
import { installMenu } from './menu'
import { scopeOfSender } from './services/windowScope'
import { getRememberedEncoding, rememberEncoding } from './services/encoding'
import type { ConcreteEncoding, EncodingId } from '../shared/encodings'
import type { Eol } from '../shared/eol'
import { untitledDraftKey } from '../shared/drafts'
import { db } from './services/database'
import { defaultSettings } from '../shared/defaults'
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
  ipcMain.handle('app:confirmClose', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      closeConfirmed.add(win)
      // 立即重新触发 close：此时 closeConfirmed 已标记，关闭守卫直接放行，
      // 窗口无需再等 2.5s 兜底定时器（否则每次关窗都固定延迟 2.5 秒）
      win.close()
    }
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
      const fp = path.resolve(p)
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
      const fp = path.resolve(p)
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
  /** 本地历史：条数统计（设置面板显示用） */
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
    // 先改盘再改索引：目标已存在时 `renameEntry` 会抛 TARGET_EXISTS，此时索引不该动
    await fileOps.renameEntry(from, to)
    db.renameDocument(from, to)
  })
  ipcMain.handle('file:exists', (_, p: string) => fileOps.exists(path.resolve(p)))
  ipcMain.handle('file:chooseOpenFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
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
      return r.canceled || !r.filePath ? null : r.filePath
    }
  )
  ipcMain.handle('file:chooseFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  ipcMain.handle('file:getPathForFile', (_, file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  })
  ipcMain.handle('file:fileUrl', (_, p: string) => fileOps.toFileUrl(path.resolve(p)))
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

/** 窗口关闭前：给渲染进程保存机会（quitting 用于区分「整体退出」与「单独关窗」） */
export function attachCloseGuard(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (closeConfirmed.has(win)) return
    e.preventDefault()
    win.webContents.send('app:before-close', { quitting: session.isQuitting() })
    // 兜底：渲染进程 2.5s 内未响应则强制关闭
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) {
        closeConfirmed.add(win)
        win.close()
      }
    }, 2500)
    win.once('closed', () => clearTimeout(timer))
  })
}
