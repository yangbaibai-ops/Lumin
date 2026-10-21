// ─── Lumin 共享类型定义（main / preload / renderer 共用）───────────────────

export type ThemeMode = 'light' | 'dark' | 'sepia' | 'auto'
export type EffectiveTheme = 'light' | 'dark' | 'sepia'
export type EditorMode = 'wysiwyg' | 'source' | 'split'
import type { ConcreteEncoding, EncodingId } from './encodings'
import type { Eol } from './eol'
import type { HistoryEntry, HistoryEntryMeta } from './history'
// 设置文件的读取结果（信封/白名单那一套在 shared/settingsFile.ts；这里只要类型）
import type { SettingsFileReadResult } from './settingsFile'
import type { DocRiskRecord } from './freeze'
import type { NativeCloseChoice, NativeExternalChoice } from './nativeDialogs'
// 打印结果三态 + 失败原因（纯函数模块，见 shared/printOptions.ts）
import type { PrintResult } from './printOptions'
// AI 通道的负载（状态/流式事件/测试连接；类型定义在 shared/ai.ts）
import type {
  AiKeySaveOutcome,
  AiStatus,
  AiStreamEvent,
  AiStreamRequest,
  AiStreamStart,
  AiTestResult
} from './ai'
export type { HistoryEntry, HistoryEntryMeta }
export type { ConcreteEncoding, EncodingId, Eol }
export type Language = 'zh-CN' | 'en-US' | 'ru-RU'

export interface ExportSettings {
  pdf: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
  html: { template: 'default' }
}

export interface AppSettings {
  /**
   * 设置的 schema 版本（口径与迁移表见 `shared/settingsSchema.ts`）。
   * kv 里缺这个字段 = 老数据，读设置时会被归一、补上版本号并写回。
   * **只新增带默认值的设置项不需要动它**；删键/改名/改语义时才 +1 并补一条迁移。
   */
  settingsVersion: number
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
  /**
   * 目标字数（写作目标；**0 = 未设置**，此时状态栏不显示那一格）。
   *
   * 口径：**全局一项设置**，作用于当前打开的任何文档 —— 不按文档分别记。
   * 理由与取舍写在 `shared/readingTime.ts`（按文档记要引入「路径 → 目标」的持久化映射，
   * 那意味着动数据库 schema；而实际用法绝大多数是「今天这篇写到 N 字」）。
   * 进度与达成判定是纯函数 `wordGoalProgress()`，界面只负责显示。
   */
  wordGoal: number
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
  /**
   * 隐藏行内标记字符（`**`/`*`/`~~`/`` ` `` 这些**成对标记**的源码字符）。
   *
   * 默认 `false` = 现在的行为：光标落进构造（或紧贴两端）时按需显形，移出即折叠。
   * 打开后 = **永不显形**（所见即所得里任何情况下都不显示这些标记字符）。
   * 只影响**显示**：标记仍是文档里的真实文本，保存/导出/往返一个字节都不变。
   */
  hideInlineMarkers: boolean
  /**
   * 拼写检查（Electron/Chromium 内置检查器，不引第三方词典）。
   *
   * 开启后正文根节点 `spellcheck="true"`，由 Chromium 画下划线与给建议；代码块（CodeMirror）、
   * mermaid 源码框、公式/图片源码等非自然语言区域显式 `spellcheck="false"`。
   * 主进程在启动与设置变化时调用 `session.setSpellCheckerEnabled`，改完立即生效。
   */
  spellcheckEnabled: boolean
  /**
   * 参与检查的语言代码（如 `en-US`）。**空数组 = 自动**：主进程按界面语言/系统 locale
   * 与常见语言顺序挑一个可用项。可选项永远来自 `availableSpellCheckerLanguages`，
   * 过滤/排序规则见 shared/spellcheck.ts（用户选的项若已不可用会自动降级）。
   *
   * 例外：`zh` 是**我们自己的中文启发式检查层**的伪语言（Chromium 没有中文词典，
   * `availableSpellCheckerLanguages` 不含 zh）。它可以与 en-US 等同时选；主进程只把
   * 非中文项交给 Chromium，渲染层据「总开关 && 含中文」决定是否画中文波浪线。
   */
  spellcheckLanguages: string[]
  /**
   * 「页面无响应提示」总开关（默认开）。
   *
   * 关掉后主进程**不再巡检心跳、也不再弹「页面无响应」原生提示**；崩溃恢复
   * （`render-process-gone` 后自动重载一次、崩溃提示）**不受影响** —— 用户要取消的
   * 是"误报骚扰"，不是丢字保护。
   */
  unresponsivePromptEnabled: boolean
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
  /**
   * 自动备份 SQLite 库到 `backupDir`（默认开：数据安全优先）。
   * 判重与轮换规则见 shared/backup.ts（纯函数，有单测）。
   */
  backupAuto: boolean
  /**
   * 备份目录。null/空 = 用默认的 `<userData>/backups`。
   * 允许指到**别的盘**：和原库同盘时，一次磁盘故障会把两份一起带走。
   */
  backupDir: string | null
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
  /**
   * AI 的 Base URL / 模型名（**不是密钥**）。
   * 这两项是普通设置（会进设置导出）；API Key 单独用 safeStorage 加密后存 kv 的
   * `aiApiKey`，永远不进设置对象、不进导出文件、不透出到渲染层。
   */
  aiBaseUrl: string
  aiModel: string
  /**
   * 对话面板的**默认上下文**：打开/新对话时预先勾选哪一项。
   * 默认 `'selection'` = 只附选区、不附全文（用户口径）。
   */
  aiContextDefault: 'selection' | 'document'
  /**
   * 是否要求服务端流式返回（SSE）。默认开。
   * 关掉后请求用 `stream:false` 一次性返回，界面仍按"一段返回"呈现；
   * 少数只实现普通 JSON completion 的兼容服务需要这个开关。
   */
  aiStream: boolean
}

