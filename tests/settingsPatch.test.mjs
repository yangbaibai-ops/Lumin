// `deepMerge`（`src/shared/settingsSchema.ts`）的单元测试。
//
// 为什么单独钉它：它是**设置合并**的唯一实现 —— IPC 的 `settings:update` 与原生菜单的
// 主题项（`patchSettings`）都走它。它的三条语义任何一条错了都会出真 bug：
//   * 数组整体替换（不是按元素合并）—— 最近文档/快捷键覆盖表靠这条；
//   * `undefined` 不覆盖 —— 渲染层把整份 state 传上来时，没填的键不能把已有值抹掉；
//   * 嵌套对象递归合并 —— `keybindings` 这种映射只改一条键时不能把整张表换掉。
// （搬到这里之前它是 `main/ipc.ts` 里的私有函数，只有"读代码"这一种保护方式。）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deepMerge } from '../src/shared/settingsSchema.ts'

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
