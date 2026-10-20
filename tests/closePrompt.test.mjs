// 关窗时「是否保存更改？」的判定（src/shared/closePrompt.ts）。
//
// 这条口径对齐主流编辑器的实测行为（自动保存默认关着；关窗时脏了才问）。
// 判错的两种表现都是用户能一眼看出来的：**该问不问** = 用户以为改动还在、其实被静默写盘或被丢弃；
// **不该问乱问** = 每次关窗都被拦一下（自动保存开着时尤其烦），系统关机时还会把窗口卡住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planClosePrompt } from '../src/shared/closePrompt.ts'

test('手动保存 + 有未保存改动 + 用户关窗 → 必须问', () => {
  assert.equal(planClosePrompt({ autoSave: false, dirty: true, reason: 'window' }), 'prompt')
})

test('手动保存 + 退出应用（quit）也要问（与关窗同一件事）', () => {
  assert.equal(planClosePrompt({ autoSave: false, dirty: true, reason: 'quit' }), 'prompt')
})

test('自动保存开着 → 不问（改动本来就在写盘路上）', () => {
  assert.equal(planClosePrompt({ autoSave: true, dirty: true, reason: 'window' }), 'flush')
  assert.equal(planClosePrompt({ autoSave: true, dirty: true, reason: 'quit' }), 'flush')
})

test('没有未保存的改动 → 不问', () => {
  assert.equal(planClosePrompt({ autoSave: false, dirty: false, reason: 'window' }), 'flush')
})

test('系统关机/注销 → 一律不问（没人能点那个按钮），直接落盘', () => {
  assert.equal(planClosePrompt({ autoSave: false, dirty: true, reason: 'session-end' }), 'flush')
  // 自动保存关着也不问 —— 这条是 session-end 与其它两种 reason 的唯一区别
  assert.notEqual(
    planClosePrompt({ autoSave: false, dirty: true, reason: 'session-end' }),
    planClosePrompt({ autoSave: false, dirty: true, reason: 'window' })
  )
})
