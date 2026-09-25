// 本地历史策略（src/shared/history.ts）的单测。
// 这条是数据安全的兜底：策略判错 = 要么磁盘被历史表吃满，要么用户想回滚时发现快照没了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_KEEP_NEWEST_PER_FILE,
  HISTORY_LIMIT_PER_FILE,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_BYTES,
  historyPreview,
  planHistoryPrune
} from '../src/shared/history.ts'
import { defaultSettings } from '../src/shared/defaults.ts'

test('默认设置：历史默认开，策略与 shared/history 的常量一致', () => {
  assert.equal(defaultSettings.historyEnabled, true, '数据安全默认开')
  assert.equal(defaultSettings.historyLimitPerFile, HISTORY_LIMIT_PER_FILE)
  assert.equal(defaultSettings.historyMaxAgeDays, HISTORY_MAX_AGE_MS / (24 * 60 * 60 * 1000))
  assert.ok(defaultSettings.historyLimitPerFile > HISTORY_KEEP_NEWEST_PER_FILE)
})

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

test('historyPreview：取首个有内容的行、去 Markdown 标记、截断', () => {
  assert.equal(historyPreview('# 标题\n\n正文'), '标题')
  assert.equal(historyPreview('> 引用第一行\n后面的'), '引用第一行')
  assert.equal(historyPreview('- 列表项'), '列表项')
  assert.equal(historyPreview('\n\n   \n真正的第一行'), '真正的第一行')
  assert.equal(historyPreview(''), '')
  const long = historyPreview('あ'.repeat(200), 10)
  assert.equal(long.length, 11, '截断后带一个省略号')
  assert.ok(long.endsWith('…'))
})

test('planHistoryPrune：单文件超过上限就丢最老的', () => {
  const now = 1_000 * DAY
  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    path: 'a.md',
    savedAt: now - i * HOUR
  }))
  const drop = planHistoryPrune(entries, { limitPerFile: 3, maxAgeMs: 365 * DAY, now })
  assert.deepEqual(
    drop.sort((a, b) => a - b),
    [4, 5],
    '丢最老的两条'
  )
})

test('planHistoryPrune：太老的丢掉，但每个文件至少留最新几条', () => {
  const now = 100 * DAY
  const entries = [
    { id: 1, path: 'a.md', savedAt: now - HOUR },
    { id: 2, path: 'a.md', savedAt: now - 2 * HOUR },
    { id: 3, path: 'a.md', savedAt: now - 3 * HOUR },
    { id: 4, path: 'a.md', savedAt: now - 40 * DAY },
    { id: 5, path: 'b.md', savedAt: now - 50 * DAY }
  ]
  const drop = planHistoryPrune(entries, { maxAgeMs: 30 * DAY, now })
  assert.ok(!drop.includes(3), `最新 ${HISTORY_KEEP_NEWEST_PER_FILE} 条要留下`)
  assert.ok(drop.includes(4), 'a.md 第 4 老、超出保留条数 → 丢')
  // b.md 只有一条：虽然很老，但它**是该文件最新的那一版** —— 数据安全的优先级高于省空间，
  // 全库膨胀交给 maxTotal 兜底（见下一个用例）
  assert.ok(!drop.includes(5), '每个文件的最新几条不受年龄限制')
})

test('planHistoryPrune：全库总量封顶时丢最老的，不动最新的', () => {
  const now = 10 * DAY
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    path: `f${i}.md`,
    savedAt: now - i * HOUR
  }))
  const drop = planHistoryPrune(entries, { maxTotal: 4, maxAgeMs: 365 * DAY, now })
  assert.equal(drop.length, 6)
  assert.ok(!drop.includes(1) && !drop.includes(4), '最新的四条留下')
  assert.ok(drop.includes(10), '最老的丢掉')
})

test('planHistoryPrune：边界（空表 / 恰好等于上限 / 同一时刻）', () => {
  assert.deepEqual(planHistoryPrune([], { now: 0 }), [])
  const now = 5 * DAY
  const same = [
    { id: 1, path: 'a.md', savedAt: now },
    { id: 2, path: 'a.md', savedAt: now }
  ]
  assert.deepEqual(
    planHistoryPrune(same, { limitPerFile: 2, maxAgeMs: DAY, now }),
    [],
    '同一时刻且未超限'
  )
  const over = [
    { id: 1, path: 'a.md', savedAt: now },
    { id: 2, path: 'a.md', savedAt: now },
    { id: 3, path: 'a.md', savedAt: now }
  ]
  assert.deepEqual(
    planHistoryPrune(over, { limitPerFile: 2, maxAgeMs: DAY, now }),
    [1],
    '同一时刻按 id 兜底：留下后写入的那两条'
  )
})

// ─── 字节上限（审计 §2 P1：以前只按条数封顶，一条快照可能几百 KB）──────────────
test('planHistoryPrune：全库字节超限时从最老的开始丢', () => {
  const now = 10 * DAY
  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    path: 'a.md',
    savedAt: now - i * HOUR,
    bytes: 1000
  }))
  // 上限 3000 字节 → 只能留 3 条（最新的三条：id 1/2/3）
  assert.deepEqual(
    planHistoryPrune(entries, { maxBytes: 3000, maxTotal: 999, now }).sort((a, b) => a - b),
    [4, 5]
  )
})

test('planHistoryPrune：字节上限是硬闸（不看 keepNewestPerFile）', () => {
  const now = 10 * DAY
  // 单文件 4 条、每条 1000 字节、上限 1500：哪怕 keepNewest=3 也只剩 1 条
  const entries = Array.from({ length: 4 }, (_, i) => ({
    id: i + 1,
    path: 'a.md',
    savedAt: now - i * HOUR,
    bytes: 1000
  }))
  const drop = planHistoryPrune(entries, {
    maxBytes: 1500,
    maxTotal: 999,
    keepNewestPerFile: 3,
    now
  })
  assert.deepEqual(
    drop.sort((a, b) => a - b),
    [2, 3, 4]
  )
})

test('planHistoryPrune：没有 bytes 字段时字节那条不误删（缺省 0）', () => {
  const now = 10 * DAY
  const entries = [
    { id: 1, path: 'a.md', savedAt: now },
    { id: 2, path: 'a.md', savedAt: now - HOUR }
  ]
  assert.deepEqual(planHistoryPrune(entries, { maxBytes: 1, now }), [], '算不出字节就不删')
  assert.ok(HISTORY_MAX_BYTES >= 16 * 1024 * 1024, '字节上限不该小于 16MB（要能留住几天的几版）')
})
