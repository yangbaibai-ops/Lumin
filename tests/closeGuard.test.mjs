// 关窗兜底的时间判据（src/shared/closeGuard.ts）。
//
// 审计 §2 P1 的原话是「关窗兜底 2.5s 强杀」：慢盘/大文件下 `flushAll()` 没跑完窗口就没了，
// 丢的正是"用户以为已经保存"的那一段。改成"心跳停了才强杀"之后，判据本身必须可测 ——
// 判错的两种后果都要命：太早 = 丢字（回到原缺陷），太晚 = 窗口关不掉（渲染进程挂死时）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSE_FALLBACK_MAX_MS,
  CLOSE_FALLBACK_MS,
  noteCloseProgress,
  shouldForceClose
} from '../src/shared/closeGuard.ts'

const T0 = 1_800_000_000_000
/** 形状与 CloseGuardState 一致（.mjs 里不能写 TS 类型标注） */
const state = () => ({ startedAtMs: T0, lastProgressMs: T0 })

test('刚开始关窗：不许立刻强杀（要给渲染层落盘的机会）', () => {
  assert.equal(shouldForceClose(state(), T0).force, false)
  assert.equal(shouldForceClose(state(), T0 + CLOSE_FALLBACK_MS - 1).force, false)
})

test('没有心跳：到点就强杀，并说明是 stalled', () => {
  const d = shouldForceClose(state(), T0 + CLOSE_FALLBACK_MS)
  assert.equal(d.force, true)
  assert.equal(d.reason, 'stalled')
  assert.equal(d.waitedMs, CLOSE_FALLBACK_MS)
})

test('有心跳：只要还在落盘就一直等（每次心跳都重置计时）', () => {
  const s = state()
  // 每 1 秒来一次心跳，持续 20 秒 —— 一直不该强杀
  for (let t = 1000; t <= 20_000; t += 1000) {
    noteCloseProgress(s, T0 + t)
    assert.equal(shouldForceClose(s, T0 + t).force, false, `t=${t}`)
  }
  // 心跳停了以后，再等满一个窗口才强杀
  const last = T0 + 20_000
  assert.equal(shouldForceClose(s, last + CLOSE_FALLBACK_MS - 1).force, false)
  assert.equal(shouldForceClose(s, last + CLOSE_FALLBACK_MS).force, true)
})

test('总时长有硬上限：心跳不停也不许无限等（挂死的渲染进程不能把窗口顶住）', () => {
  const s = state()
  const at = T0 + CLOSE_FALLBACK_MAX_MS
  noteCloseProgress(s, at - 1) // 心跳一直很新鲜
  const d = shouldForceClose(s, at)
  assert.equal(d.force, true, '到总上限必须放行')
  assert.equal(d.reason, 'timeout')
})

test('时钟被往回调时不强杀（时间差为负 = 判据不成立）', () => {
  assert.equal(shouldForceClose(state(), T0 - 5000).force, false)
})

test('心跳时间戳坏掉（NaN）时按"没有心跳"处理：宁可按时兜底，也不要永远关不掉', () => {
  const s = state()
  s.lastProgressMs = Number.NaN
  assert.equal(shouldForceClose(s, T0 + CLOSE_FALLBACK_MS).force, true)
})

test('noteCloseProgress 原地更新并返回同一个对象（主进程那边的用法）', () => {
  const s = state()
  assert.equal(noteCloseProgress(s, T0 + 1234), s)
  assert.equal(s.lastProgressMs, T0 + 1234)
  assert.equal(s.startedAtMs, T0, '开始时刻不该被心跳改掉')
})

test('两个常量之间的关系稳定（兜底窗口必须小于总上限，否则总上限形同虚设）', () => {
  assert.ok(CLOSE_FALLBACK_MS > 0 && CLOSE_FALLBACK_MS <= 10_000)
  assert.ok(CLOSE_FALLBACK_MAX_MS >= 4 * CLOSE_FALLBACK_MS)
})
