// 文档文本规则（src/shared/documentText.ts）的单测。
// 这两条规则看着琐碎，但直接决定「打开→保存文件会不会变」，所以钉死在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withFinalNewline, codeFenceFor } from '../src/shared/documentText.ts'

test('withFinalNewline：非空文档以且仅以一个换行结尾', () => {
  assert.equal(withFinalNewline('a'), 'a\n')
  assert.equal(withFinalNewline('a\n'), 'a\n')
  assert.equal(withFinalNewline('a\n\n\n'), 'a\n')
  assert.equal(withFinalNewline('a\nb'), 'a\nb\n')
  assert.equal(withFinalNewline('\n'), '\n')
})

test('withFinalNewline：空文档保持空（空白新文档不该被写成一个换行）', () => {
  assert.equal(withFinalNewline(''), '')
})

test('withFinalNewline 幂等', () => {
  for (const s of ['', 'a', 'a\n', 'a\n\n', '\n\n', '标题\n\n正文']) {
    assert.equal(withFinalNewline(withFinalNewline(s)), withFinalNewline(s), JSON.stringify(s))
  }
})

test('codeFenceFor：围栏必须比内容里最长的反引号串更长', () => {
  assert.equal(codeFenceFor('plain code'), '```')
  assert.equal(codeFenceFor('a ` b'), '```')
  assert.equal(codeFenceFor('a\n```\nb'), '````')
  assert.equal(codeFenceFor('`````'), '``````')
  assert.equal(codeFenceFor('~~~~'), '```', '波浪线内容不需要加长反引号围栏')
})
