// 重建被截断的 config.json（默认值 + 工作区里的最近文档）
//
// 用法：
//   node tools/rebuild-config.js [工作区目录]
//
// 工作区目录也可以用环境变量 LUMIN_TEST_WORKSPACE 指定；省略时用仓库内的
// tools/fixtures/md/（只为验证配置结构，不指向任何个人目录）。
// 只写 %APPDATA%\lumin\config.json，不动工作区里的任何文件。
const fs = require('fs')
const path = require('path')
const p = path.join(process.env.APPDATA, 'lumin', 'config.json')

const WS = path.resolve(
  process.env.LUMIN_TEST_WORKSPACE || process.argv[2] || path.join(__dirname, 'fixtures', 'md')
)

const now = Date.now()
const recent = fs
  .readdirSync(WS)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .slice(0, 5)
  .map((name, i) => ({
    path: path.join(WS, name),
    title: name.replace(/\.md$/i, ''),
    openedAt: now - i * 1000
  }))

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

fs.mkdirSync(path.dirname(p), { recursive: true })
fs.writeFileSync(p, JSON.stringify(config, null, '\t'), 'utf8')
console.log('config rebuilt:', p)
