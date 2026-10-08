// `src/shared/settingsSchema.ts` 里**设置合并口径**的单元测试。
//
// 为什么单独钉它：它是设置写入的唯一合并实现 —— IPC 的 `settings:update`、原生菜单的主题项
// （`patchSettings`）都走它。语义错一条就会出真 bug：
//   * 数组整体替换（不是按元素合并）；
//   * `undefined` 不覆盖 —— 渲染层把整份 state 传上来时，没填的键不能把已有值抹掉；
//   * 嵌套对象递归合并（`export.pdf` 这种）；
//   * **自由映射键（`keybindings`）整块替换** —— 这条曾经写反了：
//     `keybindings` 是 `{命令 id: 键位}`，"恢复默认/解绑"= 新表里没有那个键，而深合并**永远不会删**，
//     于是会话内看着恢复了默认、盘上那份旧表还在，**重启后自定义键位复活**（用户实测）。
//     所以这里同时钉两件事：`deepMerge` 仍是通用深合并（它还被递归复用），
//     而**设置写入用的 `mergeSettings`** 必须整块替换自由映射。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deepMerge, mergeSettings } from '../src/shared/settingsSchema.ts'

test('deepMerge：嵌套对象递归合并，未提到的键原样保留', () => {
  const base = { keybindings: { save: 'Ctrl+S', find: 'Ctrl+F' }, theme: 'auto' }
  const out = deepMerge(base, { keybindings: { find: 'Ctrl+Shift+F' } })
  assert.deepEqual(out, {
    keybindings: { save: 'Ctrl+S', find: 'Ctrl+Shift+F' },
    theme: 'auto'
  })
  // 不改原对象（纯函数）
  assert.equal(base.keybindings.find, 'Ctrl+F')
})

test('deepMerge：数组整体替换，不按元素合并', () => {
  const base = { recentFiles: [{ path: 'a' }, { path: 'b' }] }
  const out = deepMerge(base, { recentFiles: [{ path: 'c' }] })
  assert.deepEqual(out.recentFiles, [{ path: 'c' }])
})

test('deepMerge：undefined 不覆盖已有值（渲染层整份 state 回传时不能抹掉没填的键）', () => {
  const base = { theme: 'dark', fontSize: 15 }
  const out = deepMerge(base, { theme: undefined, fontSize: 16 })
  assert.equal(out.theme, 'dark')
  assert.equal(out.fontSize, 16)
})

test('deepMerge：对象替换数组 / 标量替换对象都按"后者整体覆盖"', () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: { b: 1 } }).a, { b: 1 })
  assert.equal(deepMerge({ a: { b: 1 } }, { a: 5 }).a, 5)
  assert.equal(deepMerge({ a: null }, { a: { b: 1 } }).a.b, 1)
})

// ─── mergeSettings：设置写入的口径 ──────────────────────────────────────────

test('mergeSettings：keybindings 整块替换 —— 恢复默认（空表）必须真的把盘上那份清空', () => {
  const base = { keybindings: { 'file.save': 'Ctrl+S', 'view.focusMode': 'Ctrl+Alt+J' } }
  // 这是"全部恢复默认"推上来的那一份：空表 = 没有任何覆盖项
  assert.deepEqual(mergeSettings(base, { keybindings: {} }).keybindings, {})
  // 单条恢复默认：新表里没有那一条 —— 深合并下它会复活，整块替换下它真的没了
  assert.deepEqual(mergeSettings(base, { keybindings: { 'file.save': 'Ctrl+S' } }).keybindings, {
    'file.save': 'Ctrl+S'
  })
  // 解绑（显式 null）照样能写进去
  assert.deepEqual(mergeSettings(base, { keybindings: { 'view.focusMode': null } }).keybindings, {
    'view.focusMode': null
  })
})

test('mergeSettings：patch 里没有 keybindings 时不动用户的覆盖表（局部更新不误清空）', () => {
  const base = { keybindings: { 'file.save': 'Ctrl+S' }, theme: 'dark' }
  const out = mergeSettings(base, { theme: 'light' })
  assert.deepEqual(out.keybindings, { 'file.save': 'Ctrl+S' })
  assert.equal(out.theme, 'light')
})

test('mergeSettings：其余嵌套对象仍然递归合并（只有自由映射整块替换）', () => {
  const base = { export: { pdf: { margin: 24, pageSize: 'A4' }, html: { template: 'default' } } }
  const out = mergeSettings(base, { export: { pdf: { margin: 12 } } })
  assert.deepEqual(out.export, {
    pdf: { margin: 12, pageSize: 'A4' },
    html: { template: 'default' }
  })
})
