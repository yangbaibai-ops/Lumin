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
