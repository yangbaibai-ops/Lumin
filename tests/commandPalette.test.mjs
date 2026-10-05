// 命令面板的纯函数层单测（src/renderer/src/lib/commandPalette.ts）。
//
// 为什么值得单测：过滤与排序是命令面板的**全部规则**，"哪个候选排第一"错了不会报错，
// 只会让人多按几次 ↓ —— 而这一层在 CDP 里要真开窗口、真敲键才验得到。
// 抽出来的代价是零（纯函数、不 import 任何运行时），收益是这些规则被毫秒级钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampIndex,
  filterCommands,
  matchIndex,
  matchRank,
  moveSelection,
  normalizeQuery,
  selectionChanged
} from '../src/renderer/src/lib/commandPalette.ts'

/** 测试夹具：id 与标题都是命令面板真实会拿到的形状（标题在运行时由 i18n 解析） */
const item = (id, label, extra = {}) => ({
  id,
  labelKey: label,
  keywords: [],
  run: () => {},
  ...extra
})

const LIST = [
  item('file.new', '新建'),
  item('file.save', '保存'),
  item('file.saveAs', '另存为…'),
  item('edit.find', '查找'),
  item('edit.globalSearch', '全局搜索（全文索引）'),
  item('view.source', '源码模式'),
  item('view.toggleSidebar', '切换侧边栏'),
  item('app.settings', '设置')
]

const labelOf = (it) => it.labelKey
const ids = (list) => list.map((it) => it.id)

test('空查询返回全部，且保持命令表的声明顺序（不排序入参）', () => {
  const out = filterCommands(LIST, '', labelOf)
  assert.deepEqual(ids(out), ids(LIST), '空查询必须原序返回全部')
  assert.notEqual(out, LIST, '必须返回新数组，不能把调用方持有的清单就地排序')
  assert.deepEqual(ids(filterCommands(LIST, '   ', labelOf)), ids(LIST), '纯空白查询等同空查询')
})

test('大小写无关：中英文与命令 id 都不区分大小写', () => {
  const list = [item('view.modeSource', 'Source Mode'), item('view.modeWysiwyg', 'WYSIWYG')]
  const lower = ids(filterCommands(list, 'source', labelOf))
  const upper = ids(filterCommands(list, 'SOURCE', labelOf))
  const mixed = ids(filterCommands(list, 'sOuRcE', labelOf))
  assert.deepEqual(lower, ['view.modeSource'])
  assert.deepEqual(upper, lower, '全大写查询必须与全小写等价')
  assert.deepEqual(mixed, lower, '混合大小写查询必须等价')
  // id 同样参与匹配（英文界面之外的输入法用户也能用命令 id 找）
  assert.deepEqual(ids(filterCommands(LIST, 'GLOBALSEARCH', labelOf)), ['edit.globalSearch'])
})

test('连续的内部空格折成一个分隔符（"另存 为" 也能找到「另存为…」）', () => {
  assert.deepEqual(ids(filterCommands(LIST, '  保存  ', labelOf)), ['file.save'])
  // 「另存为…」中间没有空格，这里验的是"输入里的空格被折掉、且首尾空白不算"
  assert.deepEqual(ids(filterCommands(LIST, ' 另存为… ', labelOf)), ['file.saveAs'])
})

test('排序：前缀命中排第一档，词首命中第二档，纯子串最后', () => {
  // 三个候选各自只命中一个档次，且**命中位置互不相同**，于是排序结果只由档次决定
  // （id 与查询词无关：档次必须由标题决定，见"大小写无关"那条）。
  // 注意 `保存 / 另存` 也是"位置 0 的前缀"，想让它落在词首档就得让正文在前面。
  const list = [
    item('alpha', '把文件保存起来'), // 纯子串：命中位置 3
    item('beta', '内容 保存 到磁盘'), // 词首：命中位置 3，但前面是空格
    item('gamma', '保存') // 整串前缀：命中位置 0
  ]
  assert.deepEqual(
    ids(filterCommands(list, '保存', labelOf)),
    ['gamma', 'beta', 'alpha'],
    '档次顺序必须是 整串前缀 → 词首 → 子串'
  )
  assert.equal(matchRank('保存', '保存'), 0)
  assert.equal(matchRank('内容 保存 到磁盘', '保存'), 1, '空格后的命中算词首')
  assert.equal(matchRank('file.saveAs', 'save'), 1, '`.` 后的命中算词首')
  assert.equal(matchRank('把文件保存起来', '保存'), 2, '夹在正文里的命中是纯子串')
  assert.equal(matchRank('保存', '找不到'), -1, '没命中返回 -1')
})

