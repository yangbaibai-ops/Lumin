// 退出/关机路径的状态机（src/main/services/shutdown.ts）。
//
// 审计 §2 P2：「系统关机/注销路径未处理 —— 全仓无 `app.on('session-end')`」。
// 这条路上能做的只有"尽早通知所有窗口开始落盘"，而**通知一次**这件事必须是可靠的：
// 注销时 `session-end` 与 `before-quit` 可能先后到达，重复广播等于让每个窗口把
// `flushAll()` 跑两遍（多一次全量落盘 + 多一次草稿写盘，在最需要快的时候更慢）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginShutdown,
  onShutdown,
  resetShutdownForTest,
  shutdownReason
} from '../src/main/services/shutdown.ts'

test('beginShutdown：第一次生效、第二个原因不再触发（幂等）', () => {
  resetShutdownForTest()
  const seen = []
  onShutdown((r) => seen.push(r))
  assert.equal(shutdownReason(), null, '没开始时应当是 null')
  assert.equal(beginShutdown('session-end'), true)
  assert.equal(shutdownReason(), 'session-end')
  assert.equal(beginShutdown('before-quit'), false, '已经在退出：不该再广播一次')
  assert.equal(shutdownReason(), 'session-end', '第一个原因保留（它才是这次退出的来源）')
  assert.deepEqual(seen, ['session-end'])
})

test('onShutdown：可以取消订阅，取消后不再收到', () => {
  resetShutdownForTest()
  const seen = []
  const off = onShutdown((r) => seen.push(r))
  off()
  beginShutdown('before-quit')
  assert.deepEqual(seen, [])
})

test('某个监听器抛错不影响其它监听器（退出路径上必须尽力而为）', () => {
  resetShutdownForTest()
  const seen = []
  onShutdown(() => {
    throw new Error('boom')
  })
  onShutdown((r) => seen.push(r))
  assert.equal(beginShutdown('before-quit'), true)
  assert.deepEqual(seen, ['before-quit'])
})

test('resetShutdownForTest：把状态与订阅都清干净（只给测试用）', () => {
  resetShutdownForTest()
  const seen = []
  onShutdown((r) => seen.push(r))
  beginShutdown('session-end')
  resetShutdownForTest()
  assert.equal(shutdownReason(), null)
  // 复位后订阅也清掉了：再 begin 不会惊动上一轮留下的监听器
  beginShutdown('before-quit')
  assert.deepEqual(seen, ['session-end'])
})
