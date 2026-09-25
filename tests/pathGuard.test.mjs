// 主进程的工作区逃逸护栏（src/main/pathGuard.ts）：**以前没有任何测试**。
//
// 审计 §10「重复实现」的原话：`isInside` 是"工作区逃逸"护栏（`assertWorkspacePath` 用它），
// 而 `tests/` 里只引用了渲染层那份 —— 主进程那份（真正拦人的那份）零覆盖。
//
// 这条测试的价值全在**负例**上：`isInside` 写错的典型后果不是"少拦一个"，
// 而是"看起来拦住了、其实用 `..` 或同名前缀绕过去了"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInside } from '../src/main/pathGuard.ts'

test('isInside：正常工作区内的路径放行（含根自身、含子目录）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws'), true)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\a.md'), true)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\notes\\deep\\a.md'), true)
  // 分隔符混用也算同一个位置
  assert.equal(isInside('D:\\ws', 'D:/ws/notes/a.md'), true)
  // Windows 大小写不敏感
  assert.equal(isInside('D:\\WS', 'd:\\ws\\a.md'), true)
})

test('isInside：`..` 逃逸必须被拦（这是护栏的核心）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws\\..\\evil.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\a\\..\\..\\evil.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\..\\..\\Windows\\system32\\x.dll'), false)
  // 相对形式的越界
  assert.equal(isInside('D:\\ws', '..\\evil.md'), false)
})

test('isInside：同名前缀不算内部（`D:\\ws2` 不是 `D:\\ws` 的子目录）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws2\\a.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws-other\\a.md'), false)
})

test('isInside：别的盘符一律拒绝', () => {
  assert.equal(isInside('D:\\ws', 'C:\\ws\\a.md'), false)
})

test('isInside：目录自身后面多一个分隔符也算自身', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws\\'), true)
})
