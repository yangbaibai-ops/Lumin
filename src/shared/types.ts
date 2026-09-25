// ─── Lumin 共享类型定义（main / preload / renderer 共用）───────────────────

export type ThemeMode = 'light' | 'dark' | 'sepia' | 'auto'
export type EffectiveTheme = 'light' | 'dark' | 'sepia'
export type EditorMode = 'wysiwyg' | 'source' | 'split'
import type { ConcreteEncoding, EncodingId } from './encodings'
import type { Eol } from './eol'
import type { HistoryEntry, HistoryEntryMeta } from './history'
export type { HistoryEntry, HistoryEntryMeta }
export type { ConcreteEncoding, EncodingId, Eol }
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
  /**
   * 远程图片加载策略（自查报告 H2）：`click` 默认（点一下才加载，隐私优先）/ `always` 直接加载。
   * 实现见 `src/renderer/src/lib/remoteImages.ts`。
   */
  remoteImages: 'click' | 'always'
  fontSize: number
  lineHeight: number
  fontFamily: string
  editorMode: EditorMode
  /** 编辑区顶部快捷工具栏是否显示（关掉后仍可右键工具栏原位置/设置面板重新开启） */
  toolbarVisible: boolean
  /**
   * 快捷工具栏的项目顺序（只列出**显示**的项目 id，空数组 = 全部隐藏）。
   * 目录、可用项目与清洗规则见 renderer/src/lib/toolbarItems.ts；
   * 未登记在这里的项目不渲染，登记了但目录里没有的 id 会被丢弃（清洗在渲染时进行）。
   */
  toolbarItems: string[]
  sidebarVisible: boolean
  sidebarWidth: number
  /** 大纲放在编辑区右侧（三栏：左文件树 | 中编辑区 | 右大纲）；默认 false = 沿用左栏页签结构 */
  outlineOnRight: boolean
  /** 右侧大纲面板是否展开（仅 outlineOnRight 打开时有意义） */
  outlineRightExpanded: boolean
  /** 右侧大纲面板宽度（px；拖左缘调整，钳在 160~420） */
  outlineRightWidth: number
  splitRatio: number // 分屏对比视图左右宽度比（左面板占比 0.25~0.75）
  syncScroll: boolean // 分屏对比视图左右滚动进度同步
  codeLineNumbers: boolean // 代码块是否显示行号，默认开
  /** 链接指向的文件/文件夹不存在时的处理策略（询问 / 总是创建 / 从不创建） */
  linkCreateMode: LinkCreateMode
  /** 启动时恢复上次会话（文档 + 光标 + 滚动位置）；关闭则每次启动都进欢迎页 */
  restoreSession: boolean
  /** 打开文件时的默认编码（'auto' = 自动检测；见 shared/encodings 与 main/services/encoding） */
  defaultEncoding: EncodingId
  /**
   * 新建/未命名文档的默认行尾（已有文件一律按它自己原本的行尾走，见 shared/eol.ts）。
   * 内存里文本永远是 LF，只有落盘时才展开成 CRLF。
   */
  defaultEol: Eol
  /**
   * 本地历史（保存前快照）：总开关 + 保留策略。
   * 关掉后不再写新快照（已有历史仍可查看/回滚）；抽稀规则见 shared/history.ts 的纯函数。
   */
  historyEnabled: boolean
  /** 每个文件最多保留多少条快照 */
  historyLimitPerFile: number
  /** 超过多少天的快照会被清掉（每个文件仍至少保留最新几条） */
  historyMaxAgeDays: number
  /**
   * 是否自动检查更新（默认关：不打扰用户）。
   * 只有打包版 + publish 配了真实渠道时才会真的去查，开发态一律不查（见 main/services/updater.ts）。
   */
  autoCheckUpdate: boolean
  recentFiles: RecentFile[]
  /** 最近打开过的文件夹（工作区） */
  recentFolders: RecentFolder[]
  pinnedFiles: string[]
  /**
   * 快捷键自定义：命令 id → 按键表达式（如 `Ctrl+Shift+P`）。
   * 只存**用户改过的**那些：值为 `null` 表示「明确解绑」，缺键表示用代码里的默认值。
   * 解析与冲突判定见 renderer/src/lib/keymap/service.ts（SQLite kv 持久化）。
   */
  keybindings: Record<string, string | null>
  export: ExportSettings
}

// ─── 通知中心（窗口私有，SQLite 持久化）────────────────────────────────────
/** 通知级别：通知 / 已完成 / 告警 / 报错。
 *  ⚠️ **界面上不再展示级别**（用户口径：取消图标与级别提示），它只留在数据层：
 *  同 `mergeKey` 合并、跨窗口作用域、以及将来若要恢复分级呈现时的依据。 */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * 通知卡片上的操作按钮。
 * 文案（label）与 title/body 一样是「已本地化的成品文本」并随通知一起持久化——
 * 应用重启后卡片仍能正确显示按钮；点击时按 payload.kind 找渲染层注册的处理器执行，
 * 因此不会出现「按钮还在、逻辑没了」的死按钮。
 */
