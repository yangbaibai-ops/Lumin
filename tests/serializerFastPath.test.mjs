// 序列化器 `atBlank()` 快路径单测：语义与上游逐字等价 + 大文档不再二次增长
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MarkdownSerializerState } from 'prosemirror-markdown'
import {
  fastAtBlank,
  installFastMarkdownSerializer
} from '../src/renderer/src/lib/editor/serializerFastPath.ts'

/** 上游原实现（用作语义基准） */
const upstreamAtBlank = (out) => /(^|\n)$/.test(out)

test('fastAtBlank 与上游正则语义逐例一致', () => {
  const samples = ['', 'a', '\n', 'a\n', 'a\n\n', 'a\r\n', 'x '.repeat(3), 'a\nb', 'a\n ']
  for (const s of samples) {
    assert.equal(fastAtBlank(s), upstreamAtBlank(s), JSON.stringify(s))
  }
})

test('装上的快路径作用在真正的序列化器实例上（含 this.out 非字符串时的兜底）', () => {
  installFastMarkdownSerializer()
  const state = new MarkdownSerializerState({}, {}, {})
  state.out = ''
  assert.equal(state.atBlank(), true)
  state.out = 'hello'
  assert.equal(state.atBlank(), false)
  state.out = 'hello\n'
  assert.equal(state.atBlank(), true)
  // 非字符串（上游若改结构）：退回原实现，不抛异常
  state.out = undefined
  assert.equal(typeof state.atBlank(), 'boolean')
})

test('大文档：2000 次追加后判空的累计耗时远低于"每次拍平整串"', () => {
  installFastMarkdownSerializer()
  const state = new MarkdownSerializerState({}, {}, {})
  const chunk = `${'A'.repeat(4096)}\n`
  const t0 = performance.now()
  for (let i = 0; i < 2000; i += 1) {
    // 走真实序列化路径（write → flushClose → atBlank），而不是直接改 out
    state.write(chunk)
  }
  const ms = performance.now() - t0
  // 上游实现（每次 write 都对 ~8MB 的 cons string 跑正则）在本机是**几十秒**量级；
  // 这里给一个宽松上限：只要没退回二次增长就通过。
  assert.ok(ms < 1500, `atBlank 快路径累计 ${ms.toFixed(0)}ms（上限 1500ms）`)
  assert.equal(state.out.length, 2000 * (4096 + 1))
})
