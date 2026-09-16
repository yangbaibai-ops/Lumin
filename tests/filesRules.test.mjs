// 从 files store 抽出来的纯规则的单测：最近列表 / 草稿判定 / 文档文本小工具。
// 这些规则原先藏在 store 里（要跑 Pinia 才能测），抽出来的意义就是能被毫秒级钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECENT_FILES_LIMIT,
  RECENT_FOLDERS_LIMIT,
  baseNameOf,
  planRecentFolderList,
  planRemoveRecent,
  planRemoveRecentFolder,
  planTogglePin,
  planTouchRecent,
  planTouchRecentFolder
} from '../src/renderer/src/lib/recent.ts'
import { draftKeyFor, restorableDraft } from '../src/renderer/src/lib/draftRules.ts'
import {
  encodingLabel,
  formatHistoryTime,
  untitledEol,
  untitledEncoding
} from '../src/renderer/src/lib/docText.ts'

test('baseNameOf：两种分隔符都认，取最后一段', () => {
  assert.equal(baseNameOf('C:\\a\\b\\note.md'), 'note.md')
  assert.equal(baseNameOf('/home/me/note.md'), 'note.md')
  assert.equal(baseNameOf('C:\\a\\b\\'), 'b')
  assert.equal(baseNameOf('note.md'), 'note.md')
})

test('planTouchRecent：去重 + 置顶 + 截断', () => {
  const now = 1000
  const old = [
    { path: 'C:\\a.md', title: 'a.md', openedAt: 1 },
    { path: 'C:\\b.md', title: 'b.md', openedAt: 2 }
  ]
  const next = planTouchRecent(old, 'C:\\b.md', now)
  assert.equal(next[0].path, 'C:\\b.md', '重开的置顶')
  assert.equal(next[0].title, 'b.md', '标题按路径重算')
  assert.equal(next.length, 2, '不产生重复条目')
  assert.equal(next[0].openedAt, now)

  const many = Array.from({ length: RECENT_FILES_LIMIT + 5 }, (_, i) => ({
    path: `C:\\f${i}.md`,
    title: `f${i}.md`,
    openedAt: i
  }))
  assert.equal(planTouchRecent(many, 'C:\\new.md', now).length, RECENT_FILES_LIMIT)
})

test('planRemoveRecent / planTogglePin：不动原数组', () => {
  const list = [
    { path: 'a', title: 'a', openedAt: 1 },
    { path: 'b', title: 'b', openedAt: 2 }
  ]
  const removed = planRemoveRecent(list, 'a')
  assert.deepEqual(
    removed.map((r) => r.path),
    ['b']
  )
  assert.equal(list.length, 2, '原列表保持 2 条（纯函数不改入参）')

  assert.deepEqual(planTogglePin([], 'x'), ['x'])
  assert.deepEqual(planTogglePin(['x', 'y'], 'x'), ['y'])
  assert.deepEqual(planTogglePin(['x'], 'y').sort(), ['x', 'y'])
})

test('planTouchRecentFolder：去重 + 置顶 + 上限 12', () => {
  const next = planTouchRecentFolder([{ path: 'C:\\w', name: 'w', openedAt: 1 }], 'C:\\w', 9)
  assert.equal(next.length, 1)
  assert.equal(next[0].openedAt, 9)
  const many = Array.from({ length: RECENT_FOLDERS_LIMIT + 3 }, (_, i) => ({
    path: `C:\\d${i}`,
    name: `d${i}`,
    openedAt: i
  }))
  assert.equal(planTouchRecentFolder(many, 'C:\\new', 99).length, RECENT_FOLDERS_LIMIT)
  assert.deepEqual(planRemoveRecentFolder([{ path: 'a', name: 'a', openedAt: 1 }], 'a'), [])
})

test('planRecentFolderList：并入当前工作区且不重复', () => {
  const list = [{ path: 'C:\\old', name: 'old', openedAt: 1 }]
  const merged = planRecentFolderList(list, 'C:\\now', 5)
  assert.equal(merged[0].path, 'C:\\now', '当前工作区排最前')
  assert.equal(merged.length, 2)
  const already = planRecentFolderList(merged, 'C:\\now', 6)
  assert.equal(already.length, 2, '已在列表里就不再加一条')
  assert.equal(planRecentFolderList(list, null, 5).length, 1, '没有工作区时原样返回')
})

test('draftKeyFor：有路径按文件、没有按窗口槽位', () => {
  assert.equal(
    draftKeyFor('C:\\Docs\\Note.MD', 3),
    'file-' + encodeURIComponent('c:\\docs\\note.md')
  )
  assert.match(draftKeyFor(null, 2), /untitled-2/)
  assert.match(draftKeyFor(null, null), /untitled/)
})

test('restorableDraft：空/相同内容不打扰用户', () => {
  const draft = (over = {}) => ({
    key: 'k',
    path: 'C:\\a.md',
    content: '草稿正文',
    savedAt: 5000,
    ...over
  })
  assert.equal(restorableDraft(null, 'x', 'C:\\a.md', 1), false, '没有草稿')
  assert.equal(
    restorableDraft(draft({ content: 'same' }), 'same', 'C:\\a.md', 1),
    false,
    '内容相同'
  )
  assert.equal(restorableDraft(draft(), '正文', null, null), true, '未命名缓冲区只要内容不同就恢复')
  assert.equal(restorableDraft(draft(), '正文', 'C:\\b.md', 1), false, '路径不符（防撞键）')
  assert.equal(
    restorableDraft(draft(), '正文', 'C:\\a.md', 5000),
    false,
    '不比磁盘新（含 1s 容差）'
  )
  assert.equal(
    restorableDraft(draft({ savedAt: 9000 }), '正文', 'C:\\a.md', 5000),
    true,
    '确实更新'
  )
  assert.equal(restorableDraft(draft(), '正文', 'C:\\a.md', null), false, '拿不到 mtime 时不冒险')
})

test('docText：未命名文档的编码/行尾取设置默认值', () => {
  assert.equal(untitledEncoding('auto'), 'utf-8', 'auto 对新文件没得猜 → utf-8')
  assert.equal(untitledEncoding('gbk'), 'gbk')
  assert.equal(untitledEol('crlf'), 'crlf')
  assert.equal(untitledEol('lf'), 'lf')
  assert.equal(untitledEol(undefined), 'lf', '非法值退回 LF')
  assert.equal(untitledEol('CRLF'), 'lf', '大小写不匹配也算非法')
})

test('docText：编码显示名与历史时间格式', () => {
  assert.equal(encodingLabel('utf-8'), 'UTF-8')
  assert.equal(encodingLabel('gb18030'), 'GB18030')
  const t = formatHistoryTime(new Date(2026, 0, 2, 3, 4).getTime())
  assert.equal(t, '2026-01-02 03:04')
})
