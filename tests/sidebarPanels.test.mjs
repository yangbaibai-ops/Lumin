// ─── 右侧栏：两个独立按钮的状态机 + 持久化/无障碍契约 ─────────────────────────
//
// 用户口径（原话要点）：「不是把 AI 和大纲放在同一视图的不同标签，而是显示在侧边栏的
// 两个按钮，一个按钮打开大纲，一个按钮打开 AI，且用户可以选择隐藏/显示侧边栏。」
//
// 这条测试守两件事：
//   1. 状态规则（纯函数 lib/sidebarPanels.ts）：互斥切换 / 再点收起 / 收起态点任意一个展开；
//   2. 源码契约：两个按钮带 aria-pressed、没有 tablist/tab/aria-selected；隐藏/显示按钮
//      与状态持久化接的是**既有**键（outlineRightExpanded / ui.sidebarVisible），没有新造；
//      快捷键是用户点名的 Mod+Shift+L，旧键 Mod+Shift+B 仍保留。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { clickSidebarPanel } from '../src/renderer/src/lib/sidebarPanels.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const OUTLINE_PANEL = read('src/renderer/src/components/OutlinePanel.vue')
const APP_SIDEBAR = read('src/renderer/src/components/AppSidebar.vue')
const UI_STORE = read('src/renderer/src/stores/ui.ts')
const KEYMAP = read('src/renderer/src/composables/useKeymap.ts')

// ── 状态机 ───────────────────────────────────────────────────────────────────
test('点非当前面板：显示该面板（互斥切换）', () => {
  assert.deepEqual(clickSidebarPanel({ expanded: true, panel: 'outline' }, 'ai'), {
    expanded: true,
    panel: 'ai'
  })
  assert.deepEqual(clickSidebarPanel({ expanded: true, panel: 'ai' }, 'outline'), {
    expanded: true,
    panel: 'outline'
  })
})

test('再点当前面板：收起整栏（面板选择保留，重新展开时回到原来那个）', () => {
  assert.deepEqual(clickSidebarPanel({ expanded: true, panel: 'ai' }, 'ai'), {
    expanded: false,
    panel: 'ai'
  })
  assert.deepEqual(clickSidebarPanel({ expanded: true, panel: 'outline' }, 'outline'), {
    expanded: false,
    panel: 'outline'
  })
})

test('收起态点任意面板：展开并直接显示它（窄轨按钮的路径）', () => {
  assert.deepEqual(clickSidebarPanel({ expanded: false, panel: 'outline' }, 'ai'), {
    expanded: true,
    panel: 'ai'
  })
  assert.deepEqual(clickSidebarPanel({ expanded: false, panel: 'ai' }, 'outline'), {
    expanded: true,
    panel: 'outline'
  })
})

test('状态机是纯函数：不修改入参', () => {
  const state = { expanded: true, panel: 'outline' }
  const next = clickSidebarPanel(state, 'ai')
  assert.deepEqual(state, { expanded: true, panel: 'outline' })
  assert.notEqual(next, state)
})

// ── 组件契约 ─────────────────────────────────────────────────────────────────
test('右侧栏：两个独立按钮 + aria-pressed，不再有页签语义', () => {
  assert.match(OUTLINE_PANEL, /data-sidebar-buttons/, '缺少两个按钮的容器')
  assert.match(OUTLINE_PANEL, /:data-sidebar-tab="p\.id"/, '按钮缺少 data-sidebar-tab')
  assert.equal(
    (OUTLINE_PANEL.match(/:aria-pressed=/g) ?? []).length >= 3,
    true,
    '面板按钮与隐藏按钮都要 aria-pressed'
  )
  assert.match(OUTLINE_PANEL, /data-sidebar-hide/, '缺少隐藏按钮')
  assert.match(OUTLINE_PANEL, /data-sidebar-show/, '缺少窄轨里的显示按钮')
  assert.match(OUTLINE_PANEL, /data-sidebar-rail/, '隐藏态必须有窄轨')
  assert.match(OUTLINE_PANEL, /:data-sidebar-hidden=/, '缺少隐藏态标记')
  // 注释里会解释"为什么不是页签"，检查的是**真正的标记/属性**：先剥掉 HTML 与行注释
  const markup = OUTLINE_PANEL.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(markup, /role="tablist"|role="tab"|aria-selected/, '不许再有页签语义')
  assert.doesNotMatch(markup, /RIGHT_TABS|onTabsKeydown/, '旧的页签实现应删除')
})

test('右侧栏：隐藏/显示接既有持久化键，没有新造 sidebar 状态', () => {
  assert.match(OUTLINE_PANEL, /settings\.set\('outlineRightExpanded'/, '隐藏状态必须落既有键')
  assert.match(OUTLINE_PANEL, /outlineRightExpanded/, '缺少展开状态')
  assert.doesNotMatch(
    UI_STORE,
    /rightSidebarVisible|sidebarExpanded/,
    'ui store 不许新造侧栏可见键'
  )
  assert.match(UI_STORE, /sidebarVisible:/, '左侧栏沿用的既有键必须还在')
})

test('左侧栏：隐藏按钮写同一个 ui.sidebarVisible + settings.sidebarVisible', () => {
  assert.match(APP_SIDEBAR, /data-sidebar-hide/, '左侧栏缺少隐藏按钮')
  assert.match(APP_SIDEBAR, /function hideSidebar/, '缺少 hideSidebar 实现')
  assert.match(APP_SIDEBAR, /ui\.sidebarVisible = false/, '必须改既有 ui.sidebarVisible')
  assert.match(APP_SIDEBAR, /settings\.set\('sidebarVisible'/, '必须落既有 settings.sidebarVisible')
})

test('快捷键：Ctrl/Cmd+Shift+L 为主，旧键 Ctrl/Cmd+Shift+B 保留', () => {
  assert.match(
    KEYMAP,
    /id: 'view\.toggleSidebar',[\s\S]{0,220}defaultKeys: 'Mod\+Shift\+L'/,
    '主快捷键应为 Mod+Shift+L'
  )
  assert.match(
    KEYMAP,
    /id: 'view\.toggleSidebarLegacy',[\s\S]{0,220}defaultKeys: 'Mod\+Shift\+B'/,
    '旧快捷键必须保留为独立命令'
  )
})

test('两个面板都常驻 DOM（切换只切显隐，聊天记录/滚动位置不丢）', () => {
  assert.match(
    OUTLINE_PANEL,
    /v-show="ui\.rightTab === 'outline'"[\s\S]{0,200}id="sidebar-panel-outline"/
  )
  assert.match(OUTLINE_PANEL, /v-show="ui\.rightTab === 'ai'"[\s\S]{0,200}id="sidebar-panel-ai"/)
  assert.match(OUTLINE_PANEL, /<AiChatPanel :active="ui\.rightTab === 'ai'" \/>/)
})