export interface NotificationAction {
  /** 动作标识（同一条通知内唯一），如 create / cancel */
  id: string
  /** 按钮文案 */
  label: string
  /** 视觉层级：primary 主按钮、ghost 次按钮、danger 危险操作 */
  tone?: 'primary' | 'ghost' | 'danger'
}

/** 可交互通知的负载：kind 决定由哪个处理器接手，其余字段由处理器自行约定 */
export interface NotificationPayload {
  kind: string
  [key: string]: unknown
}

/**
 * 一条通知（持久化在 SQLite notifications 表，跨会话保留）。
 * 通知按「窗口作用域」隔离：它只属于产生它的那个窗口，作用域由主进程按 IPC 发送方
 * 决定，因此不出现在这个 DTO 里（渲染进程既不需要也无法指定）。
 */
export interface AppNotification {
  id: number
  level: NotificationLevel
  /** 标题（一行，必填） */
  title: string
  /** 详情（可空；多行时卡片内滚动） */
  body: string
  /** 卡片上的操作按钮（可空 = 纯消息通知） */
  actions: NotificationAction[]
  /** 操作按钮的负载（与 actions 同时存在） */
  payload: NotificationPayload | null
  createdAt: number
  /** 关闭时间；null = 仍在通知中心里 */
  closedAt: number | null
}

