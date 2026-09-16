import type { AppSettings } from './types'
// 显式 .ts：defaults 会被 tests/*.test.mjs 直接加载，而 Node 的 ESM 解析不做扩展名补全（见 §4.56）
import { HISTORY_LIMIT_PER_FILE, HISTORY_MAX_AGE_MS } from './history.ts'

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