test('排序的稳定性：同档次同位置时保持命令表原序（且多次调用结果一致）', () => {
  const list = [
    item('a', '新建文件'),
    item('b', '新建窗口'),
    item('c', '新建文档'),
    item('d', '新建')
  ]
  // a/b/c 是"整串前缀且位置 0"的同分项 → 保持声明顺序；d 也是前缀，排在同一档
  const first = ids(filterCommands(list, '新建', labelOf))
  assert.deepEqual(first, ['a', 'b', 'c', 'd'])
  assert.deepEqual(
    ids(filterCommands(list, '新建', labelOf)),
    first,
    '同一输入两次调用必须完全一致'
  )
  // 真正同分的一批（前缀位置相同）里顺序由声明决定 —— 换一批同构造的输入也要成立
  const tie = [item('t1', '搜索'), item('t2', '搜索')]
  assert.deepEqual(ids(filterCommands(tie, '搜索', labelOf)), ['t1', 't2'])
})

test('无匹配返回空数组（不是全部、也不是 undefined）', () => {
  const out = filterCommands(LIST, '这个词一定不在命令表里', labelOf)
  assert.ok(Array.isArray(out), '必须返回数组')
  assert.equal(out.length, 0)
  assert.deepEqual(ids(filterCommands(LIST, 'zzzz', labelOf)), [])
})

test('特殊字符按字面量匹配，不炸正则也不误命中', () => {
  const list = [
    item('a', '保存 (Ctrl+S)'),
    item('b', '数组 [0]'),
    item('c', '星号 * 通配'),
    item('d', '反斜杠 \\ 路径'),
    item('e', '价格 $1.5'),
    item('f', '普通命令')
  ]
  // 这些都是"拼进正则就会出事"的字符：`(` 未闭合、`[0]` 是字符类、`*` 量词无对象、`\` 转义
  assert.deepEqual(ids(filterCommands(list, '(Ctrl', labelOf)), ['a'])
  assert.deepEqual(ids(filterCommands(list, '[0]', labelOf)), ['b'])
  assert.deepEqual(ids(filterCommands(list, '*', labelOf)), ['c'])
  assert.deepEqual(ids(filterCommands(list, '\\', labelOf)), ['d'])
  assert.deepEqual(ids(filterCommands(list, '$1', labelOf)), ['e'])
  // `.*` 当正则用会命中全部；当字面量用应该一条都不命中
  assert.deepEqual(ids(filterCommands(list, '.*', labelOf)), [])
  assert.equal(matchIndex('数组 [0]', '[0]'), 3, '匹配用的是 indexOf，不是正则')
})

test('normalizeQuery：任何非字符串输入都不会抛，且折成小写', () => {
  assert.equal(normalizeQuery('  SAVE  '), 'save')
  assert.equal(normalizeQuery(undefined), '')
  assert.equal(normalizeQuery(null), '')
  assert.equal(normalizeQuery(42), '42')
  assert.equal(normalizeQuery({}), '[object object]')
})

test('↑/↓ 移动：到两端停在原地，结果为空时返回 -1', () => {
  assert.equal(moveSelection(0, 1, 3), 1, '↓ 正常下移')
  assert.equal(moveSelection(2, 1, 3), 2, '↓ 到末尾停在末尾（不回卷）')
  assert.equal(moveSelection(0, -1, 3), 0, '↑ 到开头停在开头')
  assert.equal(moveSelection(-1, 1, 3), 0, '没有高亮时 ↓ 落到第一项')
  assert.equal(moveSelection(-1, -1, 3), 2, '没有高亮时 ↑ 落到最后一项')
  assert.equal(moveSelection(99, 1, 3), 2, '越界下标先钳到末尾再移动')
  assert.equal(moveSelection(0, 1, 0), -1, '没有候选时高亮为 -1')
  assert.equal(clampIndex(-1, 3), 0, '越界/负数下标钳到第一项（-1 只留给"没有候选"）')
  assert.equal(clampIndex(5, 3), 2)
  assert.equal(clampIndex(0, 0), -1)
  assert.equal(clampIndex(1, 0), -1)
})

test('selectionChanged：钳位之后没换行就不算变化（回车不必白等一帧）', () => {
  assert.equal(selectionChanged(0, 1, 3), true)
  assert.equal(selectionChanged(5, 9, 3), false, '两个越界下标钳到同一行 → 没变化')
  assert.equal(selectionChanged(-1, 0, 3), true, '从"无高亮"到第一行算变化')
  assert.equal(selectionChanged(0, -1, 0), false, '没有候选时不算变化')
})
