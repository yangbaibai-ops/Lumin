// ─── 右键菜单「最近使用」已下线：结构 + 源码级零残留 ─────────────────────────
//
// 用户口径：「取消鼠标右键最近使用的功能和逻辑。」
// 这一组断言守两件事：
//   1) 菜单结构是**静态**的：分区顺序只由 providers 的 sortOrder / items 定义决定，
//      不再有任何「按使用频次插到最前」的分区；
//   2) 记录 / 读取 / 排序的实现与 API 面必须真的删干净（不是只把 UI 藏起来）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

// registry.ts 里是「无扩展名的相对 import」（'./providers'），Node 原生 ESM 认不出
installTsExtensionResolve()
const { buildEditorMenuSections } = await import('../src/renderer/src/lib/editor/menu/registry.ts')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

const ALL_IDS = [
  'clipboard.copy',
  'clipboard.cut',
  'clipboard.paste',
  'clipboard.pastePlain',
  'clipboard.selectAll',
  'table.rowAbove',
  'table.rowBelow',
  'table.colBefore',
  'table.colAfter',
  'table.toggleHeader',
  'table.deleteRow',
  'table.deleteCol',
  'table.delete',
  'paragraph.text',
  'paragraph.h1',
  'paragraph.h2',
  'paragraph.h3',
  'paragraph.quote',
  'paragraph.bulletList',
  'paragraph.orderedList',
  'paragraph.taskList',
  'paragraph.codeBlock',
  'format.bold',
  'format.italic',
  'format.strike',
  'format.inlineCode',
  'insert.link',
  'insert.image',
  'insert.table',
  'insert.hr',
  'insert.toc',
  'insert.paragraphAbove',
  'insert.paragraphBelow'
]
const actions = Object.fromEntries(
  ALL_IDS.map((id) => [id, { id, labelKey: `label.${id}`, run: () => true }])
)
const ctx = (patch = {}) => ({
  editor: null,
  hasSelection: false,
  inTable: false,
  inList: false,
  inTaskList: false,
  inBlockquote: false,
  inCodeBlock: false,
  headingLevel: null,
  table: null,
  ...patch
})
const ids = (sections) => sections.map((s) => s.id)
const items = (sections) =>
  sections.filter((s) => s.variant === 'list').flatMap((s) => s.items.map((i) => i.id))

test('菜单不再包含「最近使用」分区：普通场景只有静态四类（AI 子菜单已随主分支移除）', () => {
  const sections = buildEditorMenuSections(ctx(), actions)
  assert.deepEqual(ids(sections), ['clipboard', 'paragraph', 'format', 'insert'])
  assert.equal(
    sections.some((s) => /recent/i.test(s.id) || /recent/i.test(s.labelKey ?? '')),
    false
  )
})

test('菜单顺序快照：全程按静态定义（普通场景）', () => {
  const sections = buildEditorMenuSections(ctx(), actions)
  assert.deepEqual(items(sections), [
    'paragraph.text',
    'paragraph.h1',
    'paragraph.h2',
    'paragraph.h3',
    'paragraph.quote',
    'paragraph.bulletList',
    'paragraph.orderedList',
    'paragraph.taskList',
    'paragraph.codeBlock',
    'format.bold',
    'format.italic',
    'format.strike',
    'format.inlineCode',
    'insert.link',
    'insert.image',
    'insert.table',
    'insert.hr',
    'insert.toc',
    'insert.paragraphAbove',
    'insert.paragraphBelow'
  ])
})

test('菜单顺序快照：表格内多一个「表格」分区，位置仍由 sortOrder 决定', () => {
  const sections = buildEditorMenuSections(
    ctx({ inTable: true, table: { rows: 2, cols: 2, rowIndex: 0, colIndex: 0 } }),
    actions
  )
  assert.deepEqual(ids(sections), ['clipboard', 'table', 'paragraph', 'format', 'insert'])
  assert.equal(
    sections.some((s) => /recent/i.test(s.id) || /recent/i.test(s.labelKey ?? '')),
    false
  )
})

test('编辑器右键菜单相关源码里没有 recent 实现残留', () => {
  for (const rel of [
    'src/renderer/src/stores/editorMenu.ts',
    'src/renderer/src/lib/editor/menu/registry.ts',
    'src/renderer/src/lib/editor/menu/providers.ts',
    'src/renderer/src/components/EditorContextMenu.vue',
    'src/renderer/src/main.ts'
  ]) {
    assert.doesNotMatch(read(rel), /recent/i, `${rel} 仍有 recent 相关代码/文案`)
  }
})

test('记录/读取/排序 API 面已删除（preload / ipc / database / types）', () => {
  const files = [
    'src/preload/index.ts',
    'src/main/ipc.ts',
    'src/main/services/database.ts',
    'src/shared/types.ts'
  ]
  for (const rel of files) {
    const text = read(rel)
    assert.doesNotMatch(
      text,
      /menuUsage|menu:usage|listMenuUsage|bumpMenuUsage|resetMenuUsage/,
      rel
    )
  }
  // 渲染层不再调用任何使用记录接口
  assert.doesNotMatch(
    read('src/renderer/src/stores/editorMenu.ts'),
    /window\.luminAPI\.menuUsage|recentIds|clearUsage|buildRecentSection/,
    'store 里仍残留使用记录/最近使用逻辑'
  )
})

test('i18n 的「最近使用」两条 key 已从三份语言包删除', () => {
  for (const lang of ['zh-CN', 'en-US', 'ru-RU']) {
    const pack = JSON.parse(read(`src/shared/i18n/${lang}.json`))
    assert.equal('recent' in pack.editorMenu.section, false, `${lang}: editorMenu.section.recent`)
    assert.equal('clearRecent' in pack.editorMenu, false, `${lang}: editorMenu.clearRecent`)
  }
})
