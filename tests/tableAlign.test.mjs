// 表格纯文本规则（src/renderer/src/lib/editor/tableAlign.ts）的单测。
//
// 这两条规则决定「表格往返会不会丢格式、会不会把行结构写坏」：
//   分隔行不还原对齐 → 整列的对齐信息丢失（表格全变左对齐）；
//   单元格里的竖线不转义 → 重新解析时被当成列分隔符，**一行被拆成更多格**（结构损坏）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  delimiterCell,
  delimiterRow,
  escapeCellPipes
} from '../src/renderer/src/lib/editor/tableAlign.ts'

test('对齐 → 分隔行写法（含默认）', () => {
  assert.equal(delimiterCell('left'), ':---')
  assert.equal(delimiterCell('center'), ':---:')
  assert.equal(delimiterCell('right'), '---:')
  assert.equal(delimiterCell(null), '---')
  assert.equal(delimiterCell(undefined), '---')
  // 认不出来的值按默认处理（不抛错：脏数据不该让序列化整篇失败）
  assert.equal(delimiterCell('justify'), '---')
})

test('整行分隔行按列拼接', () => {
  assert.equal(delimiterRow([null, 'left', 'right']), '| --- | :--- | ---: |')
  assert.equal(delimiterRow(['center', 'right']), '| :---: | ---: |')
  assert.equal(delimiterRow([null]), '| --- |')
})

test('单元格里的竖线转义', () => {
  assert.equal(escapeCellPipes('转义 | 竖线'), '转义 \\| 竖线')
  assert.equal(escapeCellPipes('a | b | c'), 'a \\| b \\| c')
})

test('已经是 \\| 的不重复加反斜杠（幂等）', () => {
  assert.equal(escapeCellPipes('a \\| b'), 'a \\| b')
  assert.equal(escapeCellPipes(escapeCellPipes('a | b')), 'a \\| b')
})

test('行首的竖线也要转义（行首没有前一个字符可借用）', () => {
  assert.equal(escapeCellPipes('|开头'), '\\|开头')
})

test('没有竖线的内容原样返回；行内代码里的竖线同样转义', () => {
  assert.equal(escapeCellPipes('普通文本 **加粗**'), '普通文本 **加粗**')
  assert.equal(escapeCellPipes('`a | b`'), '`a \\| b`')
})
