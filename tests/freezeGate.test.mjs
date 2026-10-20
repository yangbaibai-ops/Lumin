// 「页面无响应」误报修复的纯判据单测：可见性暂停 / 恢复复位 / 窗口门控 / 开关 / 崩溃不受门控。
//
// 这些问题都是毫秒级算术（窗口隐不隐藏、lastBeat 有没有复位），端到端套件跑一次几十秒；
// 所以判据全部放在 shared/freeze.ts 的纯函数里，这里直接钉住语义：
//   * 隐藏 ⇒ 停心跳 + 通知主进程暂停；可见 ⇒ 复位计时 + 立刻补一拍 + 通知恢复；
//   * 窗口最小化/不可见 ⇒ 巡检 idle（哪怕心跳已经陈旧）；
//   * 恢复时 lastBeat 复位 ⇒ 第一拍一定 alive，绝不会拿 20s 的旧心跳弹框；
//   * 设置关闭 ⇒ idle；重新打开且复位后，真卡死仍会 prompt；
//   * 崩溃恢复的节流决策**不看**开关/暂停（首次崩溃永远自动重载一次）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEARTBEAT_TIMEOUT_MS,
  freezeWindowPauseReason,
  planCrashRecovery,
  planFreezeCheck,
  planHeartbeatVisibility,
  planWatchResume
} from '../src/shared/freeze.ts'

const base = {
  nowMs: 1_000_000,
  lastHeartbeatAt: 1_000_000 - (HEARTBEAT_TIMEOUT_MS + 5_000),
  enabled: true,
  paused: false,
  reloading: false,
  episodeOpen: false
}

test('可见性：hidden 停心跳并通知暂停；visible 复位计时并立刻补一拍', () => {
  assert.deepEqual(planHeartbeatVisibility('hidden'), {
    running: false,
    sendNow: false,
    resetTimer: false,
    notifyMain: 'pause'
  })
  assert.deepEqual(planHeartbeatVisibility('visible'), {
    running: true,
    sendNow: true,
    resetTimer: true,
    notifyMain: 'resume'
  })
})

test('窗口门控：最小化 / 不可见都要暂停（两者都会让 Chromium 停定时器）', () => {
  assert.equal(freezeWindowPauseReason({ minimized: true, visible: true }), 'window-minimized')
  assert.equal(freezeWindowPauseReason({ minimized: false, visible: false }), 'window-hidden')
  assert.equal(freezeWindowPauseReason({ minimized: false, visible: true }), null)

  // 哪怕心跳已经"过期 5s"，暂停态也必须 idle（最小化 20s 后再恢复不能弹）。
  assert.deepEqual(planFreezeCheck({ ...base, paused: true }), { action: 'idle', reason: 'paused' })
})

test('恢复复位：lastBeat 置为 now 后第一拍 alive，之后真卡死仍会 prompt', () => {
  const resumed = planWatchResume(base.nowMs)
  assert.equal(resumed.lastHeartbeatAt, base.nowMs)
  assert.equal(resumed.paused, false)

  const firstTick = planFreezeCheck({ ...base, lastHeartbeatAt: resumed.lastHeartbeatAt })
  assert.deepEqual(firstTick, { action: 'idle', reason: 'alive' })

  // 恢复后渲染层真卡死：4.6s 后仍然抓到（没有把功能删掉）。
  const frozenAfterResume = planFreezeCheck({
    ...base,
    lastHeartbeatAt: resumed.lastHeartbeatAt,
    nowMs: resumed.lastHeartbeatAt + HEARTBEAT_TIMEOUT_MS + 1
  })
  assert.equal(frozenAfterResume.action, 'prompt')
  assert.equal(frozenAfterResume.ageMs, HEARTBEAT_TIMEOUT_MS + 1)
})

test('设置开关：关闭 = 不巡检不弹；重新打开且 lastBeat 复位后仍能报真卡死', () => {
  assert.deepEqual(planFreezeCheck({ ...base, enabled: false }), {
    action: 'idle',
    reason: 'disabled'
  })
  assert.deepEqual(planFreezeCheck({ ...base, enabled: true, lastHeartbeatAt: base.nowMs }), {
    action: 'idle',
    reason: 'alive'
  })
  assert.equal(
    planFreezeCheck({
      ...base,
      enabled: true,
      lastHeartbeatAt: base.nowMs - HEARTBEAT_TIMEOUT_MS - 1
    }).action,
    'prompt'
  )
})

test('崩溃恢复不受门控影响：关闭提示 / 窗口暂停时首次崩溃仍自动重载', () => {
  const now = 2_000_000
  for (const gate of [
    { enabled: false, paused: false },
    { enabled: true, paused: true },
    { enabled: false, paused: true }
  ]) {
    assert.deepEqual(planCrashRecovery(now, [], gate), {
      reload: true,
      reason: 'ok',
      retryInMs: 0
    })
  }
  // 节流规则仍然照旧（30s 内第二次不自动重载）——门控不能把节流也绕过。
  const throttled = planCrashRecovery(now, [now - 10_000], { enabled: false, paused: true })
  assert.equal(throttled.reload, false)
  assert.equal(throttled.reason, 'throttled-recent')
})

test('心跳未 primed（启动/reload 后）时不判超时，避免重载后立刻误报', () => {
  assert.deepEqual(planFreezeCheck({ ...base, lastHeartbeatAt: 0 }), {
    action: 'idle',
    reason: 'unprimed'
  })
  assert.deepEqual(planFreezeCheck({ ...base, reloading: true }), {
    action: 'idle',
    reason: 'reloading'
  })
})
