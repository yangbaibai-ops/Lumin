// ─── 主进程：IPC 注册 ─────────────────────────────────────────────────────
import { ipcMain, dialog, BrowserWindow, webUtils, shell, nativeTheme } from 'electron'
import path from 'path'
import { watch, type FSWatcher } from 'fs'
import * as fileOps from './fileOps'
import * as exportSvc from './export'
import * as drafts from './drafts'
import { db } from './services/database'
import { defaultSettings } from '../shared/defaults'
import type { AppSettings, ExportPayload, EpubMeta } from '../shared/types'

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

export function registerIpc(): void {
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
  ipcMain.handle('file:read', async (_, p: string) => {
    const fp = path.resolve(p)
    const { content, mtimeMs } = await fileOps.readFileInfo(fp)
    const name = path.basename(fp)
    // 打开即建立/刷新数据库索引（元数据 + 全文）
    db.upsertDocument({ path: fp, title: name, content })
    db.touchOpened(fp, name)
    return { path: fp, name, content, mtimeMs }
  })
  ipcMain.handle('file:write', async (_, p: string, content: string) => {
    const fp = path.resolve(p)
    await fileOps.writeFile(fp, content)
    // 保存时同步元数据 + 全文索引
    db.upsertDocument({ path: fp, title: path.basename(fp), content })
  })
  ipcMain.handle('file:readDir', (_, dir: string) => fileOps.readDir(fileOps.assertWorkspacePath(dir)))
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
  ipcMain.handle('file:remove', (_, p: string) => {
    const fp = fileOps.assertWorkspacePath(p)
    db.deleteDocument(fp)
    return fileOps.removeEntry(fp)
  })
  ipcMain.handle('file:rename', (_, o: string, n: string) => {
    const from = fileOps.assertWorkspacePath(o)
    const to = fileOps.assertWorkspacePath(n)
    db.renameDocument(from, to)
    return fileOps.renameEntry(from, to)
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
  ipcMain.handle('file:chooseSaveFile', async (_, name: string, ext: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: name,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    return r.canceled || !r.filePath ? null : r.filePath
  })
  ipcMain.handle('file:chooseFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
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

  // ── 草稿 ──
  ipcMain.handle('drafts:save', (_, key: string, content: string, p: string | null) =>
    drafts.saveDraft(key, content, p)
  )
  ipcMain.handle('drafts:load', (_, key: string) => drafts.loadDraft(key))
  ipcMain.handle('drafts:remove', (_, key: string) => drafts.removeDraft(key))
  ipcMain.handle('drafts:hasUntitled', () => drafts.loadDraft('untitled'))

  // ── 导出 ──
  ipcMain.handle('export:pdf', (_, payload: ExportPayload, s: AppSettings['export']['pdf']) =>
    exportSvc.exportPdf(payload, s)
  )
  ipcMain.handle('export:html', (_, payload: ExportPayload) => exportSvc.exportHtml(payload))
  ipcMain.handle('export:word', (_, payload: ExportPayload) => exportSvc.exportWord(payload))
  ipcMain.handle('export:epub', (_, meta: EpubMeta) => exportSvc.exportEpub(meta))

  // ── 外部链接 ──
  ipcMain.on('shell:openExternal', (_, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // 启动时若已记住工作区，恢复对根目录的监听
  const existingRoot = db.kvGet<{ root: string | null }>('workspace', { root: null }).root
  if (existingRoot) startWorkspaceWatch(existingRoot)
}

/** 窗口关闭前：给渲染进程保存机会 */
export function attachCloseGuard(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (closeConfirmed.has(win)) return
    e.preventDefault()
    win.webContents.send('app:before-close')
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
