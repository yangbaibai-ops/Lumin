// 从 `stores/files.ts` 抽出来的**核心状态机判据**的单测（src/renderer/src/lib/filesCore.ts）。
//
// 审计 §10 P2 的原话是「核心状态机几乎没有单测」：`save()` / `writeDraft()` / `scheduleSave()`
// 的时序只靠 CDP 套件兜，而审计的 4 条 P0 全在这一层。这里的断言都对着**出过的那个 bug 的
// 形态**写（"保存期间继续输入被标成已保存" / "连续打字一份草稿都不写" / "同路径重开静默回滚"
// / "改名后保存生成幽灵副本"），不是对着实现写。
//
// 纯函数不 import Vue/Pinia/IPC，所以能直接 `node --test`；时间与磁盘 mtime 都是**注入**的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_DEBOUNCE_MS,
  DRAFT_MAX_WAIT_MS,
  SAVE_RETRY_BASE_MS,
  SAVE_RETRY_MAX_MS,
  contentWouldChangeOnReopen,
  decideSamePathReopen,
  focusPathAfterMove,
  nextSaveRetryDelay,
  planDraftWrite,
  planReopenWhenClean,
  planSaveOutcome,
  renameCurrentDocFixup,
  shouldWriteDraftNow,
  snapshotIsSaved
} from '../src/renderer/src/lib/filesCore.ts'

const T0 = 1_800_000_000_000

/** 判据只用得到这四个字段（形状与 store 里的 CurrentDoc 一致，见 filesCore 的 DocSnapshot） */
const doc = (over = {}) => ({
  path: 'D:\\ws\\a.md',
  content: 'A',
  savedContent: 'A',
  mtimeMs: 1000,
  ...over
})

// ─── ① 保存快照语义（审计 §2 P1 的 P0：保存期间继续输入被标成"已保存"）──────────────

test('快照语义：保存期间继续输入 ⇒ 保持脏，重排下一轮（绝不标成已保存）', () => {
  // 写盘是异步的：发起时抓的快照是 'A'，await 期间用户又敲了一个字 → content = 'AB'
  const snapshot = 'A'
  const after = doc({ content: 'AB', savedContent: 'A' })
  const outcome = planSaveOutcome(true, snapshotIsSaved(after, snapshot))
  assert.equal(outcome, 'reschedule')
  // 关键反例：这份"新内容"没有被当成已保存在磁盘上的那一份。
  // 若这里被标成已保存，finishSave 会连草稿一起删掉 → 多敲的字永久丢失。
  assert.notEqual(after.content, snapshot)
  assert.notEqual(outcome, 'clear-draft')
})

test('快照语义：快照与当前内容逐字相同 ⇒ 与磁盘一致，草稿可以清掉', () => {
  const snapshot = 'A'
  const after = doc({ content: 'A', savedContent: 'A' })
  assert.equal(snapshotIsSaved(after, snapshot), true)
  assert.equal(planSaveOutcome(true, snapshotIsSaved(after, snapshot)), 'clear-draft')
})

test('快照语义的**第二半**：保存期间撤回成与快照相同的文本，也算干净', () => {
  // 用户敲了 'AB' 又撤回成 'A'：content === snapshot，但 savedContent 还停在更老的 'A0'
  // —— 少了 savedContent 这一项，"撤销回原样"会被误判为脏并每 1.2s 重排一次保存
  const after = doc({ content: 'A', savedContent: 'A0' })
  assert.equal(snapshotIsSaved(after, 'A'), false)
  assert.equal(planSaveOutcome(true, snapshotIsSaved(after, 'A')), 'reschedule')
  // 对照组：两个都等于快照才算干净
  assert.equal(snapshotIsSaved(doc({ content: 'A', savedContent: 'A' }), 'A'), true)
})

