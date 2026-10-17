// ─── 代码块语言 UI 的纯逻辑（预设 / 别名 / 过滤 / 自动识别）────────────────────
//
// 本轮用户需求四件事里的两件是纯逻辑，必须在单测里钉住，否则只有真开实例才看得见：
//   ③ 自由输入语言：预设可过滤；输入未内置的语言名要**原样保留**（不重写成别的名字），
//      解析不出高亮包时按纯文本处理，而"是否要标注未内置高亮"要能判定；
//   ④ 自动识别：给 6 个无语言夹具（mermaid / ts / python / json / html / sql）必须认对，
//      另外把需求里点名的 js / c / cpp / rust / go / bash / css / markdown 也钉住；
//      识别不出来必须是 null（= 保持纯文本），不能瞎猜。
//
// 显式语言不被覆盖是**结构性**的：`detectLanguage` 只在"没有显式语言"时被调用，
// 组件侧由 CodeBlockView.vue 的 scheduleDetect() 守（见 tests/codeBlockLangUi.test.mjs
// 对源码结构的那几条断言）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DETECT_SAMPLE_CHARS,
  LANGUAGE_PRESETS,
  detectLanguage,
  filterLanguagePresets,
  isPlainTextLanguage,
  needsNoHighlightNotice,
  normalizeLanguageName,
  resolveLanguageKey
} from '../src/renderer/src/lib/editor/codeBlockLanguage.ts'

const REQUIRED = [
  'text',
  'js',
  'ts',
  'vue',
  'python',
  'bash',
  'json',
  'css',
  'html',
  'markdown',
  'sql',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'yaml',
  'mermaid'
]

test('预设：需求点名的 18 种语言都在，顺序即展示顺序', () => {
  assert.deepEqual([...LANGUAGE_PRESETS], REQUIRED)
})

test('语言名归一化：非字符串当无语言，首尾空白去掉，大小写不敏感', () => {
  assert.equal(normalizeLanguageName(undefined), '')
  assert.equal(normalizeLanguageName(null), '')
  assert.equal(normalizeLanguageName('  Zig  '), 'Zig')
  assert.equal(resolveLanguageKey('  TS '), 'typescript')
})

test('别名解析：预设/别名→高亮键；text 与自定义语言→null（纯文本）', () => {
  const cases = [
    ['js', 'javascript'],
    ['javascript', 'javascript'],
    ['jsx', 'javascript'],
    ['ts', 'typescript'],
    ['typescript', 'typescript'],
    ['vue', 'html'],
    ['html', 'html'],
    ['python', 'python'],
    ['py', 'python'],
    ['bash', 'bash'],
    ['sh', 'bash'],
    ['json', 'json'],
    ['css', 'css'],
    ['sql', 'sql'],
    ['go', 'go'],
    ['rust', 'rust'],
    ['java', 'java'],
    ['c', 'cpp'],
    ['c++', 'cpp'],
    ['cpp', 'cpp'],
    ['yaml', 'yaml'],
    ['yml', 'yaml']
  ]
  for (const [input, want] of cases) assert.equal(resolveLanguageKey(input), want, input)
  for (const input of ['', '   ', 'text', 'plaintext', 'zig', 'makefile', 'brainfuck']) {
    assert.equal(resolveLanguageKey(input), null, `应落回纯文本：${input}`)
  }
  // markdown：本仓没有内置 markdown 模式（也不引新依赖）⇒ 合法但按纯文本
  // （选择器里会如标注「未内置高亮」，不假装上色）
  assert.equal(resolveLanguageKey('markdown'), null)
  assert.equal(resolveLanguageKey('md'), null)
  assert.equal(needsNoHighlightNotice('markdown'), true)
  // mermaid 不是"高亮"语言（它渲染成图表），解析键为 null 但也不需要提示"未内置"
  assert.equal(resolveLanguageKey('mermaid'), null)
  assert.equal(needsNoHighlightNotice('mermaid'), false)
})

test('纯文本判定与"未内置高亮"提示：只对真的没有高亮包的语言提示', () => {
  for (const s of ['', 'text', 'plaintext', 'txt', 'none'])
    assert.equal(isPlainTextLanguage(s), true)
  assert.equal(isPlainTextLanguage('zig'), false)
  for (const s of ['ts', 'typescript', 'c', 'vue', 'mermaid', 'text', '']) {
    assert.equal(needsNoHighlightNotice(s), false, `不该提示：${s}`)
  }
  for (const s of ['markdown', 'zig', 'makefile', 'brainfuck']) {
    assert.equal(needsNoHighlightNotice(s), true, `应提示未内置：${s}`)
  }
})

