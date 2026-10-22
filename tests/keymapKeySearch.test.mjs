// ─── 快捷键搜索：按「按下的组合键」筛命令（纯函数 + 组件契约）───────────────────
//
// 用户口径：在搜索框里按下 Ctrl+Shift+P / Ctrl+Alt+T ⇒ 列表直接只剩绑定到该键的命令，
// 未绑定的键要明确显示「未绑定」，退格或小 × 清除后回到文字搜索。
//
// 这里守三层：
//   1. `keyQueryFromEvent` 只把「带 Ctrl/Cmd/Alt 的组合」变成筛选条件（裸字母/退格照常输入）；
//   2. 筛选比较用**规范化**后的表达式（`Ctrl+Alt+T`），否则大小写/别名会让结果筛空；
//   3. 组件里给搜索框打 `data-keymap-capture`（全局分发器据此让行）、有按键胶囊与未绑定提示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

installTsExtensionResolve()
const { filterCommandsByKey, isConflictingKey, keyQueryFromEvent } =
  await import('../src/renderer/src/lib/keymap/keySearch.ts')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SETTINGS_KEYMAP = readFileSync(
  join(ROOT, 'src/renderer/src/components/SettingsKeymap.vue'),
  'utf-8'
)

/** 造一个只有分发器/筛选会读的字段的按键事件 */
const key = (patch) => ({
  key: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...patch
})

const COMMANDS = [
  { id: 'insert.table', keys: 'Ctrl+Alt+T', conflictWith: [] },
  { id: 'insert.hr', keys: 'Ctrl+Alt+H', conflictWith: [] },
  { id: 'view.focusMode', keys: 'Ctrl+Shift+F', conflictWith: [] }
]

test('按键 → 规范表达式：只认带 Ctrl/Cmd/Alt 的组合', () => {
  assert.equal(keyQueryFromEvent(key({ key: 't', ctrlKey: true, altKey: true })), 'Ctrl+Alt+T')
  assert.equal(keyQueryFromEvent(key({ key: 'P', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+P')
  assert.equal(keyQueryFromEvent(key({ key: 'f', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+F')
  // 裸字母 / 退格 / 单独的修饰键 / Shift+Tab 都不进入按键筛选
  for (const e of [
    key({ key: 'a' }),
    key({ key: 'Backspace' }),
    key({ key: 'Control', ctrlKey: true }),
    key({ key: 'Tab', shiftKey: true })
  ]) {
    assert.equal(keyQueryFromEvent(e), null)
  }
  assert.equal(keyQueryFromEvent(key({ key: 'Escape' })), null, 'Esc 留给"清除筛选"')
})

test('按生效键筛选：Ctrl+Alt+T 只剩「插入表格」', () => {
  const hits = filterCommandsByKey(COMMANDS, 'Ctrl+Alt+T')
  assert.deepEqual(
    hits.map((c) => c.id),
    ['insert.table']
  )
  // 大小写/别名差异也要命中（比较前两边规范化）
  assert.deepEqual(
    filterCommandsByKey(COMMANDS, 'ctrl+alt+t').map((c) => c.id),
    ['insert.table']
  )
  // null = 不筛，回到文字搜索
  assert.equal(filterCommandsByKey(COMMANDS, null).length, 3)
})

test('未绑定的键：筛选结果为空（组件据此显示「未绑定」）', () => {
  assert.deepEqual(filterCommandsByKey(COMMANDS, 'Ctrl+Alt+Q'), [])
})

test('冲突提示：同一组合键被多条命令占用时可以被识别', () => {
  const conflicted = [
    { id: 'a', keys: 'Ctrl+Alt+T', conflictWith: ['b'] },
    { id: 'b', keys: 'Ctrl+Alt+T', conflictWith: ['a'] }
  ]
  assert.equal(isConflictingKey(filterCommandsByKey(conflicted, 'Ctrl+Alt+T')), true)
  assert.equal(isConflictingKey(filterCommandsByKey(COMMANDS, 'Ctrl+Alt+T')), false)
})

test('组件契约：搜索框可捕获按键、胶囊可清除、未绑定/冲突有提示', () => {
  assert.match(SETTINGS_KEYMAP, /data-keymap-capture/, '搜索框必须标记为按键捕获区')
  assert.match(SETTINGS_KEYMAP, /@keydown="onSearchKeydown"/)
  assert.match(SETTINGS_KEYMAP, /keyQueryFromEvent\(e\)/)
  assert.match(SETTINGS_KEYMAP, /data-keymap-key-query/, '按键胶囊缺少可定位标记')
  assert.match(SETTINGS_KEYMAP, /data-keymap-key-query-clear/, '胶囊缺少清除按钮')
  assert.match(SETTINGS_KEYMAP, /Backspace/, '退格要能清除按键条件')
  assert.match(SETTINGS_KEYMAP, /keyFilterUnbound/, '未绑定提示缺少文案键')
  assert.match(SETTINGS_KEYMAP, /keyFilterConflict/, '冲突提示缺少文案键')
  assert.match(SETTINGS_KEYMAP, /filterCommandsByKey/, '必须按按键条件筛命令')
})
