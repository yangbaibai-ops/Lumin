import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettings, ExportPayload, EpubMeta, LuminAPI, MenuAction } from '../shared/types'

/** 解析主进程通过 additionalArguments 传入的「新窗口要打开的文件路径」 */
const startupFile: string | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-open='))
  if (!arg) return null
  return decodeURIComponent(arg.slice(arg.indexOf('=') + 1))
})()

/** 「新窗口要作为工作区打开的文件夹」（最近文件夹 → 新窗口） */
const startupFolder: string | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-open-folder='))
  if (!arg) return null
  return decodeURIComponent(arg.slice(arg.indexOf('=') + 1))
})()

/** 「新建窗口」的干净窗口标记：不继承当前工作区（见主进程 WindowOpenOptions.noWorkspace） */
const startupNoWorkspace: boolean = process.argv.includes('--lumin-no-workspace=1')

/** 本窗口的会话槽位（主进程分配；null = 不参与会话恢复） */
const sessionSlot: number | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-session-slot='))
  if (!arg) return null
  const n = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isInteger(n) && n >= 0 ? n : null
})()

// Custom APIs for renderer
const api: LuminAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
    confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
    minimize: () => ipcRenderer.send('app:minimize'),
    toggleMaximize: () => ipcRenderer.send('app:toggleMaximize'),
    close: () => ipcRenderer.send('app:close'),
    setMenuBar: (visible) => ipcRenderer.send('app:setMenuBar', visible),
    newWindow: () => ipcRenderer.send('app:newWindow'),
    openInNewWindow: (path) => ipcRenderer.send('app:openInNewWindow', path),
    openFolderInNewWindow: (path) => ipcRenderer.send('app:openFolderInNewWindow', path),
    /** 上报「本窗口当前打开的文档」：主进程据此避免同一个文件被两个窗口重复打开 */
    reportWindowDoc: (path) => ipcRenderer.send('window:docPath', path),
    /** 该文件若已开在别的窗口 → 把那个窗口唤到前面并返回 'focused'；否则 'not-open' */
    focusWindowByDoc: (path) => ipcRenderer.invoke('window:focusByDoc', path),
    /** 应用内切换窗口：delta = +1 下一个 / -1 上一个（默认 Ctrl+Tab / Ctrl+Shift+Tab） */
    cycleWindow: (delta) => ipcRenderer.invoke('window:cycle', delta),
    startupFile,
    startupFolder,
    startupNoWorkspace,
    sessionSlot
  },
  file: {
    read: (path, encoding) => ipcRenderer.invoke('file:read', path, encoding),
    write: (path, content, encoding, hadBom) =>
      ipcRenderer.invoke('file:write', path, content, encoding, hadBom),
    rememberEncoding: (path, encoding) => ipcRenderer.invoke('file:rememberEncoding', path, encoding),
    readDir: (dir) => ipcRenderer.invoke('file:readDir', dir),
    scanWorkspace: (root) => ipcRenderer.invoke('file:scanWorkspace', root),
    createFile: (path) => ipcRenderer.invoke('file:createFile', path),
    createDir: (path) => ipcRenderer.invoke('file:createDir', path),
    remove: (path) => ipcRenderer.invoke('file:remove', path),
    rename: (oldPath, newPath) => ipcRenderer.invoke('file:rename', oldPath, newPath),
    exists: (path) => ipcRenderer.invoke('file:exists', path),
    chooseOpenFile: () => ipcRenderer.invoke('file:chooseOpenFile'),
    chooseSaveFile: (name, ext) => ipcRenderer.invoke('file:chooseSaveFile', name, ext),
    chooseFolder: () => ipcRenderer.invoke('file:chooseFolder'),
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return null
      }
    },
    fileUrl: (path) => ipcRenderer.invoke('file:fileUrl', path),
    dirname: (path) => ipcRenderer.invoke('file:dirname', path),
    join: (dir, name) => ipcRenderer.invoke('file:join', dir, name),
    basename: (path) => ipcRenderer.invoke('file:basename', path)
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    update: (partial: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', partial)
  },
  workspace: {
    getRoot: () => ipcRenderer.invoke('workspace:getRoot'),
    setRoot: (path) => ipcRenderer.invoke('workspace:setRoot', path)
  },
  drafts: {
    save: (key, content, path) => ipcRenderer.invoke('drafts:save', key, content, path),
    load: (key) => ipcRenderer.invoke('drafts:load', key),
    remove: (key) => ipcRenderer.invoke('drafts:remove', key),
    hasUntitled: () => ipcRenderer.invoke('drafts:hasUntitled')
  },
  db: {
    search: (query, limit) => ipcRenderer.invoke('db:search', query, limit),
    getDocument: (path) => ipcRenderer.invoke('db:getDocument', path),
    deleteDocument: (path) => ipcRenderer.invoke('db:deleteDocument', path),
    listRecent: (limit) => ipcRenderer.invoke('db:listRecent', limit),
    setPinned: (path, pinned) => ipcRenderer.invoke('db:setPinned', path, pinned),
    setTags: (path, tags) => ipcRenderer.invoke('db:setTags', path, tags),
    stats: () => ipcRenderer.invoke('db:stats')
  },
  notifications: {
    list: (options) => ipcRenderer.invoke('notifications:list', options),
    add: (input) => ipcRenderer.invoke('notifications:add', input),
    update: (id, patch) => ipcRenderer.invoke('notifications:update', id, patch),
    close: (id) => ipcRenderer.invoke('notifications:close', id),
    closeAll: () => ipcRenderer.invoke('notifications:closeAll'),
    remove: (id) => ipcRenderer.invoke('notifications:remove', id),
    clearClosed: () => ipcRenderer.invoke('notifications:clearClosed')
  },
  menuUsage: {
    list: (limit) => ipcRenderer.invoke('menu:usage:list', limit),
    bump: (actionId) => ipcRenderer.invoke('menu:usage:bump', actionId),
    forget: (actionId) => ipcRenderer.invoke('menu:usage:forget', actionId),
    reset: () => ipcRenderer.invoke('menu:usage:reset')
  },
  export: {
    pdf: (payload: ExportPayload, settings) => ipcRenderer.invoke('export:pdf', payload, settings),
    html: (payload: ExportPayload) => ipcRenderer.invoke('export:html', payload),
    word: (payload: ExportPayload) => ipcRenderer.invoke('export:word', payload),
    epub: (meta: EpubMeta) => ipcRenderer.invoke('export:epub', meta)
  },
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
    openPath: (path) => ipcRenderer.invoke('shell:openPath', path)
  },
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    save: (index, slot) => ipcRenderer.invoke('session:save', index, slot)
  },
  links: {
    resolve: (target, baseDir) => ipcRenderer.invoke('links:resolve', target, baseDir),
    create: (path, type) => ipcRenderer.invoke('links:create', path, type),
    record: (record) => ipcRenderer.invoke('links:record', record),
    history: (limit) => ipcRenderer.invoke('links:history', limit),
    forget: (target) => ipcRenderer.invoke('links:forget', target),
    clear: () => ipcRenderer.invoke('links:clear')
  },
  events: {
    on: (channel, cb) => {
      const listener = (_: unknown, payload?: unknown): void => cb(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

export type { MenuAction }

// 仅通过 contextBridge 暴露有限 API（contextIsolation 开启 + sandbox 模式）
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('luminAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.luminAPI = api
}