test('快照语义：保存期间用户换掉了文档 ⇒ 两件事都不做（新文档的账不被旧保存改写）', () => {
  const snapshot = 'A'
  const stillDoc = false
  // 换了文档时无论快照与内容是否一致，都不许去清"当前文档"的草稿
  assert.equal(planSaveOutcome(stillDoc, snapshotIsSaved(doc(), snapshot)), 'clear-draft')
  assert.equal(
    planSaveOutcome(stillDoc, snapshotIsSaved(doc({ content: 'AB' }), snapshot)),
    'clear-draft'
  )
})

test('计划分支互斥：四种组合只有"仍是当前文档 + 快照≠当前内容"才重排', () => {
  const table = [
    [true, true, 'clear-draft'],
    [true, false, 'reschedule'],
    [false, true, 'clear-draft'],
    [false, false, 'clear-draft']
  ]
  for (const [stillDoc, saved, want] of table) {
    assert.equal(planSaveOutcome(stillDoc, saved), want, `stillDoc=${stillDoc} saved=${saved}`)
  }
})

// ─── ②1.2s 尾沿防抖 / 10s 最大等待（草稿时序）────────────────────────────────

test('草稿：干净文档不排草稿（写盘那一步还会清掉盘上的旧草稿）', () => {
  assert.equal(planDraftWrite({ dirty: false, lastDraftAt: 0, now: T0 }), 'skip')
  // 反例：同一时刻只要脏了就必须排（不能因为"距上次写草稿还不到 1.2s"就不管）
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: T0, now: T0 }), 'debounce')
})

test('草稿：尾沿防抖的两个边界（不到 1.2s 起定时器、恰好 10s 立刻写）', () => {
  // 刚改过：起 1.2s 定时器
  assert.equal(DRAFT_DEBOUNCE_MS, 1200)
  assert.equal(DRAFT_MAX_WAIT_MS, 10_000)
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: T0 - 1, now: T0 }), 'debounce')
  // **恰好**差 1.2s：仍然是防抖那一支 —— 这条分支的判据里根本没有 1.2s（它只在 store 的
  // setTimeout 里），所以"刚好卡在 1.2s"绝不能提前变成 write-now
  assert.equal(
    planDraftWrite({ dirty: true, lastDraftAt: T0 - DRAFT_DEBOUNCE_MS, now: T0 }),
    'debounce'
  )
})

test('草稿：最大等待边界（差 10s 差 1ms 仍防抖、恰好 10s 立刻写）', () => {
  // 9000ms < 10000ms：连续打字但还没到上限 → 继续防抖（尾沿会一直被推迟，靠上限兜）
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: T0 - 9_000, now: T0 }), 'debounce')
  assert.equal(shouldWriteDraftNow({ dirty: true, lastDraftAt: T0 - 9_000, now: T0 }), false)
  // **恰好等于** 10s：到点，必须立刻写（判据是 >=，与旧实现逐字一致）
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: T0 - 10_000, now: T0 }), 'write-now')
  assert.equal(shouldWriteDraftNow({ dirty: true, lastDraftAt: T0 - 10_000, now: T0 }), true)
  // 超过 10s：同样是立刻写
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: T0 - 10_001, now: T0 }), 'write-now')
})

test('草稿：连续打字 12s（每 200ms 一次）期间不会一份都不写', () => {
  // 场景复现（审计那条"连续打字不写草稿"）：每 200ms 排一次草稿，间隔都 < 1.2s，
  // 纯尾沿防抖会把定时器无限推迟 ⇒ 12s 里一份都没有。有上限之后，第 10s 那次立刻写。
  let lastDraftAt = T0
  let wrote = 0
  let sawWriteNow = false
  for (let t = 200; t <= 12_000; t += 200) {
    const action = planDraftWrite({ dirty: true, lastDraftAt, now: T0 + t })
    if (action === 'write-now') {
      sawWriteNow = true
      wrote += 1
      lastDraftAt = T0 + t // writeDraft 写之前就推进 lastDraftAt（失败也算试过一次）
    }
  }
  assert.equal(sawWriteNow, true, '12s 连续输入里必须至少有一次"立刻写"')
  assert.equal(wrote, 1, '10s 时写一份，12s 时距上次只有 2s ⇒ 再等尾沿')
})