// ─── 通知中心（窗口私有，SQLite 持久化）────────────────────────────────────
/** 通知级别：通知 / 已完成 / 告警 / 报错。
 *  ⚠️ **界面上不再展示级别**（用户口径：取消图标与级别提示），它只留在数据层：
 *  同 `mergeKey` 合并、跨窗口作用域、以及将来若要恢复分级呈现时的依据。 */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * 工作区全文索引的进度（`workspace:indexStatus`）。
 * 索引是**后台**行为：打开工作区后自动跑，把从未打开过的文档也收进搜索。
 */
export interface IndexStatus {
  /** 正在索引的根（null = 空闲） */
  root: string | null
  /** 本次看过多少篇（含跳过的） */
  scanned: number
  /** 本次真正写进索引多少篇 */
  indexed: number
  running: boolean
}
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

// ─── 最近打开的文件 / 文件夹（侧栏「最近」页）──────────────────────────────
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

/** 文件列表视图（极简侧边栏「列表」）：工作区 Markdown 文章的扁平条目 */
export interface WorkspaceDoc {
  name: string
  /** 相对工作区根目录的路径（分隔符统一为 /），根级为空串 */
  relPath: string
  path: string
  mtimeMs: number
  /** 正文头部预览（去除 Markdown 符号后的一段纯文本） */
  preview: string
  /**
   * 标签（来自 `documents.tags`，SQLite 持久化）。
   * 唯一编辑入口在状态栏那一格（`statusbar.tags`）；列表视图按它过滤与展示。
   */
  tags: string[]
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
  /**
   * 解码时出现过替换字符（`U+FFFD`）—— 有字节没解出来（或原文含它）。
   * 界面据此提示"这次打开→保存不会字节相等"，见 shared/encodingMemory.ts。
   */
  hadReplacement: boolean
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

/**
 * 跨文件（工作区级）替换的请求（`workspace:replaceAll`）。
 * 匹配口径与单文档查找/替换**完全一致**（同一份实现，见 shared/findReplace.ts）：
 * 默认按字面量、正则要显式开、大小写可开关。
 */
export interface WorkspaceReplaceRequest {
  query: string
  replacement: string
  caseSensitive?: boolean
  regex?: boolean
  /**
   * 本窗口里**已打开且有未保存修改**的文档：绝不写盘。
   * 脏标记只有渲染层知道（主进程只见过"哪个窗口开着哪个文档"，见 services/openDocs），
   * 所以由调用方带过来 —— 漏传的后果是把用户正在编辑的缓冲区从磁盘上换掉。
   */
  dirtyPaths?: string[]
}

/**
 * 跨文件替换的结果。
 *
 * `files`/`occurrences` 是**计划**数（干跑时就是"将会影响多少"），
 * `written`/`writtenOccurrences` 是**真的落盘成功**的数 —— 两者分开是为了让
 * 「部分成功」能被如实说出来（3 个成功、2 个失败 + 逐个原因），而不是拿计划数冒充结果。
 */
export interface WorkspaceReplaceResult {
  /** 请求不可执行的原因（null = 执行了；此时什么都没动）。no-workspace = 还没打开工作区 */
  invalid: 'empty-query' | 'invalid-regex' | 'no-workspace' | null
  /** 会被改写的文件数（计划） */
  files: number
  /** 会被替换的处数（计划） */
  occurrences: number
  /** 真正写盘成功的文件数（干跑恒为 0） */
  written: number
  /** 真正写盘成功的处数（干跑恒为 0） */
  writtenOccurrences: number
  /** 因「有未保存修改」被跳过的文档 */
  skippedDirty: string[]
  /** 因「不是 Markdown/纯文本」被跳过的文档 */
  skippedUnsupported: string[]
  /** 逐个失败的文档与原因 */
  failures: { path: string; reason: string }[]
  /** 这次调用是否真的落了盘（false = 预览） */
  applied: boolean
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

// ─── 备份（审计 §2 P1：此前没有任何自动备份 / 工作区级导出）─────────────────
/** 备份目录里的一份库备份 */
export interface BackupFileInfo {
  name: string
  size: number
  mtimeMs: number
}

/** 备份现状（设置界面据此显示目录、份数与上次时间） */
export interface BackupStatus {
  /** 当前生效的备份目录 */
  dir: string
  /** 是否用的默认目录（`<userData>/backups`）—— 默认目录和原库同盘，界面上会提示换盘 */
  isDefaultDir: boolean
  auto: boolean
  keep: number
  /** 最近一次成功备份的时刻；null = 从来没有过 */
  lastMs: number | null
  files: BackupFileInfo[]
}

/** 一次库备份的结果（失败也返回对象，由界面提示原因） */
export interface BackupResult {
  ok: boolean
  /** 写出的备份文件；失败时为 null */
  path: string | null
  bytes: number
  dir: string
  kept: number
  removed: number
  error?: string
  /** auto = 启动/定时触发，manual = 用户点按钮 */
  kind: 'auto' | 'manual'
}

/** 工作区快照里被跳过的条目统计（跳过了多少要如实告诉用户） */
export interface SnapshotSkipped {
  /** 隐藏目录与点文件 */
  hidden: number
  /** 写盘临时文件（`*.lumin-tmp`） */
  temp: number
  /** 单个超过上限的大文件 */
  huge: number
  /** 总量到顶之后剩下的文件 */
  overflow: number
}

/** 工作区快照结果 */
export interface SnapshotResult {
  path: string
  files: number
  bytes: number
  zipBytes: number
  skipped: SnapshotSkipped
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
  // 打印**不是**导出格式（不落盘），所以它是导出四条之外的一条独立动作
  | 'print'
  | 'find'
  | 'replace'
  | 'global-search'
  | 'toggle-sidebar'
  | 'toggle-toolbar'
  // 大纲位置（左侧边栏 ⇄ 编辑区右侧）：三条入口共用同一条命令 ——
  // 原生菜单 / 快捷键走 IPC 到这里，应用内「视图」菜单与工具栏直接调同一个 composable
  | 'outline-side'
  | 'mode-wysiwyg'
  | 'mode-source'
  | 'mode-split'
  | 'toggle-focus'
  | 'toggle-typewriter'
  | 'settings'
  | 'about'
  /** 粘贴为纯文本（Ctrl+Shift+V）：不走富文本/表格/公式解析，永远只插纯文本 */
  | 'paste-plain'
  /** 「导出启动诊断」（帮助菜单 / 状态栏 / 设置页共用）：写一份脱敏的启动日志合集 */
  | 'export-startup-diagnostics'
  /** AI 摘要（全文或选区）：只**生成预览**，不自动改文档 */
  | 'ai-summarize'
  /** AI 改写（必须先有选区）：先出 diff 预览，用户确认后才单事务替换 */
  | 'ai-rewrite'
  /** AI 对话：切到右侧栏的 AI 标签页（没有右侧栏时先打开三栏布局） */
  | 'ai-chat'

export interface LuminAPI {
  app: {
    getVersion: () => Promise<string>
    getPlatform: () => Promise<string>
    /**
     * 「关于」页的事实来源：真实依赖清单 + 第三方许可声明全文
     * （都从构建产物里读，见 main/ipc.ts 的 `app:getAbout`）。
     */
    getAbout: () => Promise<{
      version: string
      platform: string
      deps: { name: string; version: string }[]
      notices: string | null
    }>
    confirmClose: () => Promise<void>
    /**
     * 关窗确认里点了「取消」：撤掉主进程这一轮的兜底守卫，窗口继续活着。
     * 不撤的话兜底计时器照跑（连续 2.5s 没心跳 = 强关；30s 总上限 = 强关），
     * 用户点了取消却看着窗口关掉。见 main/ipc.ts 的 `app:cancelClose`。
     */
    cancelClose: () => void
    /**
     * 关窗流程中的心跳：主进程据此把兜底时限往后推（慢盘/大文件下别强杀正在落盘的窗口）。
     * `deciding: true` = 正等用户回答「是否保存更改？」——这一段等待不计入 30 秒总上限
     * （用户想多久都合法；渲染进程真卡死仍由"心跳停了 2.5 秒"兜底）。
     * 见 shared/closeGuard.ts 与 main/ipc.ts 的 attachCloseGuard。
     */
    closeProgress: (opts?: { deciding?: boolean }) => void
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    /** 退出应用（走 app.quit()；每个窗口的关窗守卫照常询问保存） */
    quit: () => void
    /** 手动检查更新：返回是否真的发起了检查（开发态/未配置渠道为 false） */
    checkUpdate: () => Promise<{ ok: boolean }>
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
    /**
     * 启动窗口标记：槽位**延迟分配**（窗口先建、库后开）。
     * true 时 `sessionSlot` 为 null，渲染层要先 `await claimStartupSlot()` 拿槽位。
     */
    startupRestoreHead: boolean
    /**
     * 启动验收用的人为慢渲染延迟（ms）：主进程 `LUMIN_BOOT_DELAY_MS` → argv → 这里。
     * 默认 0（产品路径恒为 0）；渲染层在 bootstrap 最前面 await 这么久，用来验证骨架
     * 在「JS 迟迟挂不上」时仍然可见。兜底移除时限会同步延长这个值。
     */
    bootDelayMs: number
    /**
     * 启动窗口认领会话槽位（幂等）：恢复计划的 head 槽位，或一个全新的槽位。
     * 非启动窗口 / 已认领过都返回当前槽位（不会重复分配）。
     */
    claimStartupSlot: () => Promise<number | null>
    /** 日志路径（状态栏/关于展示；主进程算好，不含参数） */
    getLogPaths: () => Promise<{ dir: string; app: string; startup: string }>
    /**
     * 诊断信息（纯文本，可直接贴进 issue）：版本 / 平台 / 数据位置 / 启动参数 /
     * 设置快照 / 最近的错误标题。**不含文档内容，也不含最近打开的文件清单**。
     */
    getDiagnostics: () => Promise<string>
    /**
     * 「导出启动诊断」：把 `<userData>/logs/startup.log`（含轮转的上一代）与环境摘要
     * 另存成一个文件。返回落点/行数/字节数，用户可把它发给开发者。
     * 内容只含分段耗时与环境事实 —— 没有文档内容，也没有完整个人路径。
     */
    exportStartupDiagnostics: () => Promise<
      | { ok: true; path: string; lines: number; bytes: number }
      | { ok: false; canceled?: boolean; error?: string }
    >
    /**
     * 渲染层启动打点上报（单向）：首屏可交互/壳出帧等时刻。
     * 主进程只接受 stage 名与数字 marks（见 shared/startupLog 的清洗），不落任何文本。
     */
    reportStartup: (payload: { stage: string; marks?: Record<string, number> }) => void
    /** 打开日志目录（`%TEMP%`）：不接受参数，固定打开我们自己的目录 */
    openLogDir: () => Promise<string>
    /**
     * 打开**本窗口**的开发者工具（顶部工具栏那项「打开开发者工具」）。
     * `mode: 'detach'` 独立窗口，不挤坏文档布局；返回值可观测（工具栏套件据此断言）。
     */
    openDevTools: () => Promise<{ ok: boolean; alreadyOpen?: boolean; error?: string }>
    /** 关闭本窗口的开发者工具（同一项的收起动作；返回它此前是否开着） */
    closeDevTools: () => Promise<{ ok: boolean; wasOpen?: boolean; error?: string }>
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
      eol?: Eol,
      /**
       * 我们上次读/写这份文件时的真实 mtime。主进程写之前会 stat 比对：
       * 不一致 ⇒ 有别的程序改过它 ⇒ **不写**，回报 `conflict: true`（外部改动检测，审计 §2 P1）。
       * 传 null/省略 = 不做这层检查（导出、新建空文件这类"就是要写"的场景）。
       */
      expectMtimeMs?: number | null
    ) => Promise<{
      /** 磁盘上的真实 mtimeMs（渲染层用它取代 `Date.now()` 的假值，见 stores/files.save） */
      mtimeMs: number
      /** true = 检测到外部改动、**这次没有写入**（磁盘当前 mtime 在 mtimeMs 里） */
      conflict?: boolean
      /**
       * true = 当前编码表示不了正文里的某些字符（decode→encode 往返对不上），
       * 这次写盘把它们换成了 `?`。界面据此提示"改用 UTF-8 再存"。
       */
      lossy?: boolean
    }>
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
    /**
     * 这个路径是不是目录（不存在 / 读不到 stat → false）。
     * 「把系统里的东西拖进窗口」要靠它分流：文件 → 打开文件，目录 → 打开文件夹（设为工作区根）。
     * 不能用扩展名猜（`素材.md` 这种目录名会翻车）。
     */
    isDirectory: (path: string) => Promise<boolean>
    /**
     * 两个路径是不是**同一个位置**：大小写、正反斜杠、末尾分隔符、`.`/`..`，
     * 以及符号链接 / junction / 8.3 短名（`YANGBA~1`，资源管理器拖进来给的就是这种）
     * 都归一到一处比较。判据是主进程的纯函数 `pathGuard.sameResolvedPath`
     * （`path.win32.resolve` + 大小写折叠）加一次 `fs.realpath` 兜底 ——
     * **渲染层不要手搓字符串比较**（判据只有一份）。任一侧未授权时 rejects。
     */
    isSamePath: (a: string, b: string) => Promise<boolean>
    /**
     * 只要 mtime（文件不存在 → null）。渲染层用它判断"同一个文件自上次打开后有没有被外部改过"：
     * `file:read` 会把整篇正文搬过来（还要解码 + 建索引），而这个判断只需要一个时间戳
     * （见 stores/files.ts 的 openPath 短路判据）。文件不存在返回 null。
     */
    mtime: (path: string) => Promise<number | null>
    /**
     * 申报本窗口**当前打开的文档**，交给主进程做外部改动监测（第一百零八轮）。
     * `path = null` = 未命名文档/已关闭 ⇒ 停掉监测；`mtimeMs` = 起始基线
     * （不传会让"刚打开"看起来就是一次变化 ⇒ 立刻误报）。
     */
    watchDocument: (path: string | null, mtimeMs?: number) => Promise<boolean>
    chooseOpenFile: () => Promise<string | null>
    /**
     * 「保存到哪」对话框。`dir` 是对话框**默认落在的文件夹**：
     *   - 未命名文档 → 传侧栏工作区（Ctrl+N 之后 Ctrl+S 直接存进当前文件夹，不用每次自己找）；
     *   - 已有路径（另存为）→ 传它自己所在的文件夹。
     * 传 null/省略或该目录已不存在时退回「只给文件名」，交给系统记上次的位置。
     */
    chooseSaveFile: (name: string, ext: string, dir?: string | null) => Promise<string | null>
    chooseFolder: () => Promise<string | null>
    /**
     * 写**二进制**（粘贴进编辑器的图片）：文本通道 `write` 会做编码/行尾处理，
     * 拿它写 PNG 必然坏，所以单开一条。授权闸与文本写一致。
     */
    writeBinary: (path: string, bytes: Uint8Array) => Promise<void>
    /**
     * 把一张外部图片复制进目标目录（拖入 / 「选择文件…」）：
     * 名字冲突自动编号、绝不覆盖，返回写入后的**绝对路径**。
     */
    importImage: (source: string, dir: string, baseName: string) => Promise<string>
    /** 「选择文件…」：原生对话框选一张图片（选中的路径登记读写授权） */
    chooseImage: () => Promise<string | null>
    getPathForFile: (file: File) => string | null
    /**
     * 把「用户拖进窗口的文件」登记为只读授权（拖放路径主进程看不到，必须由渲染层申请一次）。
     * 返回 false = 该路径不存在或不可用。口径见主进程 services/pathGrants。
     */
    authorizeUserPath: (path: string) => Promise<boolean>
    fileUrl: (path: string) => Promise<string>
    dirname: (path: string) => Promise<string>
    join: (dir: string, name: string) => Promise<string>
    basename: (path: string) => Promise<string>
  }
  settings: {
    getAll: () => Promise<AppSettings>
    update: (partial: Partial<AppSettings>) => Promise<AppSettings>
    /**
     * 导出设置（含自定义快捷键）到用户选定的文件；`null` = 取消。
     * 信封组装、隐私字段剔除都在 `shared/settingsFile.ts`（纯函数、有单测）。
     */
    exportFile: (settings: AppSettings) => Promise<string | null>
    /**
     * 选一个设置文件并把**原始文本**读回来（`null` = 取消）。
     * 校验/归一在渲染层走 `shared/settingsFile.ts` —— 主进程不在用户确认之前落库。
     */
    importFile: () => Promise<SettingsFileReadResult | null>
    /**
     * 应用导入的补丁（**整体替换**语义，不是 `update` 的深合并；理由见 main/ipc.ts）。
     * 返回归一后的完整设置，渲染层直接 `$patch` 即可让界面立刻生效。
     */
    applyImport: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  /**
   * 拼写检查（Electron/Chromium 内置检查器）。
   * 开关与语言是设置项（`settings.update` 会让主进程立即同步 session）；
   * 这里只有「问状态 / 添加到词典 / 忽略」三个动作。
   * 右键建议由主进程的 `spell:context` 事件下发，不经过 IPC invoke。
   */
  spell: {
    /** 当前生效状态 + 系统实际提供的语言清单（原值，不排序） */
    getState: () => Promise<{ enabled: boolean; languages: string[]; available: string[] }>
    /** 写入 Chromium 用户词典（持久化；成功返回 true） */
    addWord: (word: string) => Promise<boolean>
    /** 本会话内忽略（不改变系统词典；下划线仍由 Chromium 绘制） */
    ignoreWord: (word: string) => Promise<boolean>
  }
  /**
   * AI（摘要 / 选区改写）——**渲染层拿不到 Key**。
   *
   * 这里只有五个动作：问状态、写 Key、测试连接、开流、取消。
   * 生成结果通过 `events.on('ai:event')` 逐段推送；渲染层不直接 fetch（网络只在主进程）。
   */
  ai: {
    /** 只回 `{ hasKey, model, baseUrl }`，没有明文/密文 Key */
    status: () => Promise<AiStatus>
    /** 保存 Key（空串 = 清除）；失败原因只有 empty-key / key-unavailable */
    setKey: (key: string) => Promise<AiKeySaveOutcome>
    /** 测试连接（/models，服务端不支持时回退一次极小 completion） */
    test: () => Promise<AiTestResult>
    /** 开一个流：立刻返回 requestId / 截断统计，delta 走 ai:event */
    stream: (req: AiStreamRequest) => Promise<AiStreamStart>
    /** 取消某个请求（只对发起窗口有效） */
    abort: (requestId: string) => Promise<boolean>
    /** 订阅流式事件（preload 白名单通道 `ai:event`；返回取消函数） */
    onEvent: (fn: (event: AiStreamEvent) => void) => () => void
  }
  workspace: {
    getRoot: () => Promise<string | null>
    setRoot: (path: string | null) => Promise<void>
    /** 全文索引进度：`running` + `scanned/indexed`（从未打开过的文档也在后台被收进搜索） */
    indexStatus: () => Promise<IndexStatus>
    /** 手动重建索引（换机器 / 库被清过 / 怀疑索引不全时用） */
    reindex: () => Promise<IndexStatus>
    /**
     * 跨文件（工作区级）替换：把当前查询在**已索引的工作区文档**里替换掉。
     * `dryRun=true` 只统计「会影响 N 个文件 / M 处」而不落盘（确认框靠它）。
     * 写盘走 `fileOps.writeFile` 的原子写；跳过有未保存修改的文档、非 Markdown 文件，
     * 失败的逐个报告（见 WorkspaceReplaceResult）。
     */
    replaceAll: (req: WorkspaceReplaceRequest, dryRun?: boolean) => Promise<WorkspaceReplaceResult>
    /** 订阅索引进度；返回取消订阅的函数 */
    onIndexProgress: (fn: (s: IndexStatus) => void) => () => void
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
    /** 数据库维护：完整性检查（`PRAGMA integrity_check`） */
    integrityCheck: () => Promise<{ ok: boolean; detail: string }>
    /** 数据库维护：按 `documents` 全量重建 FTS 索引（库损坏 / 索引不一致时的修复路径） */
    rebuildIndex: () => Promise<{ rebuilt: number }>
    /** 数据库维护：`VACUUM`（把删掉的行还给文件系统）；返回压缩前/后字节数 */
    vacuum: () => Promise<{ before: number; after: number; saved: number }>
  }
  /** 本地历史（Wave 2 数据安全）：每次写盘前留一份「即将被覆盖」的快照，可查看/回滚 */
  history: {
    list: (path: string, limit?: number) => Promise<HistoryEntryMeta[]>
    get: (id: number) => Promise<HistoryEntry | null>
    clear: (path?: string) => Promise<number>
    stats: () => Promise<{ entries: number; files: number; bytes: number }>
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
  export: {
    pdf: (payload: ExportPayload, settings: AppSettings['export']['pdf']) => Promise<string | null>
    html: (payload: ExportPayload) => Promise<string | null>
    word: (payload: ExportPayload) => Promise<string | null>
    epub: (meta: EpubMeta) => Promise<string | null>
  }
  /**
   * 真打印机打印（审计 §7 第 18 条：此前 `webContents.print(` 全仓 0 命中）。
   *
   * **不是导出格式**：不落盘、没有输出路径 —— 所以它不在 `shared/exportFormats`
   * 那份「导出格式唯一清单」里。排版与 PDF 导出**同源**（主进程复用同一段
   * buildHtml + 同一个隐藏窗口渲染流程），第二个参数因此就是设置里的 PDF 页面设置。
   *
   * 返回值恒为一个对象（**不抛**）：`ok` 已交给打印机 / `cancelled` 用户在系统打印
   * 对话框里取消（**正常路径**，不是错误）/ `failed` + Chromium 的 `failureReason`。
   */
  print: {
    document: (
      payload: ExportPayload,
      settings: AppSettings['export']['pdf']
    ) => Promise<PrintResult>
    /**
     * 打印预览（第十一轮）：先按**与 PDF 导出同一段流水**生成 PDF，写进临时目录，
     * 再在应用内的预览窗口里用 Chromium 内置 PDF 查看器显示（不引 CDN、不发网络请求）。
     *
     * 返回 `pages`（预览要显示"共 N 页"，验收也用它对齐）与 `pdfPath`（验收核对"预览的
     * 确实是这份 PDF"）。失败时 `ok: false` + 可读原因（主进程绝不抛给渲染层）。
     */
    preview: (
      payload: ExportPayload,
      settings: AppSettings['export']['pdf']
    ) => Promise<
      | { ok: true; id: string; pages: number; bytes: number; pdfPath: string }
      | { ok: false; error: string }
    >
  }
  /**
   * 备份（审计 §2 P1）：定时把 SQLite 库复制到用户指定目录 + 按需导出工作区快照 zip。
   * 库文件本身就是完整的一份（历史、标签、设置全在里面），所以"备份"= 复制文件。
   */
  backup: {
    /** 现状：目录、份数、上次时间、是否自动 */
    status: () => Promise<BackupStatus>
    /** 立刻备份一次（失败也在返回值里，不 reject） */
    run: () => Promise<BackupResult>
    /** 选一个备份目录并选中它（取消返回当前状态，dir 不变） */
    chooseDir: () => Promise<BackupStatus>
    /** 退回默认目录（`<userData>/backups`） */
    useDefaultDir: () => Promise<BackupStatus>
    /** 在文件管理器里打开备份目录；返回空字符串表示成功 */
    revealDir: () => Promise<string>
    /** 把当前工作区打成 zip（走另存为对话框；取消返回 null） */
    snapshotWorkspace: () => Promise<SnapshotResult | null>
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
  /**
   * 原生确认对话框（主进程 `dialog.showMessageBox(win, …)`）。
   *
   * 目前两条：关闭未保存文件（保存/不保存/取消）、外部修改（重新加载/稍后）。
   * 渲染层只传"是哪一种"，文案由主进程语言包取；按钮下标 → 语义的映射在
   * shared/nativeDialogs.ts（纯函数，单测）。
   */
  dialog: {
    confirmClose: () => Promise<NativeCloseChoice>
    externalChange: () => Promise<NativeExternalChoice>
  }
  /**
   * 全局防卡死兜底（主进程判活；渲染层只发心跳与读诊断）。
   *
   * 心跳是**单向小消息**（500ms 一条，只带 `__LWORK` 计数摘要，绝不含正文）。
   * 无响应/崩溃的提示与重载都在主进程（见 main/services/freezeGuard.ts）：
   * 渲染进程卡死时它自己发不出任何请求，所以不能把判活放在这一侧。
   */
  freeze: {
    /** 发一次心跳（fire-and-forget；主进程据此判 5s 超时） */
    heartbeat: (payload: {
      at?: number
      rafFramesIn500ms?: number
      visible?: boolean
      work?: {
        runs?: number
        overruns?: number
        lastMs?: number
        lastName?: string
        longTasks?: number
        lastLongMs?: number
        freezes?: number
        lastFreezeMs?: number
      }
    }) => void
    /**
     * 页面隐藏（`document.visibilitychange`）⇒ 主进程暂停巡检与弹框。
     * 窗口最小化/被遮挡时 Chromium 会停定时器，心跳停了不是卡死。
     */
    pause: () => void
    /** 页面重新可见 ⇒ 主进程复位 lastBeat 后再恢复巡检（恢复瞬间绝不弹框） */
    resume: () => void
    /** 重载前的草稿落盘回执（主进程最多等 1.2s，等不到就依赖自动草稿） */
    draftAck: () => void
    /** 本窗口的只读诊断快照（心跳次数/检测延迟/重载记录/崩溃记录） */
    state: () => Promise<Record<string, unknown> | null>
    /** 按文档路径读取「连续崩溃/无响应」风险（下次打开默认源码模式的依据） */
    docRisk: (path: string) => Promise<DocRiskRecord | null>
    /** 用户明确选择「仍然以富文本打开」/ 文档已恢复正常：清零风险 */
    clearDocRisk: (path: string) => Promise<void>
    /**
     * 读剪贴板的纯文本（主进程 `clipboard.readText`）。
     * 页面失焦时 `navigator.clipboard.readText()` 会 reject，而自救入口不该"点了没反应"。
     */
    clipboardText: () => Promise<string>
  }
  events: {
    on: (channel: string, cb: (payload?: unknown) => void) => () => void
  }
}
