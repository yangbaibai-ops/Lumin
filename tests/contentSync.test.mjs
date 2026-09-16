// 「编辑面 ⇄ 真源」单向数据流协议（src/renderer/src/lib/contentSync.ts）的单测。
//
// 这层决定的是**编辑器面板 / 源码 textarea / 代码块 CodeMirror 三者谁该跟着谁更新**。
// 收敛之前四套各自发明的判断（比字符串 + 600ms 静默窗 + 150ms 快照相等 + 切模式再比一次）
// 出过一串看着像玄学的 bug：快速回车丢字、切回原编码正文不刷新、分屏里停顿后的更新被吞掉。
// 所以这里的断言都对着「曾经出过的那些 bug 的形态」写，而不是对着实现写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRIVEN_SURFACES,
  createLedger,
  isOwnWrite,
  markApplied,
  shouldApply,
  staleSurfaces,
  write
} from '../src/renderer/src/lib/contentSync.ts'

test('新建账本：世代 0，两个命令式编辑面都已对齐', () => {
  const l = createLedger()
  assert.equal(l.rev, 0)
  assert.equal(l.author, 'external')
  assert.equal(staleSurfaces(l).length, 0)
})

test('外部整篇替换：所有编辑面都落后（哪怕文本没变也要重渲染）', () => {
  const l = createLedger()
  write(l, 'wysiwyg')
  markApplied(l, 'codeblock')
  assert.deepEqual(staleSurfaces(l), [])
  const rev = write(l, 'external')
  assert.equal(rev, l.rev)
  assert.equal(l.author, 'external')
  // 关键：内容可能一模一样（例如「按原编码重新解释」），但世代变了就必须换内容
  assert.deepEqual(staleSurfaces(l), ['wysiwyg', 'codeblock'])
})

test('Tiptap 自己写的：不回灌自己，源码面（声明式）不占 applied', () => {
  const l = createLedger()
  write(l, 'wysiwyg')
  assert.equal(shouldApply(l, 'wysiwyg'), false, '作者自己不该被回灌（否则光标会被重置）')
  assert.equal(isOwnWrite(l, 'wysiwyg'), true)
  assert.equal(isOwnWrite(l, 'source'), false)
})

test('源码 textarea 写的：Tiptap 落后 → 需要 setContent 一次', () => {
  const l = createLedger()
  markApplied(l, 'wysiwyg')
  write(l, 'source')
  assert.equal(shouldApply(l, 'wysiwyg'), true)
  assert.equal(staleSurfaces(l).includes('wysiwyg'), true)
  markApplied(l, 'wysiwyg')
  assert.equal(shouldApply(l, 'wysiwyg'), false, '对齐后不该再重复 setContent')
})

test('代码块 CodeMirror 写的：宿主 Tiptap 也一并算「已跟上」（它是子编辑面）', () => {
  const l = createLedger()
  write(l, 'codeblock')
  assert.equal(shouldApply(l, 'codeblock'), false, 'CM 不该被自己的写入重置（会丢输入）')
  assert.equal(
    shouldApply(l, 'wysiwyg'),
    false,
    'CM 的文本已经写回 Tiptap 节点，宿主再 setContent 会把光标踢出代码块'
  )
})

test('源码面写 → 代码块仍落后：源码改到代码块内部时 CM 必须重建', () => {
  const l = createLedger()
  write(l, 'source')
  assert.equal(shouldApply(l, 'codeblock'), true)
  assert.equal(shouldApply(l, 'wysiwyg'), true)
})

test('世代只增不减，每次写入正好 +1（账本可当版本号用）', () => {
  const l = createLedger()
  const seen = []
  for (const author of ['wysiwyg', 'source', 'codeblock', 'external', 'source']) {
    seen.push(write(l, author))
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5])
  assert.equal(l.rev, 5)
  assert.equal(l.author, 'source')
})

test('重复标记已对齐是幂等的', () => {
  const l = createLedger()
  write(l, 'source')
  markApplied(l, 'wysiwyg')
  markApplied(l, 'wysiwyg')
  markApplied(l, 'codeblock')
  assert.deepEqual(staleSurfaces(l), [])
})

test('两个命令式编辑面各记各的世代（不会互相顶掉）', () => {
  const l = createLedger()
  write(l, 'wysiwyg')
  markApplied(l, 'codeblock')
  write(l, 'source')
  markApplied(l, 'codeblock')
  assert.equal(shouldApply(l, 'wysiwyg'), true)
  assert.equal(shouldApply(l, 'codeblock'), false)
  assert.deepEqual(DRIVEN_SURFACES, ['wysiwyg', 'codeblock'])
})