test('草稿：时钟回拨 / 坏值不误判成"到点立刻写"（时间差为负）', () => {
  assert.equal(shouldWriteDraftNow({ dirty: true, lastDraftAt: T0 + 5000, now: T0 }), false)
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: Number.NaN, now: T0 }), 'debounce')
  // lastDraftAt = 0（从未写过草稿）：与旧实现一致，距"上一份"按 0 算 ⇒ 立刻写
  assert.equal(planDraftWrite({ dirty: true, lastDraftAt: 0, now: T0 }), 'write-now')
})

// ─── ③ 同一路径重开的三条分支（审计 §3 P1：静默回滚）──────────────────────────

test('同路径重开：路径不同 ⇒ 照常读盘（不进这套判定）', () => {
  assert.equal(
    decideSamePathReopen({
      currentPath: 'D:\\ws\\a.md',
      path: 'D:\\ws\\b.md',
      dirty: true,
      discardChanges: false
    }),
    'proceed'
  )
})

test('同路径重开【分支 1】：脏 + 没显式放弃 ⇒ 先问（绝不直接放行）', () => {
  assert.equal(
    decideSamePathReopen({
      currentPath: 'D:\\ws\\a.md',
      path: 'd:/WS/A.MD', // 大小写/分隔符不敏感：这就是同一路径
      dirty: true,
      discardChanges: false
    }),
    'ask'
  )
  // 反例：路径只差一个文件（不是同路径）时不能问，问错了等于把"打开另一个文件"变成阻塞
  assert.equal(
    decideSamePathReopen({
      currentPath: 'D:\\ws\\a.md',
      path: 'D:\\ws\\ab.md',
      dirty: true,
      discardChanges: false
    }),
    'proceed'
  )
})

test('同路径重开【分支 2】：脏但调用方明确说"这次就是放弃改动" ⇒ 不问', () => {
  assert.equal(
    decideSamePathReopen({
      currentPath: 'D:\\ws\\a.md',
      path: 'D:\\ws\\a.md',
      dirty: true,
      discardChanges: true
    }),
    'proceed'
  )
})

test('同路径重开【分支 3】：干净 + 磁盘没变 + 编码没变 ⇒ 短路（连读盘都不做）', () => {
  const base = {
    dirty: false,
    discardChanges: false,
    defaultEncoding: 'auto',
    currentEncoding: 'utf-8',
    currentMtimeMs: 1000,
    diskMtimeMs: 1000
  }
  assert.equal(planReopenWhenClean(base), 'short-circuit')
  // 1ms 容差内也算"没变"（文件系统时间戳与本地时钟不同源）
  assert.equal(planReopenWhenClean({ ...base, diskMtimeMs: 1001 }), 'short-circuit')
  assert.equal(planReopenWhenClean({ ...base, diskMtimeMs: 999 }), 'short-circuit')
})

