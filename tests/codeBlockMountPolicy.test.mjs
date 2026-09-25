// ─── 代码块 CM 挂载策略（审计 §10 P1「48 个 ≥80 行的 src 文件在 tests 里零引用」）──
//
// 为什么值得单测：`CodeBlockView.vue` 是"每块一个 Vue NodeView + 一个完整 CodeMirror"，
// 500/1500 个围栏的文档实测 22.8s/>185s、常驻 1.4GB —— 这一层"该不该建 CM"的判定是
// **性能与可用性的总开关**，而它此前在 tests/ 里零引用（错了只有真跑大文档才发现）。
// 两件事必须钉住：
//   ① 判定本身（三个条件任一成立就挂）；
//   ② 没有 `IntersectionObserver` 时**直接当"在视口里"** —— 模块注释写得很清楚：
//      "宁可不省这点成本，也不能让代码块不可编辑"。这条兜底要是没了，老环境里
//      所有代码块都会变成不可编辑的静态文本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_MOUNT_MARGIN_PX,
  STATIC_HIGHLIGHT,
  shouldMountCm
} from '../src/renderer/src/lib/editor/codeBlockMountPolicy.ts'

/**
 * 每个用例一份**全新的模块实例**：模块里那个 `observer` 是单例，
 * 不隔离的话"没有 IntersectionObserver"这条就测不到了（前一个用例已经把 observer 建好）。
 */
const fresh = (tag) => import(`../src/renderer/src/lib/editor/codeBlockMountPolicy.ts?${tag}`)

test('shouldMountCm：视口附近 / 选区在内 / 刚点过，任一成立就挂', () => {
  const cases = [
    [{ near: true, selectionInside: false, activated: false }, true],
    [{ near: false, selectionInside: true, activated: false }, true],
    [{ near: false, selectionInside: false, activated: true }, true],
    [{ near: true, selectionInside: true, activated: true }, true],
    [{ near: false, selectionInside: false, activated: false }, false]
  ]
  for (const [input, want] of cases) {
    assert.equal(shouldMountCm(input), want, JSON.stringify(input))
  }
})

test('常量：提前挂载边距 600px；静态高亮是开关而不是散落的字面量', () => {
  assert.equal(CODE_MOUNT_MARGIN_PX, 600)
  assert.equal(typeof STATIC_HIGHLIGHT, 'boolean')
})

test('没有 IntersectionObserver 时：立刻回调 near=true，取消函数可用且不抛', async () => {
  const mod = await fresh('no-io')
  const saved = globalThis.IntersectionObserver
  // @ts-expect-error 故意把全局删掉，模拟老环境 / 测试宿主
  delete globalThis.IntersectionObserver
  try {
    const seen = []
    const off = mod.watchCodeBlockMount({ id: 'block-1' }, (near) => seen.push(near))
    assert.deepEqual(seen, [true], '必须当场当"在视口里"（否则代码块不可编辑）')
    assert.equal(typeof off, 'function')
    assert.doesNotThrow(() => off())
  } finally {
    if (saved) globalThis.IntersectionObserver = saved
  }
})

test('有 IntersectionObserver 时：共享一个实例、rootMargin 含 600px、注册与注销配对', async () => {
  const mod = await fresh('with-io')
  const saved = globalThis.IntersectionObserver
  const made = []
  class FakeIO {
    constructor(cb, options) {
      this.cb = cb
      this.options = options
      this.observed = []
      this.unobserved = []
      made.push(this)
    }
    observe(el) {
      this.observed.push(el)
    }
    unobserve(el) {
      this.unobserved.push(el)
    }
    disconnect() {
      this.observed = []
    }
  }
  globalThis.IntersectionObserver = FakeIO
  try {
    const elA = { id: 'a' }
    const elB = { id: 'b' }
    const seenA = []
    const seenB = []
    const offA = mod.watchCodeBlockMount(elA, (near) => seenA.push(near))
    const offB = mod.watchCodeBlockMount(elB, (near) => seenB.push(near))

    assert.equal(made.length, 1, '必须是**一个共享 observer**，不是每块一个（那正是 1.4GB 的来源）')
    const io = made[0]
    assert.equal(io.options.rootMargin, '600px 0px 600px 0px')
    assert.deepEqual(io.observed, [elA, elB])

    // 相交结果按块回调（真实 IntersectionObserver 在注册后异步回调，这里直接驱动）
    io.cb([{ target: elA, isIntersecting: true }])
    io.cb([{ target: elB, isIntersecting: false }])
    assert.deepEqual(seenA, [true])
    assert.deepEqual(seenB, [false])

    // 注销后：observer 不再观察它，也不该再回调它
    offA()
    assert.deepEqual(io.unobserved, [elA])
    io.cb([{ target: elA, isIntersecting: true }])
    assert.deepEqual(seenA, [true], '注销之后不该再收到回调')
    offB()
  } finally {
    if (saved) globalThis.IntersectionObserver = saved
    else delete globalThis.IntersectionObserver
  }
})
