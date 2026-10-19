// 全局防卡死兜底：心跳超时 / 崩溃节流 / 同步阻塞哨兵 / 大文档与安全模式 / 纯文本兜底。
//
// 这些阈值都是验收口径的一部分（500ms 心跳、4.8s 超时、2s 冻结、30s 崩溃节流、
// 2MB / 5 万节点），所以全部做成纯函数用毫秒级单测钉住；端到端那一半见
// tools/_verify-freeze.js（真窗口里注阻塞 + Pege.crash）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CRASH_RELOAD_MAX_IN_WINDOW,
  CRASH_RELOAD_THROTTLE_MS,
  DOC_RISK_INCIDENTS,
  HEARTBEAT_TIMEOUT_MS,
  LARGE_DOC_BYTES,
  LARGE_DOC_NODES,
  detectFreezeGap,
  emptyDocRisk,
  estimateDocLoad,
  estimateDocNodes,
  heartbeatLiveness,
  isLargeDoc,
  liveDocRisk,
  noteDocIncident,
  planCrashReload,
  planDocOpen
} from '../src/shared/freeze.ts'
import { planPlainPaste } from '../src/renderer/src/lib/plainPasteCore.ts'
import { plainTextFallback } from '../src/renderer/src/lib/editor/pasteGuardCore.ts'

test('心跳：第一次心跳之前不判超时（启动慢不是卡死）', () => {
  const before = heartbeatLiveness(10_000, 0)
  assert.equal(before.primed, false)
  assert.equal(before.stale, false)
  assert.equal(before.ageMs, 0)
})

test('心跳：4.8s 内算活着，超过才判无响应（边界取严格大于）', () => {
  const at = 1_000_000
  const fresh = heartbeatLiveness(at, at - HEARTBEAT_TIMEOUT_MS)
  assert.equal(fresh.primed, true)
  assert.equal(fresh.stale, false, '恰好 4800ms 不该判死（检测定时器还要留粒度余量）')
  assert.equal(fresh.ageMs, HEARTBEAT_TIMEOUT_MS)

  const stale = heartbeatLiveness(at, at - HEARTBEAT_TIMEOUT_MS - 1)
  assert.equal(stale.stale, true)
  assert.equal(stale.ageMs, HEARTBEAT_TIMEOUT_MS + 1)
})

test('心跳：时钟回拨（now < last）按 0 处理，不产生负 age', () => {
  assert.equal(heartbeatLiveness(100, 500).ageMs, 0)
})

test('崩溃节流：30 秒内第二次崩溃不自动重载，给出还要等多久', () => {
  const now = 5_000_000
  assert.deepEqual(planCrashReload(now, []), { reload: true, reason: 'ok', retryInMs: 0 })

  const recent = planCrashReload(now, [now - 10_000])
  assert.equal(recent.reload, false)
  assert.equal(recent.reason, 'throttled-recent')
  assert.equal(recent.retryInMs, CRASH_RELOAD_THROTTLE_MS - 10_000)

  // 刚好过了节流窗：放行
  assert.equal(planCrashReload(now, [now - CRASH_RELOAD_THROTTLE_MS]).reload, true)
})

test('崩溃节流：5 分钟窗口内超过上限后拒绝（慢循环也拦得住）', () => {
  const now = 9_000_000
  const history = Array.from(
    { length: CRASH_RELOAD_MAX_IN_WINDOW },
    (_, i) => now - 60_000 * (i + 1)
  )
  // 最后一次在 60s 前（已过 30s 节流），但窗口内次数已达上限
  const decision = planCrashReload(now, history)
  assert.equal(decision.reload, false)
  assert.equal(decision.reason, 'throttled-window')
  assert.ok(decision.retryInMs > 0)
})

test('崩溃节流：很久以前的记录不再参与判定', () => {
  const now = 20_000_000
  assert.equal(planCrashReload(now, [now - 10 * 60_000, now - 60 * 60_000]).reload, true)
})

