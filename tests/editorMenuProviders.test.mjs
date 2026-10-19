// ─── 编辑器右键菜单的内置提供者（审计 §10 P1「≥80 行 src 文件在 tests 里零引用」）──
//
// `src/renderer/src/lib/editor/menu/providers.ts` 是**纯函数**（只依赖动作表这一个入参，
// 不碰编辑器、不碰 Vue），此前零引用。它决定"右键时看到什么、哪一项是灰的"：
//   * `pick` 在动作 id 拼错时**抛错**（开发期立刻发现，而不是静默少一项）；
//   * `when/build` 按场景出场：不在表格里就不该有"删行/删列"，代码块里只留"转为正文"；
//   * `buildRecentSection` 是"最近使用"分区：只留当前上下文里确实可用的，去重、上限 5 条。
// 这些判据错了不会崩，只会让菜单少一项或多一项灰的 —— 没有断言就只能靠肉眼点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultProviders } from '../src/renderer/src/lib/editor/menu/providers.ts'

/** 动作表：只需要 id / labelKey / run 三个字段（disabled 由提供者按上下文补） */
const actionsOf = (ids) =>
  Object.fromEntries(ids.map((id) => [id, { id, labelKey: id, run: () => true }]))

/** providers.ts 会引用的全部动作 id（拼错任何一个，createDefaultProviders 都会抛） */
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

const providers = createDefaultProviders(actionsOf(ALL_IDS))
const providerById = new Map(providers.map((p) => [p.id, p]))
const sectionItems = (id, ctx) =>
  providerById
    .get(id)
    .build(ctx)
    .flatMap((s) => s.items)
const itemById = (items, id) => items.find((i) => i.id === id)

/** 场景快照：只要 `when/build` 真正读到的字段（editor 在这条路径上没被用到） */
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

// ── 动作表契约 ───────────────────────────────────────────────────────────────
test('动作 id 拼错时该分区一构建就抛错并点名（而不是静默少一项）', () => {
  const broken = actionsOf(ALL_IDS)
  delete broken['table.toggleHeader']
  // 注册是惰性的（build 闭包里才查动作表），所以错误在**构建该分区时**才暴露
  const tableProvider = createDefaultProviders(broken).find((p) => p.id === 'table')
  const inTable = ctx({ inTable: true, table: { rows: 2, cols: 2, rowIndex: 0, colIndex: 0 } })
  assert.throws(
    () => tableProvider.build(inTable),
    (err) => {
      assert.match(err.message, /unknown action: table\.toggleHeader/)
      return true
    }
  )
  // 对照：动作表完整时同一分区正常产出（8 项）
  assert.equal(sectionItems('table', inTable).length, 8)
})

test('提供者集合与排序：clipboard → table → paragraph → format → insert，sortOrder 递增', () => {
  assert.deepEqual(
    providers.map((p) => p.id),
    ['clipboard', 'table', 'paragraph', 'format', 'insert']
  )
  const orders = providers.map((p) => p.sortOrder)
  assert.deepEqual(
    orders,
    [...orders].sort((a, b) => a - b)
  )
})

// ── when：哪些场景出场 ───────────────────────────────────────────────────────
test('when：表格分区只在光标位于表格内时出场（别的场景一律不出）', () => {
  const table = providerById.get('table')
  assert.equal(table.when(ctx()), false)
  assert.equal(table.when(ctx({ inTable: true })), false, 'inTable 有了但表格几何信息缺失 ⇒ 不出场')
  assert.equal(
    table.when(ctx({ inTable: true, table: { rows: 2, cols: 2, rowIndex: 0, colIndex: 0 } })),
    true
  )
})

test('when：format 在代码块里不出场；insert 仍出场（只保留上/下段落两项）', () => {
  assert.equal(providerById.get('format').when(ctx()), true)
  assert.equal(providerById.get('format').when(ctx({ inCodeBlock: true })), false)
  assert.equal(providerById.get('insert').when(ctx()), true)
  // 代码块里「插入」不能整个消失：用户正是要在代码块外面挤出可写位置
  assert.equal(providerById.get('insert').when(ctx({ inCodeBlock: true })), true)
})

test('when：clipboard / paragraph 任何场景都出场（位置稳定，靠 disabled 表达不可用）', () => {
  for (const c of [ctx(), ctx({ inCodeBlock: true, inTable: true, hasSelection: true })]) {
    assert.equal(providerById.get('clipboard').when(c), true)
    assert.equal(providerById.get('paragraph').when(c), true)
  }
})

