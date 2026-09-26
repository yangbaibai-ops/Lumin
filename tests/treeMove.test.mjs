// 文件树内「移动到文件夹」的纯规则（`src/renderer/src/lib/treeMove.ts`）单测。
//
// 为什么值得钉住：拖放是**没有撤销按钮也能毁掉目录结构**的少数操作之一
// （把文件夹拖进自己的子孙里、把 A 拖到已经有同名 A 的地方），而它的判定全是字符串比较 ——
// 正好是单测最便宜、运行时最难看出错的那一类。落盘那一半（`file.rename` / `moveNode`）
// 复用既有通道，这里只钉"能不能搬、搬到哪"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginTreeDrag,
  canDropOn,
  draggingTree,
  endTreeDrag,
  planMove
} from '../src/renderer/src/lib/treeMove.ts'

const ROOT = 'D:\\ws'
const file = (path) => ({ path, type: 'file' })
const dir = (path) => ({ path, type: 'directory' })

// ─── 能搬的那些 ───────────────────────────────────────────────────────────────

test('文件 → 文件夹：目标路径 = 落点目录 + 原文件名（不改名、不改扩展名）', () => {
  const plan = planMove(file('D:\\ws\\a.md'), 'D:\\ws\\sub', ROOT)
  assert.equal(plan.kind, 'move')
  assert.equal(plan.from, 'D:\\ws\\a.md')
  assert.equal(plan.to, 'D:\\ws\\sub\\a.md')
  assert.equal(plan.name, 'a.md', '移动不改名')
  assert.equal(plan.fromDir, 'D:\\ws')
  assert.equal(plan.toDir, 'D:\\ws\\sub')

  // 更深的目标：原样拼在目标目录下，不做任何"重名自动加序号"的猜测
  const deep = planMove(file('D:\\ws\\x\\note.md'), 'D:\\ws\\x\\y\\z', ROOT)
  assert.equal(deep.kind, 'move')
  assert.equal(deep.to, 'D:\\ws\\x\\y\\z\\note.md')
})

test('目录 → 工作区根：整个子树跟着走（只换父目录那一段）', () => {
  const plan = planMove(dir('D:\\ws\\a\\b'), ROOT, ROOT)
  assert.equal(plan.kind, 'move')
  assert.equal(plan.from, 'D:\\ws\\a\\b')
  assert.equal(plan.to, 'D:\\ws\\b')
  assert.equal(plan.name, 'b')
  assert.equal(plan.fromDir, 'D:\\ws\\a')
  assert.equal(plan.toDir, ROOT)
})

test('大小写与分隔符不敏感：同父判定不会因为大小写不同就多搬一次', () => {
  assert.equal(planMove(file('D:\\ws\\Sub\\a.md'), 'd:\\WS\\sub', ROOT).kind, 'noop')
  assert.equal(planMove(file('D:/ws/sub/a.md'), 'D:\\ws\\other', ROOT).kind, 'move')
})

test('目录边界：C:\\ws\\a 不把 C:\\ws\\ab 当成自己的子孙（同名前缀的经典坑）', () => {
  const plan = planMove(dir('D:\\ws\\a'), 'D:\\ws\\ab', ROOT)
  assert.equal(plan.kind, 'move', 'ab 是兄弟目录，不是 a 的子孙')
  assert.equal(plan.to, 'D:\\ws\\ab\\a')
})

test('planMove 是纯函数：不改入参，也不碰磁盘（只有注入的 exists 被调用）', () => {
  const source = file('D:\\ws\\a.md')
  const snapshot = JSON.stringify(source)
  const asked = []
  const plan = planMove(source, 'D:\\ws\\sub', ROOT, (p) => {
    asked.push(p)
    return false
  })
  assert.equal(JSON.stringify(source), snapshot, '入参对象必须原样不动')
  assert.deepEqual(asked, ['D:\\ws\\sub\\a.md'], '只探目标路径一次（不扫目录）')
  assert.equal(plan.kind, 'move')
})

// ─── 拒收 / 无操作的那些 ──────────────────────────────────────────────────────

test('拖到同一个父目录 = 无操作（不产生一次无意义的 rename）', () => {
  const f = planMove(file('D:\\ws\\sub\\a.md'), 'D:\\ws\\sub', ROOT)
  assert.equal(f.kind, 'noop')
  assert.equal(f.reason, 'same-parent')
  assert.equal(f.fromDir, 'D:\\ws\\sub')

  const d = planMove(dir('D:\\ws\\sub\\b'), 'D:\\ws\\sub', ROOT)
  assert.equal(d.kind, 'noop', '目录拖回原处同样是无操作')

  // 工作区根上的项拖到根：也是同父
  assert.equal(planMove(file('D:\\ws\\a.md'), ROOT, ROOT).kind, 'noop')
})

