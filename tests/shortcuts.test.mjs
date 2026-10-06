// 浏览器级快捷键策略（`src/shared/shortcuts.ts`）——**F12 不再打开开发者工具**的静态守卫。
//
// 为什么值得单测：这条口径是"安全/可用性"而不是外观 —— 用户要求取消 F12 那条隐式入口，
// 而 `before-input-event` 里的条件判断**起个真窗口才测得到**。策略抽成纯函数之后，
// 这里就能把「哪些键被屏蔽 / 哪些被保留」钉死；CDP 套件（`tools/_verify-devtools.js`）
// 再在真窗口里按一次 F12 做端到端确认。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedShortcut, devShortcut } from '../src/shared/shortcuts.ts'

/** 造一份 `before-input-event` 的输入（默认 keyDown + 全修饰键为假） */
const key = (k, mods = {}, type = 'keyDown') => ({
  type,
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods
})

test('F12 被屏蔽（用户口径：F12 不再打开/关闭开发者工具）', () => {
  assert.equal(blockedShortcut(key('F12')), true)
  assert.equal(blockedShortcut(key('f12')), true)
  // 带修饰键的 F12 同样屏蔽（别留"Ctrl+F12 还能开"这种后门）
  assert.equal(blockedShortcut(key('F12', { control: true })), true)
  assert.equal(blockedShortcut(key('F12', { shift: true })), true)
})

test('Ctrl+Shift+I 与 macOS 的 Cmd+Alt+I 一并屏蔽（第二条 DevTools 路径）', () => {
  assert.equal(blockedShortcut(key('i', { control: true, shift: true })), true)
  assert.equal(blockedShortcut(key('I', { control: true, shift: true })), true)
  assert.equal(blockedShortcut(key('i', { meta: true, alt: true })), true)
})

test('只按 Ctrl+I 之类**不能**被连坐（那是编辑器/系统的正常键）', () => {
  // 判据必须带上 shift / alt：只按 Ctrl+I 不是 DevTools 快捷键
  assert.equal(blockedShortcut(key('i', { control: true })), false)
  assert.equal(blockedShortcut(key('i', { shift: true })), false)
  assert.equal(blockedShortcut(key('i', { alt: true })), false)
  assert.equal(blockedShortcut(key('i')), false)
})

test('屏蔽只在 keyDown 生效（keyUp 不该再 preventDefault）', () => {
  assert.equal(blockedShortcut(key('F12', {}, 'keyUp')), false)
  assert.equal(blockedShortcut(key('i', { control: true, shift: true }, 'char')), false)
})

test('开发态保留重新加载与全屏，且**与 DevTools 无关**', () => {
  assert.equal(devShortcut(key('r', { control: true })), 'reload')
  assert.equal(devShortcut(key('R', { meta: true })), 'reload')
  assert.equal(devShortcut(key('F5')), 'reload')
  assert.equal(devShortcut(key('f5')), 'reload')
  assert.equal(devShortcut(key('F11')), 'fullscreen')
})

test('保留清单里没有 DevTools 任何入口（F12 / Ctrl+Shift+I 都不是保留项）', () => {
  for (const input of [
    key('F12'),
    key('i', { control: true, shift: true }),
    key('i', { meta: true, alt: true })
  ]) {
    assert.equal(devShortcut(input), null, `不该被保留：${JSON.stringify(input)}`)
  }
  // 其余键一律不接管（交给系统默认行为 / 渲染层的命令表）
  for (const input of [key('a'), key('z', { control: true }), key('F1'), key('F12')]) {
    assert.equal(devShortcut(input), null, `不该被接管：${JSON.stringify(input)}`)
  }
})
