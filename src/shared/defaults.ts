import type { AppSettings } from './types'
// 显式 .ts：defaults 会被 tests/*.test.mjs 直接加载，而 Node 的 ESM 解析不做扩展名补全（见 §4.56）
import { HISTORY_LIMIT_PER_FILE, HISTORY_MAX_AGE_MS } from './history.ts'
import { DEFAULT_TOOLBAR_ITEMS } from './toolbarItems.ts'

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
  theme: 'auto',
  language: 'zh-CN',
  autoSave: true,
  autoSaveInterval: 3,
  nativeMenuBar: true,
  fontSize: 17,
  lineHeight: 1.9,
  fontFamily: FONT_OPTIONS[0].value,
  editorMode: 'wysiwyg',
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
   *   `'click'`（默认）＝ 先挡成占位、点一下才加载 —— 打开别人的笔记不会自动外联（隐私）；
   *   `'always'` ＝ 旧行为，直接加载。
   * 见 `src/renderer/src/lib/remoteImages.ts`；导出 HTML 用的是真实 src，不受此设置影响。
   */
  remoteImages: 'click' as 'click' | 'always',
  sidebarVisible: true,
  sidebarWidth: 264,
  splitRatio: 0.5,
  syncScroll: false,
  codeLineNumbers: true,
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
  recentFiles: [],
  recentFolders: [],
  pinnedFiles: [],
  /** 快捷键自定义（空 = 全部用代码里的默认键，见 renderer/src/lib/keymap/commands） */
  keybindings: {},
  export: {
    pdf: { margin: 24, pageSize: 'A4' },
    html: { template: 'default' }
  }
}
