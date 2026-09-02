// 重建被截断的 config.json（默认值 + 可恢复的最近文档）
const fs = require('fs')
const path = require('path')
const p = path.join(process.env.APPDATA, 'lumin', 'config.json')

const now = Date.now()
const recent = [
  ['C:\\Users\\yangbaibai\\Desktop\\1.md', '1.md'],
  ['D:\\code_workspace\\Lumin-test-workspace\\features.md', 'features.md'],
  ['D:\\code_workspace\\Lumin-test-workspace\\notes.md', 'notes.md'],
  ['D:\\code_workspace\\Lumin-test-workspace\\README.md', 'README.md'],
  ['D:\\code_workspace\\Lumin-test-workspace\\docs\\guide.md', 'guide.md']
].map(([pth, title], i) => ({ path: pth, title, openedAt: now - i * 1000 }))

const config = {
  theme: 'auto',
  language: 'zh-CN',
  autoSave: true,
  autoSaveInterval: 3,
  fontSize: 17,
  lineHeight: 1.9,
  fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  editorMode: 'wysiwyg',
  sidebarVisible: true,
  sidebarWidth: 292,
  recentFiles: recent,
  pinnedFiles: [],
  export: {
    pdf: { margin: 24, pageSize: 'A4' },
    html: { template: 'default' }
  }
}

fs.writeFileSync(p, JSON.stringify(config, null, '\t'), 'utf8')
console.log('config rebuilt:', p)
