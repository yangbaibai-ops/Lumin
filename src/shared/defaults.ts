import type { AppSettings } from './types'

export const FONT_OPTIONS: { value: string; label: string }[] = [
  {
    value:
      "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    label: 'sans'
  },
  {
    value:
      "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', 'Noto Serif SC', serif",
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
  fontSize: 17,
  lineHeight: 1.9,
  fontFamily: FONT_OPTIONS[0].value,
  editorMode: 'wysiwyg',
  sidebarVisible: true,
  sidebarWidth: 264,
  splitRatio: 0.5,
  syncScroll: false,
  recentFiles: [],
  pinnedFiles: [],
  export: {
    pdf: { margin: 24, pageSize: 'A4' },
    html: { template: 'default' }
  }
}
