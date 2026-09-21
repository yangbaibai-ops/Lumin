// 快捷工具栏的目录与排序工具函数（纯逻辑，可在 Node 里直接跑）。
//
// 这些函数的输出会**直接落进 settings.toolbarItems 并驱动工具栏的渲染**，判错的表现
// 很隐蔽：菜单看着没问题，但某项从此再也显示不出来（或重复显示）。所以这里对每条
// 规则都给正例 + 反例，而不是只跑一遍 happy path。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TOOLBAR_ITEMS,
  TOOLBAR_ITEMS,
  insertToolbarItemByOrder,
  moveToolbarItem,
  sameToolbarGroup,
  sanitizeToolbarItems,
  toolbarItemDef
} from '../src/shared/toolbarItems.ts'
import { defaultSettings } from '../src/shared/defaults.ts'

test('目录：id 唯一、字段齐全（渲染期靠 id 找定义）', () => {
  const ids = TOOLBAR_ITEMS.map((it) => it.id)
  assert.equal(new Set(ids).size, ids.length, '目录里有重复 id')
  for (const it of TOOLBAR_ITEMS) {
    assert.ok(it.icon && it.labelKey.includes('.'), `${it.id} 缺少图标或 i18n key`)
    assert.equal(toolbarItemDef(it.id)?.id, it.id)
  }
  assert.equal(toolbarItemDef('不存在的项目'), undefined)
})

test('默认设置与目录一致：出厂顺序 = 目录顺序，且默认显示工具栏', () => {
  assert.deepEqual(defaultSettings.toolbarItems, DEFAULT_TOOLBAR_ITEMS)
  assert.equal(defaultSettings.toolbarVisible, true)
  // 默认项必须是目录的子集，否则清洗会悄悄丢掉它
  assert.deepEqual(sanitizeToolbarItems(defaultSettings.toolbarItems), DEFAULT_TOOLBAR_ITEMS)
})

test('sanitize：丢掉未知 id、去重、保留顺序', () => {
  assert.deepEqual(sanitizeToolbarItems(['bold', '幽灵项', 'italic', 'bold']), ['bold', 'italic'])
  assert.deepEqual(sanitizeToolbarItems([1, null, 'ul', {}]), ['ul'])
})

test('sanitize：空数组是「全部隐藏」而不是「没配过」', () => {
  // 关键区分：用户主动隐藏全部 ≠ 回退默认值（否则工具栏永远关不掉最后一个项目）
  assert.deepEqual(sanitizeToolbarItems([]), [])
  // 非数组才是「没配过」：退化成默认顺序
  assert.deepEqual(sanitizeToolbarItems(undefined), DEFAULT_TOOLBAR_ITEMS)
  assert.deepEqual(sanitizeToolbarItems(null), DEFAULT_TOOLBAR_ITEMS)
  assert.deepEqual(sanitizeToolbarItems('bold'), DEFAULT_TOOLBAR_ITEMS)
})

test('sanitize 幂等（渲染每次都会过一遍）', () => {
  const once = sanitizeToolbarItems(['italic', 'bold', 'bold', '幽灵'])
  assert.deepEqual(sanitizeToolbarItems(once), once)
})

test('sameToolbarGroup：只认同组', () => {
  assert.equal(sameToolbarGroup('bold', 'italic'), true)
  assert.equal(sameToolbarGroup('bold', 'h1'), false)
  assert.equal(sameToolbarGroup('bold', '幽灵'), false)
})

test('move：同组内换位', () => {
  const list = ['undo', 'redo', 'h1']
  assert.deepEqual(moveToolbarItem(list, 'redo', -1), ['redo', 'undo', 'h1'])
  assert.deepEqual(moveToolbarItem(list, 'undo', 1), ['redo', 'undo', 'h1'])
  assert.deepEqual(list, ['undo', 'redo', 'h1'], '原数组不许被就地修改')
})

test('move：跨组 / 越界 / 未知 id 一律原样返回（UI 可直接调）', () => {
  const list = ['undo', 'redo', 'h1', 'h2']
  assert.deepEqual(moveToolbarItem(list, 'h1', -1), list, '跨组不允许')
  assert.deepEqual(moveToolbarItem(list, 'undo', -1), list, '已在同组顶边')
  assert.deepEqual(moveToolbarItem(list, 'h2', 1), list, '整体末位')
  assert.deepEqual(moveToolbarItem(list, '幽灵', 1), list)
})

test('move：中间隔着一项时，方向正确（一次只挪一格）', () => {
  // 夹具用**当前目录里真实存在**的同一组项（`italic`/`code` 都属 inline 组）——
  // 原先用 `underline`，而它在第二十五轮被移出目录，未知 id 会直接原样返回。
  assert.deepEqual(moveToolbarItem(['bold', 'italic', 'code'], 'code', -1), [
    'bold',
    'code',
    'italic'
  ])
})

test('insert：落在出厂顺序里「它前面最近的已显示项」之后', () => {
  // italic 缺位：重新显示时应插到 bold 之后、strike 之前（而不是队尾）
  assert.deepEqual(insertToolbarItemByOrder(['bold', 'strike'], 'italic'), [
    'bold',
    'italic',
    'strike'
  ])
})

test('insert：前面的同类项都没显示时放到最前', () => {
  // 夹具同样只用目录里真实存在的 id（`table` 属 insert 组，排在 `bold` 之后）
  assert.deepEqual(insertToolbarItemByOrder(['table'], 'bold'), ['bold', 'table'])
})

test('insert：已存在 / 未知 id 不动列表', () => {
  const list = ['bold']
  assert.deepEqual(insertToolbarItemByOrder(list, 'bold'), list)
  assert.deepEqual(insertToolbarItemByOrder(list, '幽灵'), list)
})

test('组合：隐藏再显示能回到原来的相对顺序', () => {
  let list = sanitizeToolbarItems(DEFAULT_TOOLBAR_ITEMS)
  list = list.filter((x) => x !== 'italic')
  list = insertToolbarItemByOrder(list, 'italic')
  assert.deepEqual(list, DEFAULT_TOOLBAR_ITEMS)
})
