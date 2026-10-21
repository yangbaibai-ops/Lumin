// ─── 右侧栏：两个按钮 toggle 的状态机 + 持久化/无障碍契约 ─────────────────────
//
// 用户口径（原话要点）：「不要…顶部标签切换，而是各自占用侧边栏的两个按钮，
// 不要有展开/收起侧边栏的按钮，两个按钮点击就可出现对应的侧边栏，再次点击就可以收回。」
//
// 这条测试守三件事：
//   1. 状态规则（纯函数 lib/sidebarPanels.ts）：互斥切换 / 再点收起 / 收起态点任意一个展开；
//   2. 源码契约：两枚按钮带 aria-pressed、没有 tablist/tab/aria-selected；
//      **没有**任何独立的隐藏/显示按钮 —— 收起只靠再点当前面板；
//   3. 收起态是 34px 窄条，两枚按钮仍在（data-sidebar-rail），状态接**既有**持久化键
//      （outlineRightExpanded）；左栏的隐藏按钮不属于「大纲/AI」这套，保持原样。
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

// 只检查真正的标记/属性：先剥掉 HTML 注释与行注释（注释里会解释"为什么不是页签"）
const markup = () => OUTLINE_PANEL.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')

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

test('收起态点任意面板：展开并直接显示它（窄条按钮的路径）', () => {
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
test('右侧栏：恰好两个独立按钮（大纲 / AI）+ aria-pressed，没有页签语义', () => {
  const ids = [...OUTLINE_PANEL.matchAll(/\{ id: '(outline|ai)'/g)].map((m) => m[1])
  assert.deepEqual(ids, ['outline', 'ai'], '按钮表必须恰好是 outline / ai 两项')
  assert.match(OUTLINE_PANEL, /data-sidebar-buttons/, '缺少两个按钮的容器')
  assert.match(OUTLINE_PANEL, /v-for="p in PANELS"/, '两枚按钮来自同一份表')
  assert.match(OUTLINE_PANEL, /:data-sidebar-tab="p\.id"/, '按钮缺少 data-sidebar-tab')
  assert.match(
    OUTLINE_PANEL,
    /:aria-pressed="isShown\(p\.id\) \? 'true' : 'false'"/,
    '两枚按钮都必须用 aria-pressed 表达"面板正在显示"'
  )
  assert.doesNotMatch(markup(), /role="tablist"|role="tab"|aria-selected/, '不许再有页签语义')
  assert.doesNotMatch(markup(), /RIGHT_TABS|onTabsKeydown/, '旧的页签实现应删除')
})

test('右侧栏：没有独立的隐藏/显示侧边栏按钮，收起只靠再点当前面板', () => {
  assert.doesNotMatch(markup(), /data-sidebar-hide\b/, '不许再有隐藏按钮')
  assert.doesNotMatch(markup(), /data-sidebar-show\b/, '不许再有显示按钮')
  assert.doesNotMatch(OUTLINE_PANEL, /function toggle\(/, '隐藏/显示函数应删除')
  assert.match(OUTLINE_PANEL, /:data-sidebar-collapsed=/, '缺少收起态标记')
  assert.match(OUTLINE_PANEL, /data-sidebar-rail/, '收起态必须是窄条')
  assert.match(OUTLINE_PANEL, /@click="selectPanel\(p\.id\)"/, '两枚按钮都走同一条 toggle 规则')
})

test('右侧栏：展开/收起接既有持久化键，没有新造 sidebar 状态', () => {
  assert.match(OUTLINE_PANEL, /settings\.set\('outlineRightExpanded'/, '收起状态必须落既有键')
  assert.match(OUTLINE_PANEL, /outlineRightExpanded/, '缺少展开状态')
  assert.doesNotMatch(
    UI_STORE,
    /rightSidebarVisible|sidebarExpanded/,
    'ui store 不许新造侧栏可见键'
  )
  assert.match(UI_STORE, /sidebarVisible:/, '左侧栏沿用的既有键必须还在')
})

test('左侧栏：隐藏按钮与「大纲/AI」无关，保持原样（不改左栏）', () => {
  assert.match(APP_SIDEBAR, /data-sidebar-hide/, '左侧栏隐藏按钮不在本次删除范围')
  assert.match(APP_SIDEBAR, /function hideSidebar/, '左侧栏沿用 hideSidebar 实现')
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

test('两个面板都常驻 DOM（收起/切换只切显隐，滚动位置与聊天记录不丢）', () => {
  assert.match(
    OUTLINE_PANEL,
    /<div v-show="!hidden" class="flex min-h-0 flex-1 flex-col">/,
    '内容块必须是 v-show（不能用 v-if 卸载，否则滚动位置会丢）'
  )
  assert.match(
    OUTLINE_PANEL,
    /v-show="ui\.rightTab === 'outline'"[\s\S]{0,200}id="sidebar-panel-outline"/
  )
  assert.match(OUTLINE_PANEL, /v-show="ui\.rightTab === 'ai'"[\s\S]{0,200}id="sidebar-panel-ai"/)
  assert.match(OUTLINE_PANEL, /<AiChatPanel :active="ui\.rightTab === 'ai'" \/>/)
})
