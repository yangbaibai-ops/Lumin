// 未命名草稿的归属判定（shared/drafts.ts 的 planUntitledDraft）
//
// 这块逻辑连续出过三次真 bug（每次都是用户先发现）：
//   §4.44 空草稿被当成「有未保存内容」→ 每次开窗都弹横幅
//   §4.45 单独关窗清掉槽位 → 重启后只剩文件夹、文档是「虚空」未命名
//   §4.49 新窗口认领了别的窗口的草稿 → 按 Ctrl+N 却弹「检测到上次未保存的内容」
// 所以这里把三种来源（我自己的 / 无主的 / 别人留在我这格的）钉死成矩阵。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planUntitledDraft } from '../src/shared/drafts.ts'

const draft = (content, ownerUid) => ({ key: 'x', path: null, content, savedAt: 1000, ownerUid })

/** 常见上下文：本窗口是槽位 1、uid 'me'；槽位 0 的窗口还活着 */
const ctx = (over = {}) => ({
  ownKey: 'untitled-1',
  myUid: 'me',
  liveUids: ['other-live'],
  liveSlots: [0],
  mayClaimOrphan: false,
  ...over
})

const ops = (steps) =>
  steps.map((s) =>
    s.op === 'show' ? 'show' : s.op === 'purge' ? `purge:${s.key}` : `${s.op}:${s.from}`
  )

test('自己的草稿（uid 相同）→ 直接展示', () => {
  const steps = planUntitledDraft(ctx(), [{ key: 'untitled-1', data: draft('我的正文', 'me') }])
  assert.deepEqual(ops(steps), ['show'])
  assert.equal(steps[0].draft.content, '我的正文')
})

test('自己的空草稿 → 删掉，且不展示', () => {
  const steps = planUntitledDraft(ctx(), [{ key: 'untitled-1', data: draft('   ', 'me') }])
  assert.deepEqual(ops(steps), ['purge:untitled-1'])
})

test('空草稿 / 坏文件在扫描中被清掉（旧版无条件写盘留下的噪声）', () => {
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-2', data: draft('', 'gone') },
    { key: 'untitled-3', data: null },
    { key: 'untitled-4', data: draft('真内容', 'gone') }
  ])
  assert.deepEqual(ops(steps), ['purge:untitled-2', 'purge:untitled-3', 'adopt:untitled-4'])
})

test('无主草稿：只有启动窗口认领（Ctrl+N 的新窗口不认领，也不吃掉它）', () => {
  const onDisk = [{ key: 'untitled-9', data: draft('上次没保存的', 'a-gone-window') }]
  assert.deepEqual(ops(planUntitledDraft(ctx(), onDisk)), [])
  assert.deepEqual(ops(planUntitledDraft(ctx({ mayClaimOrphan: true }), onDisk)), [
    'adopt:untitled-9'
  ])
})

test('别人还活着的窗口的草稿：任何窗口都不认领', () => {
  const onDisk = [{ key: 'untitled-0', data: draft('别人的正文', 'other-live') }]
  assert.deepEqual(ops(planUntitledDraft(ctx({ mayClaimOrphan: true }), onDisk)), [])
})

test('旧数据没有 uid：按「槽位还占着吗」判断归属', () => {
  const liveSlot = [{ key: 'untitled-0', data: draft('旧草稿', undefined) }]
  assert.deepEqual(ops(planUntitledDraft(ctx({ mayClaimOrphan: true }), liveSlot)), [])
  const freeSlot = [{ key: 'untitled-7', data: draft('旧草稿', undefined) }]
  assert.deepEqual(ops(planUntitledDraft(ctx({ mayClaimOrphan: true }), freeSlot)), [
    'adopt:untitled-7'
  ])
})

test('别人留在我这一格的正文：不展示、不覆盖，挪到停放键（槽位号被复用时的场景）', () => {
  const steps = planUntitledDraft(ctx(), [
    { key: 'untitled-1', data: draft('上一个住户的正文', 'someone-else') }
  ])
  assert.deepEqual(ops(steps), ['park:untitled-1'])
})

test('停放后仍可被启动窗口认领（同一批输入里两步都给）', () => {
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-1', data: draft('上一个住户的正文', 'someone-else') }
  ])
  assert.deepEqual(ops(steps), ['park:untitled-1'])
  // park 之后那份落在停放键上，下一轮（或本轮的后续）按「无主」认领
  const next = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-orphan', data: draft('上一个住户的正文', 'someone-else') }
  ])
  assert.deepEqual(ops(next), ['adopt:untitled-orphan'])
})

test('历史遗留键 untitled 与停放键都算未命名草稿（升级后能被认领一次）', () => {
  for (const key of ['untitled', 'untitled-orphan']) {
    const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
      { key, data: draft('遗留正文', 'old-run') }
    ])
    assert.deepEqual(ops(steps), [`adopt:${key}`], key)
  }
})

test('多个无主草稿 → 只认领最新的一份（其余留在盘上）', () => {
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-3', data: { ...draft('旧', 'gone-1'), savedAt: 100 } },
    { key: 'untitled-4', data: { ...draft('新', 'gone-2'), savedAt: 900 } }
  ])
  assert.deepEqual(ops(steps), ['adopt:untitled-4'])
})

test('文件草稿（file-<路径>）不参与未命名草稿的判定', () => {
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'file-d_3a_5cx_md', data: draft('某篇文档的草稿', 'gone') }
  ])
  assert.deepEqual(ops(steps), [])
})