// ── build：按上下文禁用 ──────────────────────────────────────────────────────
test('clipboard：没有选区时 copy/cut 灰掉，paste/selectAll 不受影响', () => {
  const sections = providerById.get('clipboard').build(ctx())
  assert.equal(sections.length, 1)
  assert.equal(sections[0].variant, 'toolbar', '顶部横向图标行')
  assert.equal(sections[0].labelKey, undefined, 'toolbar 分区不需要标题')
  const none = sections[0].items
  assert.equal(itemById(none, 'clipboard.copy').disabled, true)
  assert.equal(itemById(none, 'clipboard.cut').disabled, true)
  assert.equal(itemById(none, 'clipboard.paste').disabled, undefined)
  assert.equal(itemById(none, 'clipboard.selectAll').disabled, undefined)

  const some = sectionItems('clipboard', ctx({ hasSelection: true }))
  assert.equal(itemById(some, 'clipboard.copy').disabled, false)
  assert.equal(itemById(some, 'clipboard.cut').disabled, false)
})

test('分区形状：table / paragraph / format / insert 都是带标题的 list 分区', () => {
  const inTable = ctx({ inTable: true, table: { rows: 2, cols: 2, rowIndex: 0, colIndex: 0 } })
  assert.deepEqual(
    providerById
      .get('table')
      .build(inTable)
      .map((s) => [s.id, s.variant, s.labelKey]),
    [['table', 'list', 'editorMenu.section.table']]
  )
  assert.deepEqual(
    providerById
      .get('insert')
      .build(ctx())
      .map((s) => [s.id, s.variant, s.labelKey]),
    [['insert', 'list', 'editorMenu.section.insert']]
  )
  assert.equal(providerById.get('paragraph').build(ctx()).length, 1)
})

test('table：只有一行不能删行、只有一列不能删列（禁用而不是隐藏，位置才稳定）', () => {
  const one = sectionItems(
    'table',
    ctx({ inTable: true, table: { rows: 1, cols: 1, rowIndex: 0, colIndex: 0 } })
  )
  assert.equal(itemById(one, 'table.deleteRow').disabled, true)
  assert.equal(itemById(one, 'table.deleteCol').disabled, true)
  assert.equal(itemById(one, 'table.delete').disabled, undefined, '"删除整个表格"与行列数无关')
  assert.equal(one.length, 8)

  const many = sectionItems(
    'table',
    ctx({ inTable: true, table: { rows: 3, cols: 4, rowIndex: 1, colIndex: 2 } })
  )
  assert.equal(itemById(many, 'table.deleteRow').disabled, false)
  assert.equal(itemById(many, 'table.deleteCol').disabled, false)
})

test('table：表格几何信息缺失时按"最保守"处理（行/列都算 1 ⇒ 两个删除都灰掉）', () => {
  const items = sectionItems('table', ctx({ inTable: true, table: null }))
  assert.equal(itemById(items, 'table.deleteRow').disabled, true)
  assert.equal(itemById(items, 'table.deleteCol').disabled, true)
})

test('paragraph：代码块里只留「转为正文」，其余段落样式全部撤掉', () => {
  const code = sectionItems('paragraph', ctx({ inCodeBlock: true }))
  assert.deepEqual(
    code.map((i) => i.id),
    ['paragraph.text']
  )
  const normal = sectionItems('paragraph', ctx())
  assert.deepEqual(
    normal.map((i) => i.id),
    [
      'paragraph.text',
      'paragraph.h1',
      'paragraph.h2',
      'paragraph.h3',
      'paragraph.quote',
      'paragraph.bulletList',
      'paragraph.orderedList',
      'paragraph.taskList',
      'paragraph.codeBlock'
    ]
  )
})

test('insert：普通场景 7 项，上/下段落排在最后；代码块里只留这两项', () => {
  const outside = sectionItems('insert', ctx())
  assert.deepEqual(
    outside.map((i) => i.id),
    [
      'insert.link',
      'insert.image',
      'insert.table',
      'insert.hr',
      'insert.toc',
      'insert.paragraphAbove',
      'insert.paragraphBelow'
    ]
  )
  const code = sectionItems('insert', ctx({ inCodeBlock: true }))
  assert.deepEqual(
    code.map((i) => i.id),
    ['insert.paragraphAbove', 'insert.paragraphBelow'],
    '代码块里不出现链接/图片/表格等（它们会插进代码块内部）'
  )
})

test('insert：已在表格里时「插入表格」灰掉（表格不能嵌套）', () => {
  const outside = sectionItems('insert', ctx())
  assert.equal(itemById(outside, 'insert.table').disabled, false)
  const inside = sectionItems('insert', ctx({ inTable: true }))
  // 表格内「插入表格」禁用
  assert.equal(itemById(inside, 'insert.table').disabled, true)
  assert.equal(itemById(inside, 'insert.link').disabled, undefined, '其它插入项不受影响')
  assert.equal(itemById(inside, 'insert.paragraphAbove').disabled, undefined)
  assert.equal(itemById(inside, 'insert.paragraphBelow').disabled, undefined)
})
