// 编码表与工具（shared/encodings.ts）：写盘字节正确与否直接决定「用户文件会不会被写坏」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENCODINGS,
  bomOf,
  encodingChoices,
  encodingOf,
  iconvName,
  isUtf8Family
} from '../src/shared/encodings.ts'

test('每个编码都有 label / iconv 名 / BOM 规则', () => {
  for (const info of ENCODINGS) {
    assert.ok(info.id, 'id 不能为空')
    assert.ok(info.label, `${info.id} 缺 label`)
    assert.equal(typeof iconvName(info.id), 'string')
    assert.ok(iconvName(info.id).length > 0)
  }
})

test('auto 不是具体编码（不许拿它去写盘）', () => {
  assert.equal(encodingOf('auto'), null)
  // 选择器列表里**要**有 auto（那是 UI 的「自动检测」项），但它不在具体编码表里
  assert.equal(encodingChoices()[0], 'auto')
  assert.equal(
    ENCODINGS.some((e) => e.id === 'auto'),
    false
  )
  assert.ok(encodingChoices().includes('utf-8'))
})

test('BOM 只对带 BOM 的编码成立（utf-8 自身没有 BOM）', () => {
  assert.equal(bomOf('utf-8'), null)
  assert.equal(bomOf('utf-8-bom'), 'utf-8')
  assert.equal(bomOf('utf-16le'), 'utf-16le')
  assert.equal(bomOf('utf-16be'), 'utf-16be')
  assert.equal(bomOf('gbk'), null)
})

test('isUtf8Family 覆盖 utf-8 与 utf-8-bom，不覆盖 GBK/UTF-16', () => {
  assert.equal(isUtf8Family('utf-8'), true)
  assert.equal(isUtf8Family('utf-8-bom'), true)
  assert.equal(isUtf8Family('gbk'), false)
  assert.equal(isUtf8Family('utf-16le'), false)
})

test('编码 id 唯一（避免选择器里出现重复项）', () => {
  const ids = ENCODINGS.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
})
