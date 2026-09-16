// 会话恢复计划（shared/session.ts 的 planRestoreFromSlots）
//
// 语义来自踩过的坑（manual §4.45）：单独关窗不能删槽位（否则重启只有文件夹、文档是「虚空」未命名）；
// 但「挨个关窗」与「整体退出」必须区分处理，且最后关掉的那个窗口才能回来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRestoreFromSlots } from '../src/shared/session.ts'

const slot = (path, over = {}) => ({ path, folder: null, savedAt: 1000, ...over })
const idx = (plan) => plan.windows.map((w) => w.index)

test('整体退出：活着的窗口全部恢复，按「最近用过」排序', () => {
  const plan = planRestoreFromSlots(
    [slot('a.md', { savedAt: 100 }), null, slot('b.md', { savedAt: 900 })],
    5
  )
  assert.deepEqual(idx(plan), [2, 0])
  assert.deepEqual(plan.dropClosed, [])
  assert.deepEqual(plan.unmarkClosed, [])
})

test('单独关窗 + 还有窗口活着退出：只恢复活着的，作废被关掉的那条记录', () => {
  const plan = planRestoreFromSlots(
    [slot('a.md'), slot('closed.md', { closed: true, closedAt: 5000 })],
    5
  )
  assert.deepEqual(idx(plan), [0])
  assert.deepEqual(plan.dropClosed, [1])
})

test('窗口被挨个关光：只恢复最后关掉的那一个，并摘掉它的 closed 标记', () => {
  const plan = planRestoreFromSlots(
    [
      slot('first-closed.md', { closed: true, closedAt: 100 }),
      null,
      slot('last-closed.md', { closed: true, closedAt: 900 })
    ],
    5
  )
  assert.deepEqual(idx(plan), [2])
  assert.deepEqual(plan.dropClosed, [])
  assert.deepEqual(plan.unmarkClosed, [2])
  assert.equal(plan.windows[0].slot.path, 'last-closed.md')
})

test('没有 closed 信息时以 savedAt 决定「最后一个」', () => {
  const plan = planRestoreFromSlots(
    [
      slot('older.md', { closed: true, savedAt: 100 }),
      slot('newer.md', { closed: true, savedAt: 800 })
    ],
    5
  )
  assert.deepEqual(idx(plan), [1])
})

test('空槽位（既无文档也无文件夹）不参与恢复', () => {
  const plan = planRestoreFromSlots([{ path: null, folder: null, savedAt: 1 }, null], 5)
  assert.deepEqual(idx(plan), [])
})

test('只开着文件夹的窗口也算「有内容」，可被恢复', () => {
  const plan = planRestoreFromSlots([{ path: null, folder: 'D:\\ws', savedAt: 5 }], 5)
  assert.deepEqual(idx(plan), [0])
})

test('超过上限时截断（避免上次开一堆窗口导致启动风暴）', () => {
  const slots = Array.from({ length: 9 }, (_, i) => slot(`f${i}.md`, { savedAt: i }))
  const plan = planRestoreFromSlots(slots, 3)
  assert.equal(plan.windows.length, 3)
  assert.deepEqual(idx(plan), [8, 7, 6]) // 最近用过的优先
})

test('savedAt 相同时按槽位号稳定排序（不依赖引擎的排序稳定性）', () => {
  const plan = planRestoreFromSlots([slot('a', { savedAt: 5 }), slot('b', { savedAt: 5 })], 5)
  assert.deepEqual(idx(plan), [0, 1])
})

test('全空 → 空计划（调用方会建一个全新窗口）', () => {
  const plan = planRestoreFromSlots([null, null], 5)
  assert.deepEqual(plan.windows, [])
  assert.deepEqual(plan.dropClosed, [])
  assert.deepEqual(plan.unmarkClosed, [])
})
