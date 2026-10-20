// ─── 退出前排空在飞的原子写（用户报障：关窗保存后残留 `.lumin-tmp`）──────────────
//
// 现场：点「保存」后窗口销毁 → 进程退出，而那次保存的 `file:write` 还在路上：
// 临时文件已经写出，`fsync/rename/finally 清理` 没来得及跑。修法有两层：
//   1. 渲染层 `useAppActions` 的事件订阅只装一次（否则一次关窗收到两个 before-close，
//      两个 requestClose 各保存一次 —— 第二个正好撞上退出）；
//   2. 主进程 `before-quit` 先排空在飞的原子写再退（本套件的主体），`will-quit` 再兜一次。
//
// 本套件钉住第 2 层的语义（纯模块，可毫秒级跑）以及它在 main/index.ts 里的接线
// （接线是"忘了就复发"的那一类，只能静态查）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  QUIT_DRAIN_IDLE_MS,
  QUIT_DRAIN_TIMEOUT_MS,
  beginAtomicWrite,
  drainAtomicWrites,
  endAtomicWrite,
  markQuitDrained,
  pendingAtomicWrites,
  quitDrainComplete,
  resetQuitDrain,
  resetWriteDrainForTest,
  waitForAtomicWritesIdle
} from '../src/main/services/writeDrain.ts'
import { atomicWrite, atomicWriteBytes } from '../src/main/services/atomicWrite.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('在飞计数：开始 +1、结束 -1；等到归零才放行', async () => {
  resetWriteDrainForTest()
  beginAtomicWrite()
  beginAtomicWrite()
  assert.equal(pendingAtomicWrites(), 2)
  let done = false
  const waiting = waitForAtomicWritesIdle(1000).then(() => (done = true))
  await sleep(30)
  assert.equal(done, false, '还有写在飞时不许放行')
  endAtomicWrite()
  await sleep(20)
  assert.equal(done, false, '还剩一个时也不许放行')
  endAtomicWrite()
  await waiting
  assert.equal(done, true)
  assert.equal(pendingAtomicWrites(), 0)
})

test('drain 会等所有在飞写结束，并在结束后返回 ok', async () => {
  resetWriteDrainForTest()
  beginAtomicWrite()
  const t0 = Date.now()
  setTimeout(() => endAtomicWrite(), 60)
  const r = await drainAtomicWrites(2000, 10)
  assert.deepEqual(r, { ok: true, pending: 0 })
  assert.ok(Date.now() - t0 >= 50, '必须真的等到写结束（不是立刻放行）')
})

test('安静观察期：计数已经为 0 也要观察一小段，接住"正在路上的 IPC"', async () => {
  resetWriteDrainForTest()
  const t0 = Date.now()
  const r = await drainAtomicWrites(2000, 60)
  assert.equal(r.ok, true)
  assert.ok(Date.now() - t0 >= 55, '计数为 0 时也必须等满安静期')
})

test('超时如实返回 ok:false + 仍在飞的条数（不能把挂死 IO 变成"关不掉应用"）', async () => {
  resetWriteDrainForTest()
  beginAtomicWrite()
  const t0 = Date.now()
  const r = await drainAtomicWrites(40, 10)
  assert.equal(r.ok, false)
  assert.equal(r.pending, 1)
  assert.ok(Date.now() - t0 >= 30)
  endAtomicWrite()
  assert.equal(pendingAtomicWrites(), 0)
})

test('退出闸：排空完成后第二次 before-quit 可以直接放行；取消退出要复位', () => {
  resetWriteDrainForTest()
  assert.equal(quitDrainComplete(), false)
  markQuitDrained()
  assert.equal(quitDrainComplete(), true)
  resetQuitDrain()
  assert.equal(quitDrainComplete(), false, '用户取消退出后，下一轮必须重新排空')
})