test('过滤：空输入给全量；前缀/包含/别名都能命中，完全相等排最前', () => {
  assert.deepEqual(filterLanguagePresets(''), REQUIRED)
  assert.deepEqual(filterLanguagePresets('   '), REQUIRED)

  // 别名：py 命中 python；type 命中 ts（typescript）
  assert.deepEqual(filterLanguagePresets('py'), ['python'])
  assert.equal(filterLanguagePresets('type')[0], 'ts')
  assert.ok(filterLanguagePresets('script').includes('js'))
  assert.ok(filterLanguagePresets('script').includes('ts'))

  // 完全相等必须在第一位（用户已经把名字打全了，回车就是它）
  assert.equal(filterLanguagePresets('ts')[0], 'ts')
  assert.equal(filterLanguagePresets('java')[0], 'java')
  assert.equal(filterLanguagePresets('go')[0], 'go')

  // 大小写不敏感
  assert.deepEqual(filterLanguagePresets('TS'), filterLanguagePresets('ts'))

  // 一个都匹配不上 = 空数组（自定义语言由界面追加一行"使用 xxx"）
  assert.deepEqual(filterLanguagePresets('zig'), [])
})

test('自动识别：需求点名的 6 个夹具（mermaid / ts / python / json / html / sql）', () => {
  const fixtures = [
    ['flowchart TD\n  A[开始] --> B[结束]', 'mermaid'],
    ['sequenceDiagram\n  A->>B: hi', 'mermaid'],
    ['const a: number = 1\nexport default a', 'ts'],
    ['interface Foo {\n  x: string\n}', 'ts'],
    ['def greet(name):\n    return name', 'python'],
    ['{"a": 1, "b": [2, 3]}', 'json'],
    ['<div class="x">hi</div>', 'html'],
    ['<!DOCTYPE html>\n<html></html>', 'html'],
    ['SELECT id, name FROM users WHERE id = 1;', 'sql'],
    ['INSERT INTO t (a) VALUES (1)', 'sql']
  ]
  for (const [src, want] of fixtures) assert.equal(detectLanguage(src), want, src)
})

test('自动识别：js / c / cpp / rust / go / bash / css / markdown 也覆盖', () => {
  const fixtures = [
    ['const a = 1\nlet b = 2', 'js'],
    ['var x = 1', 'js'],
    ['#include <stdio.h>\nint main() { printf("hi"); }', 'c'],
    ['#include <iostream>\nstd::cout << "hi";', 'cpp'],
    ['#include <vector>\ntemplate <typename T> T id(T x) { return x; }', 'cpp'],
    ['fn main() {\n  let mut x = 1;\n}', 'rust'],
    ['package main\nfunc main() {}', 'go'],
    ['#!/bin/bash\necho hi', 'bash'],
    ['export PATH=$PATH:/usr/local/bin', 'bash'],
    ['.card { color: red; }', 'css'],
    ['@media (max-width: 600px) { .a { color: red } }', 'css'],
    ['# 标题\n\n[链接](https://example.com)', 'markdown']
  ]
  for (const [src, want] of fixtures) assert.equal(detectLanguage(src), want, src)
})

test('自动识别：识别不出来就是 null（保持纯文本），空内容不猜', () => {
  for (const src of ['', '   \n\n', 'hello world', 'The quick brown fox.']) {
    assert.equal(detectLanguage(src), null, JSON.stringify(src))
  }
})

test('自动识别只看开头一段（DETECT_SAMPLE_CHARS），不扫全文 —— 常数级成本', () => {
  assert.equal(typeof DETECT_SAMPLE_CHARS, 'number')
  assert.ok(DETECT_SAMPLE_CHARS > 0 && DETECT_SAMPLE_CHARS <= 8000)
  const prefix = 'x'.repeat(DETECT_SAMPLE_CHARS)
  assert.equal(detectLanguage(prefix + '\nflowchart TD\n A-->B'), null)
})

test('自动识别：python 的 coding 行先于 markdown 标题判定', () => {
  assert.equal(detectLanguage('#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nprint(1)'), 'python')
  // 普通 markdown 标题仍然认 markdown
  assert.equal(detectLanguage('# 标题\n\n正文'), 'markdown')
})
