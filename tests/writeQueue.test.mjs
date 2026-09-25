// 按路径串行化的写盘队列（src/main/services/writeQueue.ts）。
//
// 审计 §2 P1：「同一文件可被两个窗口打开并各自保存」——渲染层的 `savePromise` 只管得住
// 同一个 store（同一个窗口），两个窗口的写会并发提交到主进程。这条队列保证：
//   ① 同一个目标**按到达顺序依次**落盘（不会两次写交错）；
//   ② 不同目标互不阻塞（不能因为 A 文件在写就把 B 文件也堵住）；
//   ③ 前一次失败**不阻断**后一次；
//   ④ 队列会自己清理（长期运行的进程不能为每个写过的文件留一个条目）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingWriteCount, serializeWrite } from '../src/main/services/writeQueue.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

test('serializeWrite：同一路径按到达顺序依次执行（不交错）', async () => {
  const order = []
  const slow = serializeWrite('D:\\ws\\a.md', async () => {
    order.push('a-start')
    await new Promise((r) => setTimeout(r, 30))
    order.push('a-end')
    return 'a'
  })
  const fast = serializeWrite('d:/ws/a.md', async () => {
    // 路径大小写/分隔符不同 = 同一个文件（Windows），必须排在 a 后面
    order.push('b-start')
    order.push('b-end')
    return 'b'
  })
  assert.deepEqual(await Promise.all([slow, fast]), ['a', 'b'])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('serializeWrite：不同路径互不阻塞（并发执行）', async () => {
  const order = []
  const a = serializeWrite('D:\\ws\\a.md', async () => {
    order.push('a-start')
    await new Promise((r) => setTimeout(r, 30))
    order.push('a-end')
  })
  const b = serializeWrite('D:\\ws\\b.md', async () => {
    order.push('b-start')
    await new Promise((r) => setTimeout(r, 5))
    order.push('b-end')
  })
  await Promise.all([a, b])
  // b 不等 a：b 的两条日志都必须排在 a-end 之前
  assert.deepEqual(order, ['a-start', 'b-start', 'b-end', 'a-end'])
})

test('serializeWrite：前一次失败不阻断后一次，且错误只给各自的调用方', async () => {
  const first = serializeWrite('D:\\ws\\c.md', async () => {
    throw new Error('boom')
  })
  const second = serializeWrite('D:\\ws\\c.md', async () => 'ok')
  await assert.rejects(first, /boom/)
  assert.equal(await second, 'ok')
})

test('serializeWrite：队尾稳定后条目会被清掉（不泄漏）', async () => {
  const before = pendingWriteCount()
  await serializeWrite('D:\\ws\\d.md', async () => 'x')
  await tick()
  await tick()
  assert.equal(pendingWriteCount(), before, '写完并且链尾稳定后该条目应当被删除')
})

test('serializeWrite：失败也会清理条目', async () => {
  const before = pendingWriteCount()
  await serializeWrite('D:\\ws\\e.md', async () => {
    throw new Error('nope')
  }).catch(() => {})
  await tick()
  await tick()
  assert.equal(pendingWriteCount(), before)
})
