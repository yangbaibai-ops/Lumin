// ─── 幂等安装（第五十五轮）：同一个 key 上只允许存在最新一份监听 ──────────────────
//
// 背景（真实事故）：`typoraInlineMarks.ts` / `mathPreview.ts` 的监听装在 `window` /
// `view.dom` 这类**跨实例存活**的目标上，而闭包是每次实例化新造的。dev(HMR) 下模块被热替换
// 而视图被复用 ⇒ 再挂一份，`destroy()` 只卸得掉最后一份，旧闭包永远留在 window 上：
// 滚动/松手那一拍多份回调依次跑（实测：选区被改小、尾巴被丢）。
//
// 这里用**假 target**（只数 add/remove 调用）把机制钉死 —— 纯函数、不碰 DOM。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installOnce } from '../src/renderer/src/lib/editor/inlineMarkerCore.ts'

/** 假 EventTarget：只记录监听集合，用来断言"任何时刻只有一份" */
function fakeTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
    total() {
      let n = 0
      for (const set of listeners.values()) n += set.size
      return n
    }
  }
}

test('安装两次后监听仍是 1 份（旧的一份先被卸掉）', () => {
  const target = fakeTarget()
  const registry = new WeakMap()
  const key = {}
  const handler = () => {}
  let installs = 0
  const install = () => {
    installs += 1
    target.addEventListener('scroll', handler)
    return () => target.removeEventListener('scroll', handler)
  }
  installOnce(registry, key, install)
  assert.equal(target.count('scroll'), 1)
  installOnce(registry, key, install)
  assert.equal(installs, 2, '确实装了两次')
  assert.equal(target.count('scroll'), 1, '旧闭包被卸掉 —— 任何时刻只有一份')
})

test('多个 key 各自独立（不同视图互不影响）', () => {
  const target = fakeTarget()
  const registry = new WeakMap()
  const keyA = {}
  const keyB = {}
  const hA = () => {}
  const hB = () => {}
  installOnce(registry, keyA, () => {
    target.addEventListener('scroll', hA)
    return () => target.removeEventListener('scroll', hA)
  })
  installOnce(registry, keyB, () => {
    target.addEventListener('scroll', hB)
    return () => target.removeEventListener('scroll', hB)
  })
  assert.equal(target.count('scroll'), 2, '两个视图各一份')
  // 再装 A：只换掉 A 那一份，B 不动
  const hA2 = () => {}
  installOnce(registry, keyA, () => {
    target.addEventListener('scroll', hA2)
    return () => target.removeEventListener('scroll', hA2)
  })
  assert.equal(target.count('scroll'), 2, '总数仍是 2（A 换成新的那份）')
  assert.equal(target.count('scroll'), 2)
  assert.ok(target, 'target 仍可用')
})

test('返回的清理函数就是最后安装的那一份（destroy 卸得干净）', () => {
  const target = fakeTarget()
  const registry = new WeakMap()
  const key = {}
  const h1 = () => {}
  const h2 = () => {}
  installOnce(registry, key, () => {
    target.addEventListener('scroll', h1)
    return () => target.removeEventListener('scroll', h1)
  })
  const uninstall2 = installOnce(registry, key, () => {
    target.addEventListener('scroll', h2)
    return () => target.removeEventListener('scroll', h2)
  })
  assert.equal(target.count('scroll'), 1)
  uninstall2()
  assert.equal(target.count('scroll'), 0, '卸掉后一份后监听为空（旧的那份早已被卸）')
})

test('多类型监听：window 的 scroll(resize) + dom 的 focus 四个都只留一份', () => {
  const win = fakeTarget()
  const dom = fakeTarget()
  const registry = new WeakMap()
  const key = {}
  const events = ['focus', 'blur', 'compositionstart', 'compositionend']
  const install = () => {
    win.addEventListener('scroll', onScroll, true)
    win.addEventListener('resize', onScroll)
    for (const t of events) dom.addEventListener(t, onCaret)
    return () => {
      win.removeEventListener('scroll', onScroll, true)
      win.removeEventListener('resize', onScroll)
      for (const t of events) dom.removeEventListener(t, onCaret)
    }
  }
  const onScroll = () => {}
  const onCaret = () => {}
  installOnce(registry, key, install)
  assert.equal(win.total(), 2)
  assert.equal(dom.total(), 4)
  installOnce(registry, key, install)
  assert.equal(win.total(), 2, 'window 上仍是 2 份（scroll + resize）')
  assert.equal(dom.total(), 4, 'dom 上仍是 4 份（focus/blur/组字两端）')
})
