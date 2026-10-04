// Ctrl+F 分流规则（`src/renderer/src/lib/ctrlFRoute.ts`）的单元测试。
//
// 为什么值得单测：这条规则决定「Ctrl+F 会不会把正文查找弄丢」——真出问题时表现是
// 「侧栏里按 Ctrl+F 没反应」或「编辑器里按 Ctrl+F 变成筛文件」，两种都很难在
// CDP 套件里穷举（那层要真起窗口、还要造出"指针恰好停在侧栏上"的现场）。
// 端到端那一侧见 `_verify-sidebar-search.js`（A/B/C 三向 + 指针那一档）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ctrlFTarget } from '../src/renderer/src/lib/ctrlFRoute.ts'

const base = {
  workspaceOpen: true,
  filesPanelVisible: true,
  focusInSidebar: false,
  focusInEditor: false,
  sidebarPointerRecent: false,
  pointerInSidebar: false
}

test('焦点在侧栏里 → 侧栏的文件名搜索', () => {
  assert.equal(ctrlFTarget({ ...base, focusInSidebar: true }), 'sidebar-files')
})

test('指针停在侧栏上（焦点不在编辑区）→ 也算在侧栏里', () => {
  assert.equal(ctrlFTarget({ ...base, pointerInSidebar: true }), 'sidebar-files')
})

/**
 * ⚠️ 第十轮的时序判据（`_verify-sidebar-search` 的 B/D 两段同时变红暴露的）：
 * 这两段的"焦点 + 此刻指针"**完全一样**（焦点在编辑区、指针悬在侧栏），但意图相反 ——
 *
 *   B：先动鼠标（侧栏里点过搜索框）→ 再点进正文 → Ctrl+F ⇒ 找**正文**（指针是上一次的残留）
 *   D：先点正文 → 再把鼠标移到侧栏的树行上 → Ctrl+F ⇒ 筛**文件名**（鼠标是这一次的动作）
 *
 * 唯一能区分它们的是"最近一次交互落在哪个区域"，也就是 `sidebarPointerRecent`。
 */
test('焦点在编辑区 + 最近动的是鼠标（在侧栏）→ 侧栏搜索（D 段）', () => {
  assert.equal(
    ctrlFTarget({
      ...base,
      focusInEditor: true,
      pointerInSidebar: true,
      sidebarPointerRecent: true
    }),
    'sidebar-files'
  )
})

test('焦点在编辑区 + 最近动的是焦点（指针只是残留）→ 正文查找（B 段）', () => {
  assert.equal(
    ctrlFTarget({
      ...base,
      focusInEditor: true,
      pointerInSidebar: true,
      sidebarPointerRecent: false
    }),
    'document'
  )
})

test('焦点同时在两侧时（理论上不该发生）以侧栏为准：在侧栏里按 Ctrl+F 就是筛文件', () => {
  assert.equal(
    ctrlFTarget({
      ...base,
      focusInSidebar: true,
      focusInEditor: true,
      sidebarPointerRecent: true,
      pointerInSidebar: true
    }),
    'sidebar-files'
  )
})

test('焦点与指针都不在侧栏 → 正文查找（编辑器那边的基本功不能丢）', () => {
  assert.equal(ctrlFTarget({ ...base, focusInEditor: true }), 'document')
  assert.equal(ctrlFTarget(base), 'document')
})

test('没有工作区 → 正文查找（没有文件名可筛，开了也是空框）', () => {
  assert.equal(
    ctrlFTarget({ ...base, workspaceOpen: false, focusInSidebar: true, pointerInSidebar: true }),
    'document'
  )
})

test('左栏正在显示大纲 → 正文查找（那份搜索框此刻不可见）', () => {
  assert.equal(ctrlFTarget({ ...base, filesPanelVisible: false, focusInSidebar: true }), 'document')
})

test('没有工作区 + 显示大纲：两个理由都指向正文查找', () => {
  assert.equal(
    ctrlFTarget({
      workspaceOpen: false,
      filesPanelVisible: false,
      focusInSidebar: true,
      pointerInSidebar: true
    }),
    'document'
  )
})
