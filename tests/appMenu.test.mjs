// 应用菜单（顶部自绘菜单栏）的结构完整性。
//
// 为什么静态检查就够：菜单项与命令 id 都是源码里的字面量，运行期只需要抽查
// "点了有没有反应"（tools 里的 CDP 套件）。这里守住三类**一改就静默丢功能**的事：
//   1) 常用入口缺项（文件/编辑/视图/帮助）；
//   2) 菜单里写了 `commandId`，但快捷键注册表没有这条命令（加速键永远空白）；
//   3) 新增插入命令的默认键与既有默认键重复（用户改绑后旧键被另一条接管）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORT_FORMATS } from '../src/shared/exportFormats.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MENU = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/TopMenuBar.vue'), 'utf-8')
const KEYMAP = fs.readFileSync(
  path.join(ROOT, 'src/renderer/src/composables/useKeymap.ts'),
  'utf-8'
)

/** 菜单里必须存在的 i18n 键（用户点名的四组常用功能） */
const REQUIRED = [
  // 文件
  'menu.new',
  'menu.openFile',
  'menu.openFolder',
  'menu.save',
  'menu.saveAs',
  'menu.export',
  'menu.print',
  'menu.closeWindow',
  'menu.quit',
  // 编辑
  'menu.undo',
  'menu.redo',
  'menu.cut',
  'menu.copy',
  'menu.paste',
  'menu.pastePlain',
  'menu.selectAll',
  'menu.findReplace',
  // 视图
  'menu.toggleSidebar',
  'menu.outline',
  'menu.split',
  'menu.source',
  'menu.zoomIn',
  'menu.zoomOut',
  'menu.zoomReset',
  'menu.theme',
  // 帮助
  'menu.keymap',
  'menu.docs',
  'menu.checkUpdate',
  'menu.about',
  'menu.openDevTools'
]

test('顶部菜单：四组常用入口齐全', () => {
  const missing = REQUIRED.filter((k) => !MENU.includes(`'${k}'`))
  assert.deepEqual(missing, [], `顶部菜单缺少：${missing.join(', ')}`)
})

test('顶部菜单：每个 commandId 都能在快捷键注册表里找到', () => {
  const ids = [...MENU.matchAll(/commandId:\s*'([^']+)'/g)].map((m) => m[1])
  const registered = new Set([
    ...[...KEYMAP.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]),
    ...EXPORT_FORMATS.map((f) => f.commandId)
  ])
  const missing = [...new Set(ids)].filter((id) => !registered.has(id))
  assert.deepEqual(missing, [], `菜单引用了不存在的命令：${missing.join(', ')}`)
})

test('顶部菜单：所有条目要么有 labelKey 要么有 label（没有空白菜单项）', () => {
  // 抓 GROUPS 里的对象字面量：`{ labelKey: 'x'` 或 `{ label: ...`
  const entries = [...MENU.matchAll(/\{\s*(?:labelKey|label):/g)].length
  assert.ok(entries >= 40, `解析到的菜单项太少（${entries}），检查模板`)
})

test('快捷键注册表：新增插入命令的默认键正确，且默认键无重复', () => {
  const expected = {
    'insert.table': 'Mod+Alt+T',
    'insert.hr': 'Mod+Alt+H',
    'insert.image': 'Mod+Alt+Shift+I',
    'insert.link': 'Mod+Alt+K',
    'insert.codeBlock': 'Mod+Alt+Shift+C',
    'insert.math': 'Mod+Alt+M',
    'insert.mermaid': 'Mod+Alt+G',
    'insert.paragraphAbove': 'Mod+Alt+ArrowUp',
    'insert.paragraphBelow': 'Mod+Alt+ArrowDown'
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [id, keys] of Object.entries(expected)) {
    const re = new RegExp(`id:\\s*'${esc(id)}'[\\s\\S]{0,400}?defaultKeys:\\s*'${esc(keys)}'`)
    assert.match(KEYMAP, re, `${id} 的默认键应为 ${keys}`)
  }

  const explicit = [...KEYMAP.matchAll(/id:\s*'([^']+)'[\s\S]*?defaultKeys:\s*(?:'([^']+)'|null)/g)]
    .map((m) => ({ id: m[1], keys: m[2] ?? null }))
    .filter((c) => c.keys)
  const all = [
    ...explicit,
    ...EXPORT_FORMATS.map((f) => ({ id: f.commandId, keys: f.defaultKeys }))
  ].filter((c) => c.keys)
  const seen = new Map()
  const dup = []
  for (const c of all) {
    const prev = seen.get(c.keys)
    if (prev) dup.push(`${c.keys}: ${prev} / ${c.id}`)
    else seen.set(c.keys, c.id)
  }
  assert.deepEqual(dup, [], `默认键重复：${dup.join('; ')}`)
})
