// 跨文件（工作区级）替换纯逻辑（src/shared/workspaceReplace.ts）的单测。
//
// 这一层决定「哪些文件该改、每处替换成什么、谁必须跳过」。判错的后果比单文档替换重得多：
// 一次错配会**同时改掉工作区里所有命中它的文件**，而 Ctrl+Z 只能撤回当前编辑器里的那一次
// （所以主进程写盘前还会留一份本地历史快照，见 main/ipc.ts 的 workspace:replaceAll）。
// 边界逐条钉住：只改匹配、正则捕获组、大小写、跳过有未保存修改的当前文档、
// 非 Markdown 跳过、空查询不动、命中但内容不变不写、部分成功的账如实、
// 「编码表示不了新正文」的失败原因码可往返。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lossyReason,
  parseLossyReason,
  planFileReplace,
  planWorkspaceReplace,
  replaceInvalidReason,
  summarizeReplaceRun
} from '../src/shared/workspaceReplace.ts'

/** 一次替换请求的默认形状：字面量、不区分大小写（与查找栏默认一致） */
const req = (over = {}) => ({ query: 'foo', replacement: 'bar', ...over })
const file = (path, content) => ({ path, content })

test('只改命中的文件：没命中的既不在计划里、也不算"跳过"', () => {
  const plan = planWorkspaceReplace(
    [file('a.md', 'foo and foo'), file('b.md', 'nothing here'), file('c.md', '')],
    req()
  )
  assert.equal(plan.invalid, null)
  assert.deepEqual(
    plan.changes.map((c) => c.path),
    ['a.md']
  )
  assert.equal(plan.changes[0].content, 'bar and bar')
  assert.equal(plan.changes[0].count, 2)
  assert.deepEqual(plan.skipped, [], '没命中的文件不该出现在跳过列表里（那是噪音）')
  assert.equal(plan.files, 1)
  assert.equal(plan.occurrences, 2)
})

test('planFileReplace：命中数 + 替换后的正文；替换串里的 $1 在字面量模式下原样保留', () => {
  assert.deepEqual(planFileReplace('foo', req({ replacement: '$1' })), {
    count: 1,
    content: '$1',
    changed: true
  })
  assert.deepEqual(planFileReplace('nope', req()), { count: 0, content: 'nope', changed: false })
})

test('命中但替换后内容逐字相同 → changed=false（不白写一次盘、不动 mtime）', () => {
  assert.deepEqual(planFileReplace('foo', req({ replacement: 'foo' })), {
    count: 1,
    content: 'foo',
    changed: false
  })
  const plan = planWorkspaceReplace([file('a.md', 'foo')], req({ replacement: 'foo' }))
  assert.equal(plan.files, 0, '内容没变的文件不该被算成"会影响 1 个文件"')
  assert.equal(plan.occurrences, 0)
  assert.deepEqual(plan.changes, [])
})

test('正则模式：元字符生效，每处按各自的捕获组替换（$2:$1）', () => {
  const plan = planWorkspaceReplace([file('a.md', 'a=1 b=22'), file('b.md', 'no digits')], {
    query: '(\\w)=(\\d+)',
    replacement: '$2:$1',
    regex: true
  })
  assert.equal(plan.files, 1)
  assert.equal(plan.occurrences, 2, '两处命中各算一次')
  assert.equal(plan.changes[0].content, '1:a 22:b')
})

test('正则模式：`.*` 之类按码点匹配中文（与单文档查找同一套 u 标志）', () => {
  const plan = planWorkspaceReplace([file('a.md', '中文')], {
    query: '.',
    replacement: 'X',
    regex: true
  })
  assert.equal(plan.changes[0].content, 'XX')
  assert.equal(plan.occurrences, 2)
})

test('大小写：默认不敏感；打开 caseSensitive 后只改大小写相符的那些', () => {
  const files = [file('a.md', 'Bold bold BOLD')]
  assert.equal(planWorkspaceReplace(files, req({ query: 'bold' })).occurrences, 3)
  const sensitive = planWorkspaceReplace(files, req({ query: 'bold', caseSensitive: true }))
  assert.equal(sensitive.occurrences, 1)
  assert.equal(sensitive.changes[0].content, 'Bold bar BOLD')
})

test('跳过「当前打开且有未保存修改」的文档：只跳过它，其余照改，并如实列出', () => {
  const plan = planWorkspaceReplace(
    [file('C:\\ws\\cur.md', 'foo'), file('C:\\ws\\other.md', 'foo')],
    req(),
    { dirtyPaths: ['c:/WS/CUR.MD'] } // 路径比较大小写/分隔符不敏感
  )
  assert.deepEqual(
    plan.changes.map((c) => c.path),
    ['C:\\ws\\other.md'],
    '有未保存修改的文档绝不能被写盘'
  )
  assert.deepEqual(plan.skipped, [{ path: 'C:\\ws\\cur.md', count: 1, reason: 'dirty' }])
  assert.equal(plan.files, 1)
  assert.equal(plan.occurrences, 1, '跳过的文档不计入"会影响多少处"')
})

