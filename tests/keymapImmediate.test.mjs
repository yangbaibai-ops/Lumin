// ─── 快捷键「保存后立即生效」：服务端同步重建 + 0 延迟分发 ─────────────────────
//
// 用户报障：「设置快捷键后不能立即生效，要等一会」。
// 这条测试把「保存 → 生效」钉成**同一个同步调用栈**里的事：
//   * 写入覆盖表后调用 `refreshKeymap()`（settings.setKeybinding 就是这么做的）；
//   * 紧接着（0ms、不等任何定时器/IPC）派发新键，命中计数必须 +1；
//   * 旧键在同一个同步栈里就必须失效；
//   * 解绑 / dispose 后 `refreshKeymap()` 不会把监听又装回来。
//
// 这里用**最小 window 桩**（只实现 add/removeEventListener + 手动派发）：
// `lib/keymap/service.ts` 不碰 Vue、不碰 DOM 结构，只依赖 window 的事件注册。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

// service.ts 里是「无扩展名的相对 import」（'./keys'），Node 原生 ESM 认不出
installTsExtensionResolve()
const { disposeKeymap, installKeymap, refreshKeymap } =
  await import('../src/renderer/src/lib/keymap/service.ts')

/** 记录当前注册的 keydown 监听（install 会先移除上一份） */
const listeners = new Set()
globalThis.window = {
  addEventListener(type, fn) {
    if (type === 'keydown') listeners.add(fn)
  },
  removeEventListener(type, fn) {
    if (type === 'keydown') listeners.delete(fn)
  }
}

/** 造一个最小 KeyboardEvent（只带分发器读的字段） */
function keydown(patch) {
  return {
    type: 'keydown',
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    defaultPrevented: false,
    isComposing: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      /* 桩：分发器调用它即可，无需实现 */
    },
    ...patch
  }
}

/** 同步派发一次按键（捕获阶段等价物：直接调用监听器） */
function fire(e) {
  const snapshot = [...listeners]
  for (const fn of snapshot) fn(e)
  return e
}

const CTRL_ALT_J = { key: 'j', ctrlKey: true, altKey: true }
const CTRL_SHIFT_F = { key: 'f', ctrlKey: true, shiftKey: true }

let ran = 0
const commands = [
  {
    id: 'view.focusMode',
    titleKey: 'menu.focusMode',
    groupKey: 'keymap.groupView',
    defaultKeys: 'Ctrl+Shift+F',
    run: () => {
      ran += 1
    }
  }
]

test('默认键命中；改绑前新键不命中', () => {
  const overrides = {}
  installKeymap(commands, () => overrides)
  ran = 0
  fire(keydown(CTRL_SHIFT_F))
  assert.equal(ran, 1, '默认键应命中')
  fire(keydown(CTRL_ALT_J))
  assert.equal(ran, 1, '改绑前 Ctrl+Alt+J 不该命中')
})

test('★ 写入覆盖表 + refreshKeymap 后：同一个同步栈里新键立即命中、旧键立即失效', () => {
  const overrides = { 'view.focusMode': 'Ctrl+Alt+J' }
  installKeymap(commands, () => overrides)
  // 模拟 settings.setKeybinding：改值 → 同步重建
  let t0 = 0
  let t1 = 0
  ran = 0
  overrides['view.focusMode'] = 'Ctrl+Alt+J'
  t0 = performance.now()
  refreshKeymap()
  fire(keydown(CTRL_ALT_J))
  t1 = performance.now()
  assert.equal(ran, 1, '保存后 0 延迟内按新键必须触发')
  assert.ok(t1 - t0 < 50, `保存到触发耗时 ${(t1 - t0).toFixed(2)}ms，应 < 50ms`)
  assert.equal(
    fire(keydown(CTRL_SHIFT_F)).defaultPrevented,
    false,
    '旧键必须立即让位（不命中就不 preventDefault）'
  )
  assert.equal(ran, 1, '旧键不得再执行命令')

  // 再次改绑（同一同步栈），证明不是一次性快照
  overrides['view.focusMode'] = 'Ctrl+Shift+P'
  refreshKeymap()
  fire(keydown({ key: 'p', ctrlKey: true, shiftKey: true }))
  assert.equal(ran, 2, '第二次改绑也要立即生效')
  fire(keydown(CTRL_ALT_J))
  assert.equal(ran, 2, '上一次的新键必须失效')
})

test('解绑（null）+ refresh：任何键都不触发', () => {
  const overrides = { 'view.focusMode': null }
  installKeymap(commands, () => overrides)
  refreshKeymap()
  ran = 0
  fire(keydown(CTRL_ALT_J))
  fire(keydown(CTRL_SHIFT_F))
  assert.equal(ran, 0, '解绑后命令不得被任意键触发')
})

test('dispose 后 refreshKeymap 不得把监听重新装回来', () => {
  installKeymap(commands, () => ({ 'view.focusMode': 'Ctrl+Alt+J' }))
  disposeKeymap()
  refreshKeymap()
  assert.equal(listeners.size, 0, 'dispose 后监听表应为空')
})

test('data-keymap-capture 的输入框：全局分发器让行（按键搜索不许触发命令）', () => {
  installKeymap(commands, () => ({ 'view.focusMode': 'Ctrl+Alt+J' }))
  ran = 0
  const e = fire(
    keydown({
      ...CTRL_ALT_J,
      target: {
        closest: (sel) => (sel === '[data-keymap-capture]' ? {} : null)
      }
    })
  )
  assert.equal(ran, 0, '按键搜索输入框里的组合键不得执行命令')
  assert.equal(e.defaultPrevented, false)
})