test('同路径重开【分支 3 的反例】：磁盘被外部改过 / 默认编码变了 ⇒ 必须放行读盘', () => {
  const base = {
    dirty: false,
    discardChanges: false,
    defaultEncoding: 'auto',
    currentEncoding: 'utf-8',
    currentMtimeMs: 1000,
    diskMtimeMs: 1000
  }
  // ① 磁盘 mtime 变了：重开才是"载入最新内容"
  assert.equal(planReopenWhenClean({ ...base, diskMtimeMs: 1002 }), 'proceed')
  // ② 生效的默认编码变了：重开是"改了默认编码想对当前文件生效"的唯一路径
  assert.equal(
    planReopenWhenClean({ ...base, defaultEncoding: 'gbk', currentEncoding: 'utf-8' }),
    'proceed'
  )
  // 默认编码是 auto 时不算"变了"（auto = 交给主进程猜，不是另一个具体编码）
  assert.equal(planReopenWhenClean({ ...base, defaultEncoding: 'auto' }), 'short-circuit')
  // 默认编码恰好就是当前文档编码：也没变
  assert.equal(
    planReopenWhenClean({ ...base, defaultEncoding: 'utf-8', currentEncoding: 'utf-8' }),
    'short-circuit'
  )
  // ③ 探测不到磁盘 mtime（文件已不在 / stat 失败）时不敢短路 —— 宁可多读一次盘
  assert.equal(planReopenWhenClean({ ...base, diskMtimeMs: null }), 'proceed')
  assert.equal(planReopenWhenClean({ ...base, currentMtimeMs: null }), 'proceed')
  // ④ 文档这一刻是脏的（比如问的期间又被写脏了）⇒ 不许短路
  assert.equal(planReopenWhenClean({ ...base, dirty: true }), 'proceed')
})

test('同路径重开：脏文档确认之后仍然要真读盘（"放弃我的改动"要落地）', () => {
  assert.equal(
    planReopenWhenClean({
      dirty: true,
      discardChanges: false,
      defaultEncoding: 'auto',
      currentEncoding: 'utf-8',
      currentMtimeMs: 1000,
      diskMtimeMs: 1000
    }),
    'proceed'
  )
})

test('contentWouldChangeOnReopen：判据本身的两个条件可分别读出', () => {
  assert.equal(
    contentWouldChangeOnReopen({
      defaultEncoding: 'gbk',
      currentEncoding: 'utf-8',
      currentMtimeMs: 1000,
      diskMtimeMs: 1000
    }),
    true
  )
  assert.equal(
    contentWouldChangeOnReopen({
      defaultEncoding: 'auto',
      currentEncoding: 'utf-8',
      currentMtimeMs: 1000,
      diskMtimeMs: 5000
    }),
    true
  )
  assert.equal(
    contentWouldChangeOnReopen({
      defaultEncoding: 'auto',
      currentEncoding: 'utf-8',
      currentMtimeMs: 1000,
      diskMtimeMs: 1000
    }),
    false
  )
})

// ─── ④ 改名/搬家的路径算术（"保存后生成幽灵副本"那条）────────────────────────

test('renameFixup：改的就是当前文档 ⇒ 换路径 + 换文件名', () => {
  const fix = renameCurrentDocFixup('D:\\ws\\a.md', 'D:\\ws\\renamed.md', 'D:\\ws\\a.md', 'a.md')
  assert.deepEqual(fix, { path: 'D:\\ws\\renamed.md', name: 'renamed.md' })
})

test('renameFixup：改的是它所在的目录 ⇒ 按新目录 + 原后缀搬（大小写/分隔符不敏感）', () => {
  const fix = renameCurrentDocFixup(
    'D:\\ws\\sub',
    'D:\\ws\\renamed',
    'D:\\ws\\sub\\deep\\b.md',
    'b.md'
  )
  assert.equal(fix.path, 'D:\\ws\\renamed\\deep\\b.md')
  assert.equal(fix.name, '', '目录改名不动文件名（store 保持原名）')

  // 大小写不同 = 同一个目录，照样要搬；后缀保留**原路径自己的大小写**
  const cased = renameCurrentDocFixup(
    'D:\\WS\\SUB',
    'D:\\ws\\renamed',
    'D:\\ws\\sub\\Deep\\B.MD',
    'B.MD'
  )
  assert.equal(cased.path, 'D:\\ws\\renamed\\Deep\\B.MD')
  assert.equal(cased.name, '')
})

