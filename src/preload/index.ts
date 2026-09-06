import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettings, ExportPayload, EpubMeta, LuminAPI, MenuAction } from '../shared/types'

// Custom APIs for renderer
const api: LuminAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
    confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
    minimize: () => ipcRenderer.send('app:minimize'),
    toggleMaximize: () => ipcRenderer.send('app:toggleMaximize'),
    close: () => ipcRenderer.send('app:close'),
    setMenuBar: (visible) => ipcRenderer.send('app:setMenuBar', visible)
  },
  file: {
    read: (path) => ipcRenderer.invoke('file:read', path),
    write: (path, content) => ipcRenderer.invoke('file:write', path, content),
    readDir: (dir) => ipcRenderer.invoke('file:readDir', dir),
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
  export: {
    pdf: (payload: ExportPayload, settings) => ipcRenderer.invoke('export:pdf', payload, settings),
    html: (payload: ExportPayload) => ipcRenderer.invoke('export:html', payload),
    word: (payload: ExportPayload) => ipcRenderer.invoke('export:word', payload),
    epub: (meta: EpubMeta) => ipcRenderer.invoke('export:epub', meta)
  },
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url)
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
