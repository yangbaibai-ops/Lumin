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
import {
  DRAFT_GC_MAX_AGE_MS,
  DRAFT_MAX_TOTAL_BYTES,
  DRAFT_MAX_UNTITLED,
  DRAFT_MIN_KEEP,
  DRAFT_TMP_RE,
  FILE_DRAFT_PREFIX,
  fileDraftKey,
  isFileDraftKey,
  planDraftGc
} from '../src/shared/drafts.ts'

const draft = (content, ownerUid) => ({ key: 'x', path: null, content, savedAt: 1000, ownerUid })

/** 常见上下文：本窗口是槽位 1、uid 'me'；槽位 0 的窗口还活着；本窗口是**恢复出来的** */
const ctx = (over = {}) => ({
  ownKey: 'untitled-1',
  myUid: 'me',
  liveUids: ['other-live'],
  liveSlots: [0],
  mySlotRestored: true,
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

test('上一次运行留下的、**就是我这一格**的正文 → 直接展示（重启后 uid 必变，但槽位号是我的）', () => {
  // 这一条是本轮修掉的核心缺陷：旧实现把"uid 不同"一律当成"不是我写的"→ park，
  // 于是每个恢复出来的窗口都把自己的草稿挪到停放键，后面的窗口还会覆盖前面的，
  // 结果「谁的正文活下来」取决于停放顺序（多窗口下只剩一份）。
  const steps = planUntitledDraft(ctx(), [
    { key: 'untitled-1', data: draft('上次没保存的正文', 'gone') }
  ])
  assert.deepEqual(ops(steps), ['show'])
  assert.equal(steps[0].draft.content, '上次没保存的正文')
})

test('写它的窗口**还活着**（槽位被复用给另一个活窗口）→ 不展示、不覆盖，挪到停放键', () => {
  const steps = planUntitledDraft(ctx(), [
    { key: 'untitled-1', data: draft('另一个活窗口的正文', 'other-live') }
  ])
  assert.deepEqual(ops(steps), ['park:untitled-1'])
})

test('槽位不是恢复来的（Ctrl+N 新窗口恰好拿到被复用的旧槽位号）→ 上一个住户的正文要挪走，不能弹', () => {
  // 这条守的是 §4.49 那个老 bug：用户明确按了 Ctrl+N 要一篇空白，
  // 不能因为"槽位号被复用、那一格还留着别人的草稿"而弹「检测到上次未保存的内容」。
  const steps = planUntitledDraft(ctx({ mySlotRestored: false, mayClaimOrphan: false }), [
    { key: 'untitled-1', data: draft('上一个住户的正文', 'gone') }
  ])
  assert.deepEqual(ops(steps), ['park:untitled-1'])
})

test('停放后仍可被启动窗口认领（同一批输入里两步都给）', () => {
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-1', data: draft('另一个活窗口的正文', 'other-live') }
  ])
  assert.deepEqual(ops(steps), ['park:untitled-1'])
  // park 之后那份落在停放键上，下一轮（或本轮的后续）按「无主」认领
  const next = planUntitledDraft(ctx({ mayClaimOrphan: true }), [
    { key: 'untitled-orphan', data: draft('另一个活窗口的正文', 'other-live') }
  ])
  assert.deepEqual(ops(next), ['adopt:untitled-orphan'])
})

test('本次要恢复的槽位（plannedSlots）→ 启动窗口不许抢它（窗口只是还没建出来）', () => {
  const onDisk = [
    { key: 'untitled-2', data: draft('还没建出来的那个窗口的正文', 'gone') },
    { key: 'untitled-orphan', data: draft('真正的无主正文', 'gone-2') }
  ]
  const steps = planUntitledDraft(ctx({ mayClaimOrphan: true, plannedSlots: [0, 2] }), onDisk)
  assert.deepEqual(ops(steps), ['adopt:untitled-orphan'])
})

