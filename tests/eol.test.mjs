// 行尾规则（src/shared/eol.ts）的单测。
// 这层决定「打开→保存会不会把整个文件的行尾换掉」——那是 git 里最刺眼的整文件 diff。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EOL_OPTIONS,
  detectEol,
  eolLabel,
  hasUniformEol,
  isEol,
  otherEol,
  toEol,
  toLf
} from '../src/shared/eol.ts'

test('detectEol：按多数行尾判定，无换行/空文本算 LF', () => {
  assert.equal(detectEol(''), 'lf')
  assert.equal(detectEol('a'), 'lf')
  assert.equal(detectEol('a\nb\n'), 'lf')
  assert.equal(detectEol('a\r\nb\r\n'), 'crlf')
  assert.equal(detectEol('a\r\nb\r\nc\n'), 'crlf', '两 CRLF 一 LF → CRLF')
  assert.equal(detectEol('a\nb\nc\r\n'), 'lf', '两 LF 一 CRLF → LF')
  // 孤立 CR（老 Mac）不算 CRLF
  assert.equal(detectEol('a\rb\r'), 'lf')
})

test('toLf：CRLF 与孤立 CR 都归一为 LF（内存形态）', () => {
  assert.equal(toLf('a\r\nb'), 'a\nb')
  assert.equal(toLf('a\rb'), 'a\nb')
  assert.equal(toLf('a\nb'), 'a\nb')
  assert.equal(toLf('a\r\n\r\nb'), 'a\n\nb')
})

test('toEol：按目标展开，且幂等', () => {
  assert.equal(toEol('a\nb\n', 'lf'), 'a\nb\n')
  assert.equal(toEol('a\nb\n', 'crlf'), 'a\r\nb\r\n')
  assert.equal(toEol('a\r\nb\r\n', 'lf'), 'a\nb\n')
  assert.equal(toEol('a\r\nb\r\n', 'crlf'), 'a\r\nb\r\n', '已经是目标形态时不动')
  for (const eol of EOL_OPTIONS) {
    const once = toEol('a\nb\n', eol)
    assert.equal(toEol(once, eol), once, `toEol(${eol}) 不幂等`)
  }
})

test('往返：toLf(toEol(x, eol)) 与原文本语义一致', () => {
  const lf = '标题\n\n正文\n'
  for (const eol of EOL_OPTIONS) {
    assert.equal(toLf(toEol(lf, eol)), lf)
  }
})

test('hasUniformEol：判断这次保存会不会改到行尾', () => {
  assert.equal(hasUniformEol('a\nb\n', 'lf'), true)
  assert.equal(hasUniformEol('a\nb\n', 'crlf'), false)
  assert.equal(hasUniformEol('a\r\nb\r\n', 'crlf'), true)
  assert.equal(hasUniformEol('a\r\nb\n', 'crlf'), false, '混合行尾会被统一')
})

test('标签与轮换', () => {
  assert.equal(eolLabel('lf'), 'LF')
  assert.equal(eolLabel('crlf'), 'CRLF')
  assert.equal(otherEol('lf'), 'crlf')
  assert.equal(otherEol('crlf'), 'lf')
  assert.deepEqual(EOL_OPTIONS, ['lf', 'crlf'])
  assert.equal(isEol('lf'), true)
  assert.equal(isEol('crlf'), true)
  assert.equal(isEol('LF'), false)
  assert.equal(isEol(''), false)
})