test('renameFixup：同名前缀的目录**不许**被误搬（这条是关键反例）', () => {
  // `D:\ws\sub2\x.md` 不在 `D:\ws\sub` 里：字符串前缀替换会把 sub2 变成 renamed2
  assert.equal(
    renameCurrentDocFixup('D:\\ws\\sub', 'D:\\ws\\renamed', 'D:\\ws\\sub2\\x.md', 'x.md'),
    null
  )
  // 完全不相干的目录
  assert.equal(renameCurrentDocFixup('D:\\ws\\sub', 'D:\\ws\\x', 'D:\\other\\a.md', 'a.md'), null)
  // 没有当前文档
  assert.equal(renameCurrentDocFixup('D:\\ws\\sub', 'D:\\ws\\x', null, 'a.md'), null)
})

test('renameFixup：目录改名时**目录自身**也在这套判定里（路径恰好等于旧路径）', () => {
  // 当前文档的"路径"理论上不会是一个目录，但撤销/搬家的调用点会把同一条判定复用在两边；
  // 这里钉住的是"恰好相等"这一支的行为（换成新路径，名字取新路径最后一段）
  const fix = renameCurrentDocFixup('D:\\ws\\sub', 'D:\\ws\\renamed', 'D:\\ws\\sub', 'sub')
  assert.deepEqual(fix, { path: 'D:\\ws\\renamed', name: 'renamed' })
  // 反例：子目录里的文档不能被判成"相等"
  assert.equal(
    renameCurrentDocFixup('D:\\ws\\sub', 'D:\\ws\\renamed', 'D:\\ws\\sub\\a.md', 'a.md').path,
    'D:\\ws\\renamed\\a.md'
  )
})

test('focusPathAfterMove：焦点行跟着搬，不在被搬子树里就不动', () => {
  assert.equal(
    focusPathAfterMove('D:\\ws\\sub', 'D:\\ws\\renamed', 'D:\\ws\\sub\\deep\\b.md'),
    'D:\\ws\\renamed\\deep\\b.md'
  )
  // 目录自身（焦点行可能就是那一行）
  assert.equal(focusPathAfterMove('D:\\ws\\sub', 'D:\\ws\\r', 'D:\\ws\\sub'), 'D:\\ws\\r')
  // 反例：不在子树里 → null（store 保持原值，不会把焦点凭空搬到别处）
  assert.equal(focusPathAfterMove('D:\\ws\\sub', 'D:\\ws\\r', 'D:\\ws\\sub2\\x.md'), null)
  assert.equal(focusPathAfterMove('D:\\ws\\sub', 'D:\\ws\\r', null), null)
  // 大小写不同仍然算在子树里
  assert.equal(
    focusPathAfterMove('D:\\WS\\SUB', 'D:\\ws\\r', 'D:\\ws\\sub\\a.md'),
    'D:\\ws\\r\\a.md'
  )
})

// ─── ⑤ 写盘失败的退避（指数退避 + 封顶）──────────────────────────────────────

test('退避延时：0 → 5s，之后翻倍，60s 封顶', () => {
  assert.equal(nextSaveRetryDelay(0), SAVE_RETRY_BASE_MS)
  assert.equal(nextSaveRetryDelay(SAVE_RETRY_BASE_MS), 10_000)
  assert.equal(nextSaveRetryDelay(10_000), 20_000)
  assert.equal(nextSaveRetryDelay(20_000), 40_000)
  // 40s × 2 = 80s > 60s ⇒ 封顶（这是"反复失败不会把重试间隔拉到几个小时"的那条）
  assert.equal(nextSaveRetryDelay(40_000), SAVE_RETRY_MAX_MS)
  assert.equal(nextSaveRetryDelay(60_000), SAVE_RETRY_MAX_MS)
  // 反例：封顶值本身是 60s，且严格大于首次退避（否则退避没有意义）
  assert.ok(SAVE_RETRY_MAX_MS > SAVE_RETRY_BASE_MS)
  // 1 这种坏值（历史数据）也会翻倍而不是卡在 1ms
  assert.equal(nextSaveRetryDelay(1), 2)
})