/** 新建通知的入参 */
export interface NotificationInput {
  level?: NotificationLevel
  title: string
  body?: string
  /** 需要用户作答时给出的按钮 */
  actions?: NotificationAction[]
  /** 与 actions 配套的负载 */
  payload?: NotificationPayload
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

/** 最近打开过的文件夹（工作区），驱动「文件 → 最近文件夹」与侧栏列表 */
export interface RecentFolder {
  path: string
  /** 末级目录名（展示用，避免每次 split） */
  name: string
  openedAt: number
}

// ─── 会话恢复（跨重启回到上次的文档与位置）─────────────────────────────────
/**
 * 一个窗口的会话槽位。位置用「PM 文档位置 + 记录时的文档长度 + 滚动比例」三件套
 * 记录，与 EditorView 的视图位置记忆同源：文件被外部改动后，仍能按比例安全落位，
 * 而不是粗暴地跳到一个已经不存在的位置。
 */
export interface SessionSlot {
  /** 该窗口上次打开的文档绝对路径；null = 无文档（未命名缓冲区/仅开着文件夹） */
  path: string | null
  /** 该窗口上次打开的工作区文件夹；无文档但开着文件夹的窗口靠它恢复 */
  folder?: string | null
  /** Tiptap 文档位置（PM pos，取值 1..content.size） */
  pos: number
  /** 记录时的文档长度（同文件内容变化后用于按比例回退） */
  len: number
  /** 滚动进度 0..1（不存 scrollTop：窗口大小/字体/主题变化后绝对值会失真） */
  scrollRatio: number
  /** 最近一次写入时间 */
  savedAt: number
  /**
   * 该窗口是被用户**单独关掉**的（不是随应用整体退出）。
   * 单独关窗不删槽位：用户关窗往往就是「今天先这样」，下次启动要回到刚才那篇文档。
   * 启动时若还有「活着退出」的窗口，就恢复那些、忽略这个标记；一个都不剩时恢复它。
   */
  closed?: boolean
  /** 被单独关掉的时刻（只记最后一个被关掉的窗口，靠它排序） */
  closedAt?: number
}

export interface SessionState {
  /** 按窗口槽位索引存放；null = 空槽（从未用过，或那份「最后关掉的窗口」记录已被更新的记录取代） */
  slots: (SessionSlot | null)[]
}

/**
 * 链接目标分类：
 *  - url      → 网址（http/https/mailto），交系统默认浏览器/邮件客户端；
 *  - file     → 不含量路径分隔符的「文件名」，相对当前文档所在目录，由 Lumin 新窗口打开；
 *  - relative → 含分隔符的相对路径（./a/b.md、../x），交系统默认应用；
 *  - absolute → 绝对路径（C:\a\b、\\server\share、/home/a），交系统默认应用。
 */
export type LinkTargetKind = 'url' | 'file' | 'relative' | 'absolute'

/** 打开方式：系统默认浏览器 / Lumin 新窗口 / 系统默认应用 */
export type LinkOpenAction = 'external' | 'window' | 'default-app'

/** 目标不存在时的策略（持久化在 SQLite settings） */
export type LinkCreateMode = 'ask' | 'always' | 'never'

/** 链接解析结果（纯探测，不产生任何副作用） */
export interface LinkResolveResult {
  /** 归一化后的链接文本（去首尾空白） */
  target: string
  kind: LinkTargetKind
  /** 解析出的绝对路径；kind='url' 时为 null */
  path: string | null
  /** 目标是否已存在；kind='url' 时为 null */
  exists: boolean | null
  /** 已存在时的实体类型 */
  entryType: 'file' | 'directory' | null
  /** 不存在时按链接形态推断的创建类型（尾部分隔符 → 目录，否则文件） */
  createType: 'file' | 'directory' | null
  /** 建议的打开方式 */
  action: LinkOpenAction
  /** 非 null 表示该链接不应被打开，值为原因码（协议不支持 / 空链接 / 缺少基准目录） */
  blocked: 'unsupported-scheme' | 'invalid' | 'missing-base' | 'unsafe-target' | null
}

/** 一次链接打开动作（写入 SQLite link_history） */
export interface LinkActivateRecord {
  target: string
  kind: LinkTargetKind
  path: string | null
  /** declined = 目标不存在且用户放弃创建 */
  action: LinkOpenAction | 'declined'
  /** 该次动作是否伴随「新建文件/文件夹」 */
  created?: boolean
}

/** 链接打开历史（SQLite 持久化，跨会话保留） */
export interface LinkHistoryEntry {
  target: string
  kind: LinkTargetKind
  path: string | null
  action: string
  created: boolean
  count: number
  createdAt: number
  lastUsed: number
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
  /** 实际用于解码的编码（一定不是 'auto'） */
  encoding: ConcreteEncoding
  /** 文件原本是否带 BOM（写回时保持一致） */
  hadBom: boolean
  /** 文件原本的行尾（内存内容已归一为 LF；写回时按它还原） */
  eol: Eol
}

export interface DraftInfo {
  key: string
  path: string | null
  content: string
  savedAt: number
  /**
   * 写这份草稿的**窗口实例**（主进程为每个窗口生成一个，随窗口 argv 传给它的渲染进程）。
   * 会话槽位号会被复用，所以「这一格是不是我自己上次写的那份」只能靠它判断；
   * 同一个窗口 reload 前后 uid 不变（自己那份仍认得出），不同窗口/不同运行则不同。
   * 旧版本写下的草稿没有这个字段。
   */
  ownerUid?: string
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
  /**
   * 文档级元数据（Wave 2 起落库，权威来源；空串 = 尚未记录，按判定链/默认值处理）。
   * 以前编码只活在这一进程的 `current` 上、再配一张 kv 表，两个窗口开同一文件会各说各话。
   */
  encoding: string
  eol: string
  hadBom: boolean
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
  | 'new-window'
  | 'cycle-mode'
  | 'open'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'export-pdf'
  | 'export-html'
  | 'export-word'
  | 'export-epub'
  | 'find'
  | 'replace'
  | 'global-search'
  | 'toggle-sidebar'
  | 'toggle-toolbar'
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
    /** 新建一个空白窗口（干净窗口：不继承当前工作区，空白未命名缓冲区） */
    newWindow: () => void
    /** 在新窗口中打开指定文件 */
    openInNewWindow: (path: string) => void
    /** 在新窗口中把指定文件夹作为工作区打开 */
    openFolderInNewWindow: (path: string) => void
    /**
     * 上报「本窗口当前打开的文档」（null = 未打开文档）。
     * 主进程据此维护「哪个窗口开着哪个文档」，做到「一个文件只开一个窗口」。
     */
    reportWindowDoc: (path: string | null) => void
    /**
     * 该文件若已开在别的窗口 → 把那个窗口唤到前面（必要时从最小化还原）并返回 'focused'；
     * 没有任何窗口开着它则返回 'not-open'，调用方再去建新窗口。
     */
    focusWindowByDoc: (path: string) => Promise<'focused' | 'not-open'>
    /**
     * 应用内快速切换窗口：`delta = +1` 下一个、`-1` 上一个（默认绑定 Ctrl+Tab / Ctrl+Shift+Tab）。
     * 按窗口创建顺序循环；只有一个窗口时不动作。返回被聚焦窗口的 id（无动作则 null）。
     */
    cycleWindow: (delta: number) => Promise<number | null>
    /** 本窗口启动时要求打开的文件路径（由主进程 additionalArguments 传入，通常为 null） */
    startupFile: string | null
    /** 本窗口启动时要求作为工作区打开的文件夹（同上，通常为 null） */
    startupFolder: string | null
    /** 本窗口是「新建窗口」的干净窗口：启动时不继承当前工作区 */
    startupNoWorkspace: boolean
    /** 本窗口的会话槽位索引（主进程分配，用于会话恢复）；null = 本窗口不参与会话 */
    sessionSlot: number | null
  }
  file: {
    /**
     * 读文件。`opts.softDefault` = 这个 encoding 只是「打开文件时的设置默认值」，
     * 该文件已记录的编码（documents.encoding）优先；不传则按显式指定处理（用户刚点的那个必须听）。
     */
    read: (
      path: string,
      encoding?: EncodingId,
      opts?: { softDefault?: boolean }
    ) => Promise<OpenedFile>
    write: (
      path: string,
      content: string,
      encoding?: ConcreteEncoding,
      hadBom?: boolean,
      /** 文档记录的行尾：主进程写盘前展开（内存里的文本永远是 LF，见 shared/eol） */
      eol?: Eol
      /** 写盘后磁盘上的真实 mtimeMs（渲染层用它取代 `Date.now()` 的假值，见 stores/files.save） */
    ) => Promise<{ mtimeMs: number }>
    /** 记住某文件的编码（「选择编码重新打开」用；权威来源是 documents 表，kv 只兜底） */
    rememberEncoding: (path: string, encoding: ConcreteEncoding) => Promise<void>
    readDir: (dir: string) => Promise<FileNode[]>
    /** 递归扫描工作区根目录，返回全部 Markdown 文章（含 mtime 与正文预览） */
    scanWorkspace: (root: string) => Promise<WorkspaceDoc[]>
    createFile: (path: string) => Promise<void>
    createDir: (path: string) => Promise<void>
    /** 删除（优先走系统回收站；`trashed: false` 表示该位置不支持回收站、已永久删除） */
    remove: (path: string) => Promise<{ trashed: boolean }>
    /** 重命名。目标已存在时 rejects（`TARGET_EXISTS`），不会静默覆盖 */
    rename: (oldPath: string, newPath: string) => Promise<void>
    exists: (path: string) => Promise<boolean>
    chooseOpenFile: () => Promise<string | null>
    /**
     * 「保存到哪」对话框。`dir` 是对话框**默认落在的文件夹**：
     *   - 未命名文档 → 传侧栏工作区（Ctrl+N 之后 Ctrl+S 直接存进当前文件夹，不用每次自己找）；
     *   - 已有路径（另存为）→ 传它自己所在的文件夹。
     * 传 null/省略或该目录已不存在时退回「只给文件名」，交给系统记上次的位置。
     */
    chooseSaveFile: (name: string, ext: string, dir?: string | null) => Promise<string | null>
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
    /** 本窗口该用的未命名草稿（自己的；没有则认领一份无主的） */
    untitledDraft: () => Promise<DraftInfo | null>
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
  /** 本地历史（Wave 2 数据安全）：每次写盘前留一份「即将被覆盖」的快照，可查看/回滚 */
  history: {
    list: (path: string, limit?: number) => Promise<HistoryEntryMeta[]>
    get: (id: number) => Promise<HistoryEntry | null>
    clear: (path?: string) => Promise<number>
    stats: () => Promise<{ entries: number; files: number }>
  }
  /**
   * 通知中心（持久化在 SQLite notifications 表，跨会话保留）。
   * 全部方法只作用于「调用方窗口」的通知——作用域由主进程按 IPC 发送方注入，
   * 多窗口下各窗口的通知互不干扰。
   */
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
    /** 用系统默认应用打开文件或文件夹；返回空字符串表示成功，否则为错误信息 */
    openPath: (path: string) => Promise<string>
  }
  /** 会话恢复：按窗口槽位持久化「打开的文档 + 光标 + 滚动」（SQLite kv） */
  session: {
    /** 读取整份会话状态 */
    get: () => Promise<SessionState>
    /** 保存本窗口的槽位；slot 为 null 表示清空该槽位 */
    save: (index: number, slot: SessionSlot | null) => Promise<void>
  }
  /** 链接目标解析 / 创建 / 历史记录（link_history 表，SQLite 持久化） */
  links: {
    /** 解析链接目标（不产生副作用）：分类、绝对路径、是否存在、建议打开方式 */
    resolve: (target: string, baseDir: string | null) => Promise<LinkResolveResult>
    /** 新建文件或文件夹（父目录缺失时一并创建；已存在则拒绝覆盖） */
    create: (path: string, type: 'file' | 'directory') => Promise<{ ok: boolean; error?: string }>
    /** 记录一次链接打开动作（目标维度 upsert + 计数） */
    record: (record: LinkActivateRecord) => Promise<LinkHistoryEntry>
    /** 历史记录（按最近使用倒序） */
    history: (limit?: number) => Promise<LinkHistoryEntry[]>
    /** 删除单条历史 */
    forget: (target: string) => Promise<void>
    /** 清空历史，返回删除条数 */
    clear: () => Promise<number>
  }
  events: {
    on: (channel: string, cb: (payload?: unknown) => void) => () => void
  }
}
