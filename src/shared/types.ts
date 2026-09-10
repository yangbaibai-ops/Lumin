// ─── Lumin 共享类型定义（main / preload / renderer 共用）───────────────────

export type ThemeMode = 'light' | 'dark' | 'sepia' | 'auto'
export type EffectiveTheme = 'light' | 'dark' | 'sepia'
export type EditorMode = 'wysiwyg' | 'source' | 'split'
export type Language = 'zh-CN' | 'en-US' | 'ru-RU'

export interface ExportSettings {
  pdf: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
  html: { template: 'default' }
}

export interface AppSettings {
  theme: ThemeMode
  language: Language
  autoSave: boolean
  autoSaveInterval: number // 秒
  /** 原生菜单栏（窗口顶部 File/Edit 等）是否可见，默认开 */
  nativeMenuBar: boolean
  fontSize: number
  lineHeight: number
  fontFamily: string
  editorMode: EditorMode
  sidebarVisible: boolean
  sidebarWidth: number
  splitRatio: number // 分屏对比视图左右宽度比（左面板占比 0.25~0.75）
  syncScroll: boolean // 分屏对比视图左右滚动进度同步
  codeLineNumbers: boolean // 代码块是否显示行号，默认开
  recentFiles: RecentFile[]
  pinnedFiles: string[]
  export: ExportSettings
}

// ─── 全局通知中心 ──────────────────────────────────────────────────────────
/** 通知级别：通知 / 已完成 / 告警 / 报错（图标与配色由此派生） */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

/** 一条通知（持久化在 SQLite notifications 表，跨会话保留） */
export interface AppNotification {
  id: number
  level: NotificationLevel
  /** 标题（一行，必填） */
  title: string
  /** 详情（可空；多行时卡片内滚动） */
  body: string
  createdAt: number
  /** 关闭时间；null = 仍在通知中心里 */
  closedAt: number | null
}

/** 新建通知的入参 */
export interface NotificationInput {
  level?: NotificationLevel
  title: string
  body?: string
  /**
   * 合并键：同键的未关闭通知会被「更新并置顶」而不是再插一条。
   * 默认取 level+title —— 反复保存/反复失败只占一个卡片位，避免刷屏。
   */
  mergeKey?: string
}

export interface NotificationPatch {
  level?: NotificationLevel
  title?: string
  body?: string
}

export interface NotificationListOptions {
  /** 连同已关闭一起返回（历史查询用） */
  includeClosed?: boolean
  limit?: number
}

// ─── 编辑器右键菜单的「使用记录」（SQLite 持久化，驱动「最近使用」）──────────
export interface MenuUsageEntry {
  /** 动作稳定标识，如 table.rowBelow */
  actionId: string
  /** 累计使用次数（保留给后续的「常用」排序/统计） */
  count: number
  /** 最近一次使用时间戳 */
  lastUsed: number
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

/** 文件列表视图（Typora 式侧边栏「列表」）：工作区 Markdown 文章的扁平条目 */
export interface WorkspaceDoc {
  name: string
  /** 相对工作区根目录的路径（分隔符统一为 /），根级为空串 */
  relPath: string
  path: string
  mtimeMs: number
  /** 正文头部预览（去除 Markdown 符号后的一段纯文本） */
  preview: string
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
  | 'mode-split'
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
    /** 原生菜单栏显隐（设置「原生菜单栏」开关时由渲染进程驱动主进程） */
    setMenuBar: (visible: boolean) => void
    /** 新建一个空白窗口（启动到欢迎页，等同新建应用实例） */
    newWindow: () => void
    /** 在新窗口中打开指定文件 */
    openInNewWindow: (path: string) => void
    /** 本窗口启动时要求打开的文件路径（由主进程 additionalArguments 传入，通常为 null） */
    startupFile: string | null
  }
  file: {
    read: (path: string) => Promise<OpenedFile>
    write: (path: string, content: string) => Promise<void>
    readDir: (dir: string) => Promise<FileNode[]>
    /** 递归扫描工作区根目录，返回全部 Markdown 文章（含 mtime 与正文预览） */
    scanWorkspace: (root: string) => Promise<WorkspaceDoc[]>
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
  /** 全局通知中心（持久化在 SQLite notifications 表，跨会话保留） */
  notifications: {
    list: (options?: NotificationListOptions) => Promise<AppNotification[]>
    add: (input: NotificationInput) => Promise<AppNotification>
    update: (id: number, patch: NotificationPatch) => Promise<AppNotification | null>
    close: (id: number) => Promise<void>
    closeAll: () => Promise<number>
    remove: (id: number) => Promise<void>
    clearClosed: () => Promise<number>
  }
  /** 编辑器右键菜单的动作使用记录（SQLite menu_usage 表） */
  menuUsage: {
    list: (limit?: number) => Promise<MenuUsageEntry[]>
    bump: (actionId: string) => Promise<MenuUsageEntry>
    forget: (actionId: string) => Promise<void>
    reset: () => Promise<number>
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
