// 软换行序列化规则（src/renderer/src/lib/editor/softBreakSerialize.ts）的单测。
//
// 审计 P2：20,000 行文档保存后被合并（softbreak 被折成空格）。修法是给 hardBreak 加
// `soft` 属性：soft → 写 `\n`（保住行结构、语义仍是软换行），真硬换行 → 仍写 `\\\n`。
// 这几条就是"保存后行数不再骤减"的全部判据，必须逐条钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeBreakNode } from '../src/renderer/src/lib/editor/softBreakSerialize.ts'

/** 造一个只包含 break 节点序列的假 parent；type 用字符串代替 PM 节点类型 */
function parentOf(types) {
  return {
    childCount: types.length,
    child: (i) => ({ type: types[i] })
  }
}
function stateOf(extra = {}) {
  const out = []
  return { out, write: (s) => out.push(s), ...extra }
}

test('soft=true（段内软换行）写单个换行，不写反斜杠', () => {
  const st = stateOf()
  const ok = writeBreakNode(
    st,
    { attrs: { soft: true }, type: 'hardBreak' },
    parentOf(['hardBreak', 'text']),
    0
  )
  assert.equal(ok, true)
  assert.deepEqual(st.out, ['\n'])
})

test('真硬换行仍写反斜杠 + 换行（既有语义不变）', () => {
  const st = stateOf()
  writeBreakNode(
    st,
    { attrs: { soft: false }, type: 'hardBreak' },
    parentOf(['hardBreak', 'text']),
    0
  )
  writeBreakNode(st, { attrs: {}, type: 'hardBreak' }, parentOf(['hardBreak', 'text']), 0)
  assert.deepEqual(st.out, ['\\\n', '\\\n'])
})

test('表格单元格里写 <br>（单元格不能用真换行）', () => {
  const st = stateOf({ inTable: true })
  writeBreakNode(
    st,
    { attrs: { soft: true }, type: 'hardBreak' },
    parentOf(['hardBreak', 'text']),
    0
  )
  assert.deepEqual(st.out, ['<br>'])
})

test('末尾连续的 hardBreak 不写（避免段落尾多一个空行）', () => {
  const st = stateOf()
  const parent = parentOf(['hardBreak', 'hardBreak', 'hardBreak'])
  writeBreakNode(st, { attrs: { soft: true }, type: 'hardBreak' }, parent, 0)
  writeBreakNode(st, { attrs: { soft: false }, type: 'hardBreak' }, parent, 1)
  writeBreakNode(st, { attrs: { soft: true }, type: 'hardBreak' }, parent, 2)
  assert.deepEqual(st.out, [])
})

test('softbreak 保留后，一行一段的 20k 结构逐行写回（抽样 5 行）', () => {
  const st = stateOf()
  const types = [
    'text',
    'hardBreak',
    'text',
    'hardBreak',
    'text',
    'hardBreak',
    'text',
    'hardBreak',
    'text'
  ]
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] !== 'hardBreak') continue
    writeBreakNode(st, { attrs: { soft: true }, type: 'hardBreak' }, parentOf(types), i)
  }
  assert.deepEqual(st.out, ['\n', '\n', '\n', '\n'])
})
