// 路径工具（renderer/lib/pathUtils.ts）：整个侧栏「露出文件 / 判断是否在工作区内」都靠它
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorDirs,
  isInside,
  normPath,
  parentDir,
  samePath
} from '../src/renderer/src/lib/pathUtils.ts'
import { migratePathWithin } from '../src/shared/paths.ts'

test('normPath：分隔符归一 + 去尾分隔符 + 小写', () => {
  assert.equal(normPath('D:/Notes/Sub/'), 'd:\\notes\\sub')
  assert.equal(normPath('D:\\Notes'), 'd:\\notes')
})

test('samePath：大小写与分隔符不敏感', () => {
  assert.equal(samePath('D:\\A\\b.md', 'd:/a/B.MD'), true)
  assert.equal(samePath('D:\\A\\b.md', 'D:\\A\\c.md'), false)
  assert.equal(samePath(null, 'D:\\a'), false)
})

test('isInside：按目录边界比较（C:\\Docs 不包含 C:\\Docs2）', () => {
  assert.equal(isInside('C:\\Docs', 'C:\\Docs\\a.md'), true)
  assert.equal(isInside('C:\\Docs', 'C:\\Docs2\\a.md'), false)
  assert.equal(isInside('C:\\Docs', 'C:\\Docs'), true)
  assert.equal(isInside(null, 'C:\\Docs\\a.md'), false)
})

test('parentDir：盘根与裸文件名两个边界', () => {
  assert.equal(parentDir('C:\\x'), 'C:\\')
  assert.equal(parentDir('a.md'), '')
  assert.equal(parentDir('D:\\a\\b\\c.md'), 'D:\\a\\b')
})

test('ancestorDirs：从根到文件的父目录链（含根）', () => {
  assert.deepEqual(ancestorDirs('D:\\ws', 'D:\\ws\\a.md'), ['D:\\ws'])
  assert.deepEqual(ancestorDirs('D:\\ws', 'D:\\ws\\x\\y\\z.md'), [
    'D:\\ws',
    'D:\\ws\\x',
    'D:\\ws\\x\\y'
  ])
  assert.deepEqual(ancestorDirs('D:\\ws', 'D:\\other\\z.md'), [])
})

// migratePathWithin（shared/paths.ts）：目录改名时把子孙路径搬到新目录下。
// 这条判据的两种错法都很坏：用字符串替换首段会把同名前缀目录（`sub` vs `sub2`）一起改掉；
// 漏搬则会让索引/历史/最近列表继续指着旧路径（审计 §2 P1 第 124 条）。
test('migratePathWithin：按目录边界搬相对后缀，同名前缀目录不受影响', () => {
  assert.equal(
    migratePathWithin('D:\\ws\\sub\\a.md', 'D:\\ws\\sub', 'D:\\ws\\renamed'),
    'D:\\ws\\renamed\\a.md'
  )
  assert.equal(
    migratePathWithin('D:\\ws\\sub\\deep\\b.md', 'D:\\ws\\sub', 'D:\\ws\\renamed'),
    'D:\\ws\\renamed\\deep\\b.md'
  )
  // 目录自身
  assert.equal(
    migratePathWithin('D:\\ws\\sub', 'D:\\ws\\sub', 'D:\\ws\\renamed'),
    'D:\\ws\\renamed'
  )
  // 同名前缀：`sub2` 不是 `sub` 的子项
  assert.equal(migratePathWithin('D:\\ws\\sub2\\x.md', 'D:\\ws\\sub', 'D:\\ws\\renamed'), null)
  // 完全不相干
  assert.equal(migratePathWithin('D:\\other\\x.md', 'D:\\ws\\sub', 'D:\\ws\\renamed'), null)
  // 大小写不敏感（Windows），但**保留原路径自己的大小写**
  assert.equal(
    migratePathWithin('d:\\WS\\SUB\\A.MD', 'D:\\ws\\sub', 'D:\\ws\\renamed'),
    'D:\\ws\\renamed\\A.MD'
  )
  // 新目录带尾分隔符也算同一个意思
  assert.equal(
    migratePathWithin('D:\\ws\\sub\\a.md', 'D:\\ws\\sub\\', 'D:\\ws\\r\\'),
    'D:\\ws\\r\\a.md'
  )
})
