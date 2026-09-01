// ─── Lumin 共享类型定义（main / preload / renderer 共用）───────────────────

export type ThemeMode = 'light' | 'dark' | 'sepia' | 'auto'
export type EffectiveTheme = 'light' | 'dark' | 'sepia'
export type EditorMode = 'wysiwyg' | 'source'
export type Language = 'zh-CN' | 'en-US'

export interface ExportSettings {
  pdf: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
  html: { template: 'default' }
}

export interface AppSettings {
  theme: ThemeMode
  language: Language
  autoSave: boolean
  autoSaveInterval: number // 秒
  fontSize: number
  lineHeight: number
  fontFamily: string
  editorMode: EditorMode
  sidebarVisible: boolean
  sidebarWidth: number
  recentFiles: RecentFile[]
  pinnedFiles: string[]
  export: ExportSettings
}

export interface RecentFile {
  path: string
  title: string
  openedAt: number
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface OpenedFile {
  path: string
  name: string
  content: string
  mtimeMs: number
}

export interface DraftInfo {
  key: string
  path: string | null
  content: string
  savedAt: number
}

export interface DocMeta {
  id: number
  path: string
  title: string
  content: string
  createdAt: number
  modifiedAt: number
  lastOpened: number
  wordCount: number
  tags: string[]
  isPinned: boolean
  isArchived: boolean
}

export interface SearchResult {
  path: string
  title: string
  titleSnippet: string
  bodySnippet: string
  modifiedAt: number
}

export interface ExportPayload {
  title: string
  html: string
  css: string
}

export type ExportFormat = 'pdf' | 'html' | 'word' | 'epub'

export interface EpubMeta {
  title: string
  author: string
  lang: string
  html: string
  css: string
}

export type MenuAction =
  | 'new'
  | 'open'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'export-pdf'
  | 'export-html'
  | 'export-word'
  | 'export-epub'
  | 'find'
  | 'global-search'
  | 'toggle-sidebar'
  | 'mode-wysiwyg'
  | 'mode-source'
  | 'toggle-focus'
  | 'toggle-typewriter'
  | 'theme-changed'
  | 'settings'
  | 'about'

export interface LuminAPI {
  app: {
    getVersion: () => Promise<string>
    getPlatform: () => Promise<string>
    confirmClose: () => Promise<void>
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
  }
  file: {
    read: (path: string) => Promise<OpenedFile>
    write: (path: string, content: string) => Promise<void>
    readDir: (dir: string) => Promise<FileNode[]>
    createFile: (path: string) => Promise<void>
    createDir: (path: string) => Promise<void>
    remove: (path: string) => Promise<void>
    rename: (oldPath: string, newPath: string) => Promise<void>
    exists: (path: string) => Promise<boolean>
    chooseOpenFile: () => Promise<string | null>
    chooseSaveFile: (name: string, ext: string) => Promise<string | null>
    chooseFolder: () => Promise<string | null>
    getPathForFile: (file: File) => string | null
    fileUrl: (path: string) => Promise<string>
    dirname: (path: string) => Promise<string>
    join: (dir: string, name: string) => Promise<string>
    basename: (path: string) => Promise<string>
  }
  settings: {
    getAll: () => Promise<AppSettings>
    update: (partial: Partial<AppSettings>) => Promise<AppSettings>
  }
  workspace: {
    getRoot: () => Promise<string | null>
    setRoot: (path: string | null) => Promise<void>
  }
  drafts: {
    save: (key: string, content: string, path: string | null) => Promise<void>
    load: (key: string) => Promise<DraftInfo | null>
    remove: (key: string) => Promise<void>
    hasUntitled: () => Promise<DraftInfo | null>
  }
  db: {
    search: (query: string, limit?: number) => Promise<SearchResult[]>
    getDocument: (path: string) => Promise<DocMeta | null>
    deleteDocument: (path: string) => Promise<void>
    listRecent: (limit?: number) => Promise<DocMeta[]>
    setPinned: (path: string, pinned: boolean) => Promise<void>
    setTags: (path: string, tags: string[]) => Promise<void>
    stats: () => Promise<{ docs: number; fts: number }>
  }
  export: {
    pdf: (payload: ExportPayload, settings: AppSettings['export']['pdf']) => Promise<string | null>
    html: (payload: ExportPayload) => Promise<string | null>
    word: (payload: ExportPayload) => Promise<string | null>
    epub: (meta: EpubMeta) => Promise<string | null>
  }
  shell: {
    openExternal: (url: string) => void
  }
  events: {
    on: (channel: string, cb: (payload?: unknown) => void) => () => void
  }
}