test('哨兵：相邻两次 tick 间隔 >2s 记一条 freeze（含时刻/时长/线索）', () => {
  const prev = 1_000_000
  assert.equal(detectFreezeGap(prev, prev + 1_000), null, '正常 1s tick 不记')
  assert.equal(detectFreezeGap(0, prev + 5_000), null, '没有上一拍时不记')

  const record = detectFreezeGap(prev, prev + 3_000, { stackHint: 'lastHeavy=serialize' })
  assert.deepEqual(record, {
    at: prev + 3_000,
    durationMs: 3_000,
    stackHint: 'lastHeavy=serialize'
  })

  // 8s 阻塞：下一次 tick 的间隔就是 8s（阻塞时长的上界）
  assert.equal(detectFreezeGap(prev, prev + 8_000).durationMs, 8_000)
})

test('文档风险：第一次事故只记录，第二次连续事故才升级源码模式', () => {
  const first = noteDocIncident(null, 'crash', 1_000)
  assert.equal(first.incidents, 1)
  assert.equal(first.safeMode, false)
  assert.equal(first.lastKind, 'crash')

  const second = noteDocIncident(first, 'unresponsive', 2_000)
  assert.equal(second.incidents, DOC_RISK_INCIDENTS)
  assert.equal(second.safeMode, true)

  // 过期（30 天）后重新从 0 开始
  const expired = noteDocIncident(second, 'crash', 2_000 + 31 * 24 * 3600_000)
  assert.equal(expired.incidents, 1)
  assert.equal(expired.safeMode, false)
})

test('文档风险：过期记录读出来等于空记录', () => {
  const old = { at: 1_000, incidents: 3, safeMode: true, lastKind: 'crash' }
  assert.deepEqual(liveDocRisk(old, 1_000 + 31 * 24 * 3600_000), emptyDocRisk())
  assert.equal(liveDocRisk(old, 2_000).safeMode, true)
})

test('打开决策：风险优先于规模；大文档先问一句', () => {
  const safe = { at: Date.now(), incidents: 2, safeMode: true, lastKind: 'crash' }
  assert.equal(planDocOpen(safe, { bytes: 10, nodes: 1 }), 'source-risk')

  assert.equal(planDocOpen(null, { bytes: LARGE_DOC_BYTES + 1, nodes: 10 }), 'prompt-large')
  assert.equal(planDocOpen(null, { bytes: 10, nodes: LARGE_DOC_NODES + 1 }), 'prompt-large')
  assert.equal(planDocOpen(null, { bytes: 10, nodes: 10 }), 'normal')
})

test('大文档估算：UTF-8 字节 + 非空行节点（代码围栏整块算一个节点）', () => {
  const text = [
    '# 标题',
    '',
    '正文一行',
    '```js',
    'const a = 1',
    'const b = 2',
    '```',
    '结尾'
  ].join('\n')
  // 非空行：标题 / 正文 / fence / fence / 结尾 = 5（围栏内部两行不算独立节点）
  assert.equal(estimateDocNodes(text), 5)
  const load = estimateDocLoad(text)
  assert.equal(load.bytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(load.nodes, 5)
  assert.equal(isLargeDoc({ bytes: LARGE_DOC_BYTES, nodes: 1 }), false, '恰好 2MB 不提示')
  assert.equal(isLargeDoc({ bytes: LARGE_DOC_BYTES + 1, nodes: 1 }), true)
})

test('纯文本兜底：HTML 被剥成文字、空文本不产生插入', () => {
  const fallback = plainTextFallback('<table><tr><td>A</td><td>B</td></tr></table>', '表格 A\tB')
  assert.equal(fallback.text, '表格 A\tB')
  assert.equal(fallback.truncated, false)

  const fallbackNoText = plainTextFallback('<b>加粗</b>', '')
  assert.equal(fallbackNoText.text, '加粗')

  const huge = plainTextFallback('', 'x'.repeat(600 * 1024))
  assert.equal(huge.truncated, true)
  assert.ok(huge.text.length <= 512 * 1024)

  assert.deepEqual(planPlainPaste('a\r\nb'), { text: 'a\nb', insert: true })
  assert.deepEqual(planPlainPaste(''), { text: '', insert: false })
  assert.deepEqual(planPlainPaste(null), { text: '', insert: false })
})