test('带序号的停放键也算未命名草稿（可以有多份，不再互相覆盖）', () => {
  for (const key of ['untitled-orphan', 'untitled-orphan-2', 'untitled-orphan-17', 'untitled']) {
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

// ─── 草稿目录的垃圾回收（审计 §2 P1：`userData/drafts` 只增不减）───────────────
//
// 这块的失败方式是**不可逆**的：判错一条就是删掉用户没保存过的正文。
// 所以负例（"不该删的"）比正例更重要，下面每条正例都配了对应的负例。

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

/** 造一个 GC 候选条目 */
const gcEntry = (name, key, ageDays, size = 100) => ({
  name,
  key,
  mtimeMs: NOW - ageDays * DAY,
  size
})

test('GC：写盘临时文件（*.tmp）无论多新都删 —— 它根本不是草稿，没人读得到它', () => {
  const plan = planDraftGc([gcEntry('a1b2c3d4e5f60718.json.deadbeef.tmp', null, 0)], NOW)
  assert.deepEqual(plan, [{ name: 'a1b2c3d4e5f60718.json.deadbeef.tmp', reason: 'tmp', size: 100 }])
})

test('GC：有磁盘正本的草稿超过 30 天才删（文档一保存它就被清，躺着说明早没用了）', () => {
  const old = gcEntry('abc.json', fileDraftKey('D:\\ws\\a.md'), 31)
  const edge = gcEntry('edge.json', fileDraftKey('D:\\ws\\b.md'), 30) // 刚好 30 天：留着
  const fresh = gcEntry('fresh.json', fileDraftKey('D:\\ws\\c.md'), 1)
  const plan = planDraftGc([old, edge, fresh], NOW)
  assert.deepEqual(
    plan.map((x) => [x.name, x.reason]),
    [['abc.json', 'stale-file']]
  )
})

test('GC：**未命名草稿永不按时间删**（那是没有磁盘正本的正文，用户唯一的一份）', () => {
  const entries = [
    gcEntry('u0.json', 'untitled-0', 400),
    gcEntry('u1.json', 'untitled-7', 400),
    gcEntry('orph.json', 'untitled-orphan', 400),
    gcEntry('orph2.json', 'untitled-orphan-2', 400),
    gcEntry('legacy.json', 'untitled', 400)
  ]
  assert.deepEqual(planDraftGc(entries, NOW), [])
})

test('GC：连 JSON 都解不开的旧文件才清（新草稿是原子写的，不会再产生截断文件）', () => {
  const brokenOld = gcEntry('broken.json', null, 31)
  const brokenNew = gcEntry('broken-new.json', null, 2)
  const plan = planDraftGc([brokenOld, brokenNew], NOW)
  assert.deepEqual(
    plan.map((x) => x.reason),
    ['unreadable']
  )
})

test('GC：不认识的键与非 .json 文件一律不碰（草稿目录里可能就是有别的东西）', () => {
  const entries = [
    gcEntry('whatever.json', 'some-other-key', 900),
    gcEntry('readme.txt', null, 900),
    gcEntry('noext', null, 900),
    gcEntry('a.json.bak', null, 900)
  ]
  assert.deepEqual(planDraftGc(entries, NOW), [])
})

test('GC：mtime 缺失/非数字时不删（判据不成立就保守）', () => {
  assert.deepEqual(planDraftGc([gcEntry('x.json', fileDraftKey('D:\\a.md'), 0, 10)], NOW), [])
  const nan = { name: 'y.json', key: fileDraftKey('D:\\b.md'), mtimeMs: Number.NaN, size: 1 }
  assert.deepEqual(planDraftGc([nan], NOW), [])
})

test('草稿键的构造只有一份（渲染层写、主进程清理共用 shared/drafts.ts）', () => {
  // 大写路径要折叠成小写：Windows 上同一个文件的两种大小写写法必须是**同一个键**，
  // 否则 GC 会把"同一个文件的另一份草稿"当成两回事（也要能对上 file- 前缀）
  assert.equal(fileDraftKey('D:\\WS\\A.md'), fileDraftKey('d:\\ws\\a.md'))
  assert.ok(isFileDraftKey(fileDraftKey('D:\\ws\\a.md')))
  assert.ok(!isFileDraftKey('untitled-0'))
  assert.ok(!isFileDraftKey('untitled-orphan'))
  assert.equal(FILE_DRAFT_PREFIX, 'file-')
  assert.ok(DRAFT_GC_MAX_AGE_MS >= 7 * DAY, '保留期不该短于一周（草稿是用户唯一的副本）')
})

// ─── 波次 2：停放草稿的数量上限 + 目录总字节预算（报告 §4.2 P2）─────────────────
// 报告的原话是"停放草稿永不 GC 且无总量上限"：年龄判据只清 file- 草稿，
// 而未命名/停放草稿是**用户动作**产生的（每关一个未保存的窗口就停放一份），
// 一天就能堆几十份，既不过期也没人提醒。下面把两条新判据钉住。

test('临时文件的正则同时认旧名（.tmp）与新名（.lumin-tmp）', () => {
  // 波次 2 把草稿写盘改走 atomicWrite（多了 fsync），它的临时名后缀是 .lumin-tmp；
  // 旧 `.tmp` 残留仍要能被识别，否则升级后这些垃圾文件永远清不掉
  assert.ok(DRAFT_TMP_RE.test('a1b2c3d4e5f60718.json.deadbeef.tmp'), '旧名')
  assert.ok(DRAFT_TMP_RE.test('a1b2c3d4e5f60718.json.deadbeef.lumin-tmp'), '新名')
  assert.ok(!DRAFT_TMP_RE.test('a1b2c3d4e5f60718.json'), '正本不是临时文件')
})

test('GC：未命名/停放草稿超过上限就淘汰最旧的（年龄判据永远管不到它们）', () => {
  const keys = []
  for (let i = 0; i < 25; i++) keys.push(i % 2 === 0 ? `untitled-${i}` : `untitled-orphan-${i}`)
  // ageDays=1：全部很新 ⇒ 年龄判据一份都不会删，只有新的数量上限能拦住它们
  const entries = keys.map((k, i) => gcEntry(`k${i}.json`, k, 1, 100))
  // mtime 全部相同会让"最旧"不确定 —— 让第 i 份比第 i+1 份旧（i 越大越新）
  entries.forEach((e, i) => {
    e.mtimeMs = NOW - (25 - i) * 60_000
  })
  const plan = planDraftGc(entries, NOW)
  assert.equal(
    plan.length,
    Math.max(0, 25 - DRAFT_MAX_UNTITLED),
    `应淘汰 ${25 - DRAFT_MAX_UNTITLED} 份（实际 ${plan.length}）`
  )
  assert.ok(
    plan.every((p) => p.reason === 'too-many-untitled'),
    JSON.stringify(plan.map((p) => p.reason))
  )
  // 被淘汰的必须是最旧的：k0..k4 这 5 份
  const doomed = new Set(plan.map((p) => p.name))
  for (let i = 0; i < 5; i++) assert.ok(doomed.has(`k${i}.json`), `k${i}.json 应该被淘汰`)
  for (let i = 5; i < 25; i++) assert.ok(!doomed.has(`k${i}.json`), `k${i}.json 不该被淘汰`)
})

test('GC：数量上限不外溢到 file- 草稿（它们有自己的年龄判据）', () => {
  const entries = []
  for (let i = 0; i < 30; i++)
    entries.push(gcEntry(`f${i}.json`, fileDraftKey(`D:\\ws\\${i}.md`), 1, 100))
  assert.deepEqual(planDraftGc(entries, NOW), [], '新鲜的文件草稿不该因为"草稿太多"被删')
})

test('GC：目录超出总字节预算时最旧优先淘汰，但至少留 DRAFT_MIN_KEEP 份', () => {
  const mk = (n, sizeMB) =>
    gcEntry(`b${n}.json`, fileDraftKey(`D:\\ws\\b${n}.md`), 1, sizeMB * 1024 * 1024)
  const entries = [0, 1, 2, 3, 4].map((i) => {
    const e = mk(i, 10)
    e.mtimeMs = NOW - (10 - i) * 60_000 // i 越大越新
    return e
  })
  // 5 × 10MB = 50MB > 32MB 预算 ⇒ 删掉最旧的 2 份（50 → 40 → 30 ≤ 32）
  const plan = planDraftGc(entries, NOW, DRAFT_GC_MAX_AGE_MS, {
    maxTotalBytes: DRAFT_MAX_TOTAL_BYTES
  })
  assert.deepEqual(
    plan.map((p) => [p.name, p.reason]),
    [
      ['b0.json', 'size-budget'],
      ['b1.json', 'size-budget']
    ]
  )

  // 预算极端小（想删光）时保底仍留 3 份 —— 不能拿"整洁"换"丢内容"
  const brutal = planDraftGc(entries, NOW, DRAFT_GC_MAX_AGE_MS, { maxTotalBytes: 1 })
  assert.equal(brutal.length, entries.length - DRAFT_MIN_KEEP, `保底应留 ${DRAFT_MIN_KEEP} 份`)
})

test('GC：预算之内一份都不删（判据不成立就保守）', () => {
  const entries = [0, 1, 2].map((i) =>
    gcEntry(`s${i}.json`, fileDraftKey(`D:\\ws\\s${i}.md`), 1, 1024)
  )
  assert.deepEqual(planDraftGc(entries, NOW), [])
})