test('atomicWrite 成功/失败都会把在飞计数归零（含临时文件清理）', async () => {
  resetWriteDrainForTest()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-drain-aw-'))
  try {
    await atomicWriteBytes(path.join(dir, 'a.md'), Buffer.from('ok'))
    assert.equal(pendingAtomicWrites(), 0, '成功后不许把计数漏在 1')

    const target = path.join(dir, 'blocked')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'inside.txt'), 'x')
    await assert.rejects(() => atomicWriteBytes(target, Buffer.from('payload')))
    assert.equal(pendingAtomicWrites(), 0, '失败后也不许把计数漏在 1')
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith('.lumin-tmp')),
      [],
      '失败后临时文件必须已被 finally 清掉'
    )

    // 写回调自己抛错（磁盘满/编码失败）：同样要清理 + 冒泡
    await assert.rejects(
      () =>
        atomicWrite(path.join(dir, 'boom.md'), async (tmp) => {
          await fs.promises.writeFile(tmp, 'half')
          throw new Error('disk-full')
        }),
      /disk-full/
    )
    assert.equal(pendingAtomicWrites(), 0)
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith('.lumin-tmp')),
      []
    )
    assert.equal(fs.existsSync(path.join(dir, 'boom.md')), false, '失败时目标不该出现')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    resetWriteDrainForTest()
  }
})

test('接线：before-quit 排空、will-quit 兜底、取消退出复位（静态守卫）', () => {
  const index = read('src/main/index.ts')
  assert.match(index, /app\.on\('before-quit'/, '必须保留 before-quit 钩子')
  assert.match(index, /event\.preventDefault\(\)/, 'before-quit 要先拦住退出')
  assert.match(index, /drainAtomicWrites\(\)/, 'before-quit 必须排空在飞的原子写')
  assert.match(index, /markQuitDrained\(\)/, '排空完成后要放行本轮退出')
  assert.match(index, /app\.on\('will-quit'/, 'will-quit 必须有兜底')
  assert.match(index, /quitDrainComplete\(\)/, '重入的 before-quit 不能再次拦住自己')

  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /app:cancelClose/, '取消关窗的通道必须还在')
  assert.match(ipc, /resetQuitDrain\(\)/, '用户取消退出后必须复位排空闸')
})

test('接线：atomicWrite 的清理放在 finally（而不是只放 catch）', () => {
  const src = read('src/main/services/atomicWrite.ts')
  assert.match(src, /finally\s*\{[\s\S]*fs\.rm\(tmp/, '临时文件清理必须在 finally 里')
  assert.match(src, /endAtomicWrite\(\)/, 'finally 里要结束在飞记账（退出排空才等得到清理）')
  // 失败必须冒泡：函数体里不许把 catch 全吞掉（除了清理本身）
  assert.doesNotMatch(src, /catch\s*\{\s*\/\*[^*]*\*\/\s*\}/, '不许用空 catch 吞掉写盘错误')
})

test('接线：渲染层事件只装一次（否则一次关窗两个 requestClose）', () => {
  const src = read('src/renderer/src/composables/useAppActions.ts')
  assert.match(src, /let appActionListenersInstalled = false/, '必须有模块级的一次性安装闸')
  assert.match(src, /if \(!appActionListenersInstalled\) \{/, '所有事件订阅必须在闸内')
  assert.match(src, /appActionListenersInstalled = false\r?\n\s*offMenu\(\)/, '卸载时要复位')
  // 已知的两个调用点：App.vue 与常驻挂载的 CommandPalette.vue（命令表需要 handleMenu）
  assert.match(read('src/renderer/src/App.vue'), /useAppActions\(\)/)
  assert.match(read('src/renderer/src/components/CommandPalette.vue'), /useAppActions\(\)/)
})

test('默认口径：安静期 150ms / 总超时 5s（与注释、验收口径一致）', () => {
  assert.equal(QUIT_DRAIN_IDLE_MS, 150)
  assert.equal(QUIT_DRAIN_TIMEOUT_MS, 5000)
})
