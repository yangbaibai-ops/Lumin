import type { AppSettings } from './types'
// 显式 .ts：defaults 会被 tests/*.test.mjs 直接加载，而 Node 的 ESM 解析不做扩展名补全（见 §4.56）
import { HISTORY_LIMIT_PER_FILE, HISTORY_MAX_AGE_MS } from './history.ts'
// AI 默认端点/模型（与设置界面预设共用一份，避免"两处默认值"漂移）
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL } from './ai.ts'
import { DEFAULT_TOOLBAR_ITEMS } from './toolbarItems.ts'
import { SETTINGS_SCHEMA_VERSION } from './settingsSchema.ts'

export const FONT_OPTIONS: { value: string; label: string }[] = [
  {
    value:
      "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    label: 'sans'
  },
  {
    value: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', 'Noto Serif SC', serif",
    label: 'serif'
  },
  {
    value: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace",
    label: 'mono'
  }
]

export const defaultSettings: AppSettings = {
  /** 当前 schema 版本（审计 §6 P2）：改设置项的形状/语义时才 +1，见 shared/settingsSchema.ts */
  settingsVersion: SETTINGS_SCHEMA_VERSION,
  theme: 'auto',
  language: 'zh-CN',
  /**
   * 自动保存：**出厂改为「手动保存」**（用户口径）。
   *
   * 为什么默认关：写作工具的默认行为应当尊重作者的节奏 —— 自动保存会在你还没写完一句时
   * 就把半成品写进磁盘（外部同步盘/版本工具会看到一串中间态）。手动保存下仍有**崩溃保护**：
   * 关窗/异常退出时仍会写草稿（`drafts` 那套与 `autoSave` 无关），所以「手动」不等于「丢字」。
   * 已存在的用户设置不受影响（它落在 kv 里，只有全新 profile 才拿到这个默认值）。
   * 想在状态栏切回来：点状态栏最左那格（保存状态），弹层里选「自动保存」。
   */
  autoSave: false,
  autoSaveInterval: 3,
  nativeMenuBar: true,
  fontSize: 17,
  lineHeight: 1.9,
  fontFamily: FONT_OPTIONS[0].value,
  editorMode: 'wysiwyg',
  /**
   * 目标字数：**默认 0 = 未设置**（状态栏那一格只在你真的设了目标时才出现）。
   *
   * 取舍（为什么是「全局一项」而不是「按当前文档」）：按文档记要引入「路径 → 目标」的
   * 持久化映射 —— 要么在 kv 里再养一张表、要么给 `documents` 加一列（= 改数据库 schema），
   * 而这个词的实际用法绝大多数是「今天这篇写到 N 字」这种一次性的会话目标。
   * 一个全局数字最简单、也最不容易出现「这篇的目标悄悄跟到那篇」的错位；
   * 真需要按篇目标时再升级成文档级元数据，那时一次到位比现在猜要稳。
   * 详情见 shared/readingTime.ts 的模块说明。
   */
  wordGoal: 0,
  /**
   * 快捷工具栏：**默认不显示**（清单 §1.E 的取舍，选项 ②）。
   *
   * 为什么改成默认收起：本产品的定位是「纸面优先」的写作工具，最显眼的那条 44px 常驻 chrome
   * 恰恰压在正文上方；而它承载的动作**三处重复**（快捷工具栏 / 编辑器右键菜单 / 顶部菜单栏），
   * 所以收起来不会丢功能。三条重新打开的入口都在：视图 → 显示快捷工具栏（应用内 + 原生菜单
   * `toggle-toolbar`）、设置 → 编辑器 → 快捷工具栏、以及工具栏空白区右键（栏在时才可见）。
   * 已存在的用户设置不受影响（它落在 kv 里，只有全新 profile 才拿到这个默认值）。
   */
  toolbarVisible: false,
  toolbarItems: [...DEFAULT_TOOLBAR_ITEMS],
  /**
   * 远程图片（`![](https://…)`）的加载策略（自查报告 H2）：
   *   `'always'`（**第七十七轮起默认**）＝ 打开文档就直接加载，与主流编辑器一致
   *                （用户实测口径：主流编辑器打开就能看到图，占位框让人以为"什么都没有"）；
   *   `'click'`  ＝ 先挡成占位、点一下才加载 —— 想要"隐私优先、不点不外联"的用户在设置里选它。
   * 两条分支都保留（实现见 `src/renderer/src/lib/remoteImages.ts`）；
   * 导出 HTML 用的是真实 src，不受此设置影响。
   */
  remoteImages: 'always' as 'click' | 'always',
  sidebarVisible: true,
  sidebarWidth: 264,
  /**
   * 大纲放在**编辑区右侧**（三栏：左文件树 | 中编辑区 | 右大纲）。
   *
   * 默认 **false = 左栏保留「文件 / 大纲」页签**（用户口径：默认结构不变）。
   * 打开后左栏只留文件树；右侧大纲本身住在常驻停靠栏里（`rightDockVisible`），
   * 所以这里只决定**左栏是否还提供大纲页签**，不再决定右侧面板是否存在。
   */
  outlineOnRight: false,
  /**
   * 显示右侧停靠栏（默认开）。
   *
   * 这是一条常驻的 40px 竖向窄条，上面只有大纲 / AI 两个按钮；点按钮在它左侧展开
   * 对应面板，再点收起 —— 停靠栏本身不随面板收起而消失。关掉此开关时停靠栏与面板
   * 一起隐藏，编辑区占满宽度；重新打开会恢复上次选中的面板与展开状态。
   */
  rightDockVisible: true,
  /** 停靠栏上次选中的面板（收起面板不清除；重启后仍回到它） */
  rightDockActive: 'outline' as 'outline' | 'ai',
  /** 右侧面板是否展开（停靠栏常驻；默认展开，点按钮可收起） */
  outlineRightExpanded: true,
  /** 右侧面板宽度（px，可拖左缘调整；钳在 160~420） */
  outlineRightWidth: 220,
  splitRatio: 0.5,
  syncScroll: false,
  codeLineNumbers: true,
  /**
   * 隐藏行内标记字符（用户口径，第二十八轮）：默认 **`false` = 照旧显示**。
   *
   * 用户原话是「设置内容是是否显示例如加粗 `**` 这样的字符，**默认开启（按钮显示关闭）**，
   * 用户开启后不展示这样类似的字符」—— 这里取「默认显示、开关打开才隐藏」这一读法：
   *   * 「按钮显示关闭」与「默认开启」两句只有按「默认 = 现状（显示标记）」才自洽；
   *   * 反过来（默认隐藏）会让所有老用户升级后突然看不到 `**`，与「默认使用当前的结构，
   *     不用用户没要求的改变」这条既有口径冲突（见 tests/settingsDefaults.test.mjs）。
   * 所以设置项名是「**隐藏**行内标记字符」，语义只有一条：打开 ⇒ 所见即所得里**永不显形**。
   *
   * 只影响显示层（`inlineMarks` 的显隐装饰）：标记仍是文档里的真实文本，
   * 保存/导出/往返字节不变；字面量标记（未配对/切段残留的 `*`，`data-side='literal'`）与
   * 转义反斜杠（`\*`，见 MdEscape 的说明）**不在**这个开关的口径里（前者是用户正文、
   * 藏起来等于丢字符；后者的折叠/拆分是同一条渲染结构，要一起改得单独设计）。
   */
  hideInlineMarkers: false,
  /**
   * 拼写检查：出厂**开启**（正文 `spellcheck="true"`），语言留空 = 自动。
   *
   * 为什么默认开：这正是本轮用户要的能力，默认关掉会让"装了却看不到"；而中文/日文
   * 没有 Chromium 词典，永远不会被标错 —— 对中文用户来说它只在夹带英文单词时出现，
   * 不会满屏红波浪线（代码块/mermaid 等已分别排除）。不想要的人一个开关即可关掉。
   * 语言不写死：空数组交给主进程从 `availableSpellCheckerLanguages` 里挑
   * （优先界面语言 → en-US → 常见语言 → 第一个可用项，见 shared/spellcheck.ts）。
   */
  spellcheckEnabled: true,
  spellcheckLanguages: [],
  /**
   * 「页面无响应提示」：默认**开**（真实卡死时仍要提示），但窗口最小化/隐藏/系统休眠时
   * 主进程门控会暂停巡检与弹框。用户若仍觉得打扰，可在设置里关掉（后台的崩溃恢复保留）。
   */
  unresponsivePromptEnabled: true,
  linkCreateMode: 'ask',
  restoreSession: true,
  /** 打开文件时的默认编码：auto = 走判定链（BOM → 每文件记忆 → 严格 UTF-8 → 系统语言兜底） */
  defaultEncoding: 'auto',
  /** 新建/未命名文档的默认行尾：内存里一律 LF，落盘时按它展开（已有文件按自己原本的行尾走） */
  defaultEol: 'lf',
  /** 本地历史：默认开（数据安全优先），保留 30 条 / 30 天（策略见 shared/history.ts） */
  historyEnabled: true,
  historyLimitPerFile: HISTORY_LIMIT_PER_FILE,
  historyMaxAgeDays: HISTORY_MAX_AGE_MS / (24 * 60 * 60 * 1000),
  // 自动检查更新：默认关 —— 用户没要求就别联网，也别让通知中心多出无意义卡片
  autoCheckUpdate: false,
  /**
   * 自动备份：默认**开**（数据安全优先）。
   *
   * 本地历史是"写错了还能回去"的最后一层，而它自己就躺在 `%APPDATA%\Lumin` 里，
   * 和历史库同一个盘、同一个目录 —— 没有副本。默认开一天一份、保留 7 份，
   * 代价是几十 MB 磁盘，换来的是磁盘误删/同步盘回滚时的兜底（见 main/services/dbBackup.ts）。
   * 已存在的用户设置不受影响（落在 kv 里，只有全新 profile 才拿到这个默认值）。
   */
  backupAuto: true,
  /** 备份目录：null = 默认的 `<userData>/backups`（用户可以指到别的盘，界面里可选） */
  backupDir: null,
  recentFiles: [],
  recentFolders: [],
  pinnedFiles: [],
  /** 快捷键自定义（空 = 全部用代码里的默认键，见 renderer/src/lib/keymap/commands） */
  keybindings: {},
  export: {
    pdf: { margin: 24, pageSize: 'A4' },
    html: { template: 'default' }
  },
  /**
   * AI：OpenAI 兼容接口的默认端点与模型。
   * **API Key 不在这里**（它只以 safeStorage 密文存 kv 的 `aiApiKey`，渲染层拿不到）。
   */
  aiBaseUrl: AI_DEFAULT_BASE_URL,
  aiModel: AI_DEFAULT_MODEL,
  /** 对话默认只附选区（不把整篇文档发出去）——用户口径。 */
  aiContextDefault: 'selection' as 'selection' | 'document',
  /** 默认流式（可关，兼容不支持 SSE 的服务）。 */
  aiStream: true
}
