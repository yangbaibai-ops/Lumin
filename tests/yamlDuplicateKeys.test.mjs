// YAML 重复键扫描器（tools/check-yaml-duplicate-keys.mjs）的回归测试。
//
// 背景（审计 P0-1）：`.github/workflows/cdp.yml` 顶层写了两个 `name:`，YAML 后者覆盖
// 前者，工作流语义变成实现细节。修完不能只靠"这次改对了"——扫描器本身要有反例，
// 而且每次 `npm run test:unit` 都要把仓库里所有 workflow + electron-builder.yml
// 重新扫一遍，防止下一个人再写出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TARGETS, findDuplicateKeys, run } from '../tools/check-yaml-duplicate-keys.mjs'

test('顶层重复键：cdp.yml 第 12/14 行那种写法必须被抓住', () => {
  const yaml = ['# comment', 'name: old', '', 'name: new', 'on:', '  push:'].join('\n')
  const dupes = findDuplicateKeys(yaml)
  assert.equal(dupes.length, 1)
  assert.deepEqual(
    { key: dupes[0].key, line: dupes[0].line, firstLine: dupes[0].firstLine },
    { key: 'name', line: 4, firstLine: 2 }
  )
})

test('嵌套层级的重复键都要抓（不只是顶层）', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: windows-latest',
    '    runs-on: ubuntu-latest',
    '  test:',
    '    runs-on: ubuntu-latest'
  ].join('\n')
  const dupes = findDuplicateKeys(yaml)
  assert.equal(dupes.length, 1)
  assert.equal(dupes[0].key, 'runs-on')
  assert.equal(dupes[0].line, 4)
})

test('块标量正文里的 "name:" 是文本，不算重复键', () => {
  const yaml = [
    'name: workflow',
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: |',
    '          name: not-a-key',
    '          name: still-text',
    '    timeout-minutes: 60',
    '    timeout-minutes: 30'
  ].join('\n')
  const dupes = findDuplicateKeys(yaml)
  assert.equal(dupes.length, 1)
  assert.equal(dupes[0].key, 'timeout-minutes')
  assert.equal(dupes[0].line, 9)
})

test('序列里的兄弟项可以有同名键（不同 mapping，不算重复）', () => {
  const yaml = [
    'steps:',
    '  - name: a',
    '    uses: actions/checkout',
    '  - name: b',
    '    uses: actions/setup-node',
    '  - uses: actions/cache',
    '    with:',
    '      path: ~/.npm'
  ].join('\n')
  assert.deepEqual(findDuplicateKeys(yaml), [])
})

test('引号键、行内注释与 CRLF 都不影响判定', () => {
  const yaml = ['"build:win": a # x', "'build:win': b", 'on: [push]', 'on: pull_request'].join(
    '\r\n'
  )
  const dupes = findDuplicateKeys(yaml)
  assert.deepEqual(
    dupes.map((d) => [d.key, d.line, d.firstLine]),
    [
      ['build:win', 2, 1],
      ['on', 4, 3]
    ]
  )
})

test('仓库现状：全部 workflow 与 electron-builder.yml 无重复键', async () => {
  const { ok, results } = await run()
  const bad = results.filter((r) => r.missing || r.dupes.length || r.strict.error)
  assert.deepEqual(bad, [], `发现重复键/解析失败：${JSON.stringify(bad)}`)
  assert.equal(ok, true)
  // 扫描口径必须覆盖到 cdp.yml（这次修复的那份）
  assert.ok(DEFAULT_TARGETS.some((f) => f.endsWith('cdp.yml')))
})