test('非 Markdown / 二进制文件跳过（即使索引里混进了它们的路径）', () => {
  const plan = planWorkspaceReplace([file('pic.png', 'foo'), file('doc.pdf', 'foo')], req())
  assert.deepEqual(plan.changes, [])
  assert.deepEqual(
    plan.skipped.map((s) => [s.path, s.reason]),
    [
      ['pic.png', 'unsupported'],
      ['doc.pdf', 'unsupported']
    ]
  )
  // .txt 属于"文档"（与扫描/索引同一份扩展名口径），不能误跳
  assert.equal(planWorkspaceReplace([file('note.txt', 'foo')], req()).files, 1)
})

test('空查询不动：不算"命中 0 个文件"，而是一个不可执行的动作', () => {
  assert.equal(replaceInvalidReason(req({ query: '' })), 'empty-query')
  assert.equal(replaceInvalidReason(req({ query: '   ' })), 'empty-query')
  const plan = planWorkspaceReplace([file('a.md', 'foo')], req({ query: '' }))
  assert.equal(plan.invalid, 'empty-query')
  assert.deepEqual(plan.changes, [])
  assert.deepEqual(plan.skipped, [])
  assert.equal(plan.files, 0)
  assert.equal(plan.occurrences, 0)
})

test('正则语法错 = invalid-regex（不是"零匹配"，更不该整篇被替换）', () => {
  assert.equal(replaceInvalidReason(req({ query: '(', regex: true })), 'invalid-regex')
  assert.equal(replaceInvalidReason(req({ query: '(', regex: false })), null, '字面量模式永远合法')
  const plan = planWorkspaceReplace([file('a.md', 'a(b')], req({ query: '(', regex: true }))
  assert.equal(plan.invalid, 'invalid-regex')
  assert.deepEqual(plan.changes, [])
})

test('干跑（预览）：files/occurrences 是"将会影响多少"，written 恒为 0、applied=false', () => {
  const plan = planWorkspaceReplace([file('a.md', 'foo foo')], req())
  const preview = summarizeReplaceRun(plan, [], false)
  assert.deepEqual(preview, {
    invalid: null,
    files: 1,
    occurrences: 2,
    written: 0,
    writtenOccurrences: 0,
    skippedDirty: [],
    skippedUnsupported: [],
    failures: [],
    applied: false
  })
})

test('部分成功要如实：written 只数真的写成的，失败的逐个带原因', () => {
  const plan = planWorkspaceReplace(
    [file('a.md', 'foo'), file('b.md', 'foo'), file('c.md', 'foo')],
    req()
  )
  assert.equal(plan.files, 3)
  const result = summarizeReplaceRun(
    plan,
    [
      { path: 'a.md', count: 1, ok: true },
      { path: 'b.md', count: 1, ok: true },
      { path: 'c.md', count: 1, ok: false, reason: 'EPERM: operation not permitted' }
    ],
    true
  )
  assert.equal(result.written, 2, '2 个成功')
  assert.equal(result.failures.length, 1, '1 个失败')
  assert.equal(result.files, 3, '计划数保持不变，才能看出"3 个里成了 2 个"')
  assert.equal(result.occurrences, 3)
  assert.equal(result.writtenOccurrences, 2, '只有写成的那些算进"已替换多少处"')
  assert.deepEqual(result.failures, [{ path: 'c.md', reason: 'EPERM: operation not permitted' }])
  assert.equal(result.applied, true)
})

test('读盘失败也进 failures（预览与真改都如实带出来，且不算作已替换）', () => {
  const plan = planWorkspaceReplace([file('a.md', 'foo')], req())
  const result = summarizeReplaceRun(plan, [{ path: 'x.md', count: 0, ok: false }], false)
  assert.equal(result.written, 0)
  assert.deepEqual(
    result.failures,
    [{ path: 'x.md', reason: '' }],
    '没有原因时给空串而不是 undefined'
  )
  assert.equal(result.applied, false)
})

test('跳过名单原样带进结果：哪些是"有未保存修改"、哪些是"不是文档"，分开列', () => {
  const plan = planWorkspaceReplace(
    [file('a.md', 'foo'), file('b.md', 'foo'), file('pic.png', 'foo')],
    req(),
    { dirtyPaths: ['b.md'] }
  )
  const result = summarizeReplaceRun(plan, [], false)
  assert.deepEqual(result.skippedDirty, ['b.md'])
  assert.deepEqual(result.skippedUnsupported, ['pic.png'])
  assert.equal(result.written, 0)
})

test('「编码表示不了新正文」的原因码可往返（渲染层靠它套既有的本地化文案）', () => {
  assert.equal(lossyReason('gbk'), 'ENCODING_LOSSY:gbk')
  assert.equal(parseLossyReason(lossyReason('gb18030')), 'gb18030')
  assert.equal(parseLossyReason('EPERM: operation not permitted'), null, '别的失败原因不该被认领')
  assert.equal(parseLossyReason(''), null)
  // 编码名里的冒号不会被截断（往返一致）
  assert.equal(parseLossyReason(lossyReason('weird:enc')), 'weird:enc')
})