test('目录拖到自己身上 / 自己的子孙里：明确拒绝', () => {
  const self = planMove(dir('D:\\ws\\a'), 'D:\\ws\\a', ROOT)
  assert.equal(self.kind, 'reject')
  assert.equal(self.reason, 'into-self')

  const child = planMove(dir('D:\\ws\\a'), 'D:\\ws\\a\\b', ROOT)
  assert.equal(child.kind, 'reject')
  assert.equal(child.reason, 'into-descendant')

  // 深层子孙同样拦住（判定按目录边界，一层层都算）
  const deep = planMove(dir('D:\\ws\\a'), 'D:\\ws\\a\\b\\c\\d', ROOT)
  assert.equal(deep.reason, 'into-descendant')

  // 大小写不同也是同一个目录
  assert.equal(planMove(dir('D:\\ws\\A'), 'd:\\WS\\a\\b', ROOT).reason, 'into-descendant')
})

test('目标已有同名项：拒绝（绝不覆盖）—— 冲突判定只由注入的 exists 决定', () => {
  const taken = new Set(['D:\\ws\\sub\\a.md'])
  const plan = planMove(file('D:\\ws\\a.md'), 'D:\\ws\\sub', ROOT, (p) => taken.has(p))
  assert.equal(plan.kind, 'reject')
  assert.equal(plan.reason, 'target-exists')
  assert.equal(plan.targetDir, 'D:\\ws\\sub')

  // 目录同名同理
  assert.equal(planMove(dir('D:\\ws\\a'), 'D:\\ws\\sub', ROOT, () => true).reason, 'target-exists')
  // 探测说"没有"就照搬（大小写不敏感的目标也算命中：调用方传的是主进程 exists 的结果）
  assert.equal(planMove(file('D:\\ws\\a.md'), 'D:\\ws\\sub', ROOT, () => false).kind, 'move')
})

test('落点必须落在工作区内：越界 / 空目标 / 没有工作区都拒绝', () => {
  assert.equal(planMove(file('D:\\ws\\a.md'), 'D:\\other', ROOT).reason, 'outside-workspace')
  assert.equal(planMove(file('D:\\ws\\a.md'), 'D:\\ws2', ROOT).reason, 'outside-workspace')
  assert.equal(planMove(file('D:\\ws\\a.md'), '', ROOT).reason, 'outside-workspace')
  assert.equal(planMove(file('D:\\ws\\a.md'), 'D:\\ws', '').reason, 'outside-workspace')
  // 工作区根自己永远是合法落点
  assert.equal(planMove(file('D:\\ws\\sub\\a.md'), ROOT, ROOT).kind, 'move')
})

// ─── 拖拽期间的快速判定（高亮用）──────────────────────────────────────────────

test('canDropOn：只对"真的会搬"的落点为真（同父与非法落点都不亮）', () => {
  assert.equal(canDropOn(file('D:\\ws\\a.md'), 'D:\\ws\\sub', ROOT), true)
  assert.equal(canDropOn(file('D:\\ws\\sub\\a.md'), ROOT, ROOT), true, '拖到空白区 = 移到根')
  assert.equal(canDropOn(dir('D:\\ws\\a\\b'), ROOT, ROOT), true)
  assert.equal(canDropOn(file('D:\\ws\\sub\\a.md'), 'D:\\ws\\sub', ROOT), false, '同父 = 无操作')
  assert.equal(canDropOn(dir('D:\\ws\\a'), 'D:\\ws\\a\\b', ROOT), false, '子孙 = 拒绝')
  assert.equal(canDropOn(file('D:\\ws\\a.md'), 'D:\\other', ROOT), false, '越界 = 拒绝')
  // ⚠️ 重名冲突这里**故意不判**（dragover 期间发不了 IPC）：落点照常高亮，
  // 落下那一刻由 moveNode 明确拒绝并提示。这条口径写在这里，免得以后有人"顺手"加一次同步探测
})

// ─── 拖拽会话信箱 ─────────────────────────────────────────────────────────────

test('拖拽会话：begin 记来源、end 清空（外部拖入永远拿不到来源）', () => {
  assert.equal(draggingTree(), null, '静息态没有内部拖拽')
  beginTreeDrag({ path: 'D:\\ws\\a.md', type: 'file' })
  assert.deepEqual(draggingTree(), { path: 'D:\\ws\\a.md', type: 'file' })
  // 记的是副本：调用方之后改自己的对象不会污染信箱
  const source = { path: 'D:\\ws\\b', type: 'directory' }
  beginTreeDrag(source)
  source.path = 'D:\\ws\\changed'
  assert.equal(draggingTree().path, 'D:\\ws\\b')
  endTreeDrag()
  assert.equal(draggingTree(), null)
})
