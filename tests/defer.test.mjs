// ─── deferAfterPmEvent（清单 §1.D / 自查报告 S3 第一期）──────────────────────
//
// 这个 helper 只有三行，但它守的是一条**不能用微任务替代**的时序约束，所以值得钉住：
//   * 必须排在**当前宏任务之后**（微任务仍在 PM 本轮事件处理内，躲不开 PM 自己的 MouseUp 处理）；
//   * 必须能撤销（视图销毁 / 组件卸载时不该再动手）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferAfterPmEvent } from '../src/renderer/src/lib/editor/defer.ts'

const macrotask = () => new Promise((r) => setTimeout(r, 0))

test('注册的同步阶段不执行（否则等于没延后）', async () => {
  let ran = false
  deferAfterPmEvent(() => {
    ran = true
  })
  assert.equal(ran, false, '注册后同步检查必须还没跑')
  await macrotask()
  assert.equal(ran, true, '让出一次宏任务后应当已执行')
})

test('排在下一次宏任务里：真实顺序是 同步 → 延后', async () => {
  const order = []
  deferAfterPmEvent(() => order.push('deferred'))
  order.push('sync')
  await macrotask()
  assert.deepEqual(order, ['sync', 'deferred'], `实际顺序 ${order.join(' -> ')}`)
})

test('不是微任务：连续两次 await Promise 仍未执行（证明 Promise.then 不能替代它）', async () => {
  let ran = false
  deferAfterPmEvent(() => {
    ran = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(ran, false, '微任务阶段必须还没执行 —— 否则躲不开 PM 本轮的 MouseUp 处理')
  await macrotask()
  assert.equal(ran, true, '宏任务阶段应当已经执行')
})

test('cancel() 能撤销：撤销后回调永不执行（视图已销毁的场景）', async () => {
  let ran = false
  const cancel = deferAfterPmEvent(() => {
    ran = true
  })
  cancel()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(ran, false, '撤销后不该再执行')
})
