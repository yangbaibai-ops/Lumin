// 两面一致性不变量（tools/lib/surface-invariants.js）的单测。
//
// 判据写错的后果很隐蔽：套件会一直绿，但它其实什么都没验。所以这里对每条不变量
// 都给「正例 + 反例」——反例必须被认出来，正例不许误报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  contentPreserved,
  idempotent,
  unchanged,
  contentKey,
  diagnoseLoss,
  traceTokens,
  structureFromMarkdown,
  structureDiff,
  tally
} = require('../tools/lib/surface-invariants.js')

test('I1 内容守恒：exact/normalized 通过，lossy 被抓出来', () => {
  assert.equal(contentPreserved('# a\n', '# a\n').level, 'exact')
  assert.equal(contentPreserved('# a\n', '# a').level, 'normalized')
  const bad = contentPreserved('正文甲\n', '正文乙\n')
  assert.equal(bad.ok, false)
  assert.equal(bad.level, 'lossy')
  assert.ok(bad.diagnosis, 'lossy 时必须给出分诊结果')
})

test('I2 幂等：逐字比较（连行尾都算）', () => {
  assert.equal(idempotent('a\n', 'a\n').ok, true)
  assert.equal(idempotent('a\n', 'a\r\n').ok, false, '行尾变化也算不幂等')
})

test('I3/I4 逐字不变：切面副作用必须逐字为零', () => {
  assert.equal(unchanged('a\nb\n', 'a\nb\n').ok, true)
  assert.equal(unchanged('a\nb\n', 'a\n\nb\n').ok, false)
})

test('内容分诊：能区分「真丢内容」与「只是重写了标记」', () => {
  // 只改标记：*a* → _a_，内容键相同
  assert.equal(diagnoseLoss('*甲*\n', '_甲_\n').markerOnly, true)
  // 真丢内容：少了一个字
  const lost = diagnoseLoss('甲乙丙\n', '甲乙\n')
  assert.equal(lost.markerOnly, false)
  assert.equal(lost.lost, '丙')
  // 多出内容
  assert.equal(diagnoseLoss('甲\n', '甲乙\n').added, '乙')
})

test('contentKey 抹掉标记与空白（分诊口径）', () => {
  assert.equal(contentKey('# 标题\n\n**粗** 体\n'), contentKey('标题粗体'))
  assert.notEqual(contentKey('甲'), contentKey('乙'))
})

test('I7 哨兵词追踪：缺失与乱序都要能报出来', () => {
  const ok = traceTokens('a ZQ1 b ZQ2 c', ['ZQ1', 'ZQ2'])
  assert.equal(ok.ok, true)
  assert.equal(ok.found, 2)
  const missing = traceTokens('a ZQ1 c', ['ZQ1', 'ZQ2'])
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing, ['ZQ2'])
  const order = traceTokens('a ZQ2 b ZQ1', ['ZQ1', 'ZQ2'])
  assert.equal(order.ok, false)
  assert.equal(order.outOfOrder, true)
})

test('结构扫描：跳过围栏内部，认出标题层级/围栏/公式/表格/任务项', () => {
  const md = [
    '# 一',
    '## 二',
    '```js',
    '# 这不是标题',
    '```',
    '$$',
    'x = 1',
    '$$',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '- [ ] 待办',
    '- [x] 完成',
    '---'
  ].join('\n')
  const s = structureFromMarkdown(md)
  assert.deepEqual(s.headings, [1, 2], '围栏里的 # 不算标题')
  assert.equal(s.codeBlocks, 1)
  assert.deepEqual(s.codeInfos, ['js'])
  assert.equal(s.mathBlocks, 1)
  assert.equal(s.tables, 1)
  assert.equal(s.taskItems, 2)
  assert.equal(s.hr, 1, '分隔线只有最后那一条（表格分隔行不算）')
})

test('结构比对：差异要具体到项与数字', () => {
  const expected = { codeBlocks: 2, tables: 1, headings: [1, 2] }
  assert.deepEqual(structureDiff(expected, { codeBlocks: 2, tables: 1, headings: [1, 2] }), [])
  const diffs = structureDiff(expected, { codeBlocks: 1, tables: 1, headings: [1, 3] })
  assert.equal(diffs.length, 2)
  assert.match(diffs.join(' '), /codeBlocks: 期望 2 实际 1/)
  assert.match(diffs.join(' '), /标题层级序列/)
})

test('三档计数', () => {
  assert.deepEqual(tally(['exact', 'normalized', 'exact']), { exact: 2, normalized: 1, lossy: 0 })
})
