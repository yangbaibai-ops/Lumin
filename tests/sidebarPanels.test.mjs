// ─── 右侧停靠栏：active / expanded / rightDockVisible 三态 + DOM 契约 ─────────────
//
// 用户口径（第三次澄清 + 本轮「主分支移除 AI」）：
//   「保留右侧停靠栏；主分支上只留『大纲』一个按钮，点击就在右侧区域展示大纲，
//     并且用户可以在设置中开启或关闭右侧停靠栏。」
//
// 结构上停靠栏与面板是**两块 DOM**：
//   * dock（RightDock.vue）在窗口最右侧，常驻 40px，竖排一个按钮（大纲）；
//   * 面板（OutlinePanel.vue）在 dock 左侧，显隐与 dock 是否显示互不影响。
// 这条测试守：
//   1. 纯函数状态机（同按钮收起 / rightDockVisible 关掉时不可达）；
//   2. dock 恰好一个按钮、aria-pressed、role=toolbar，无 tablist/tab/aria-selected；
//   3. 面板里**没有**任何按钮（旧实现把按钮放在面板顶部）；
//   4. 面板/停靠栏的显隐分别接 settings + ui，新增设置默认 true。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  clickRightDockButton,
  isRightDockPanelVisible,
  isRightDockVisible
} from '../src/renderer/src/lib/sidebarPanels.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const RIGHT_DOCK = read('src/renderer/src/components/RightDock.vue')
const OUTLINE_PANEL = read('src/renderer/src/components/OutlinePanel.vue')
const EDITOR_VIEW = read('src/renderer/src/views/EditorView.vue')
const DEFAULTS = read('src/shared/defaults.ts')
const TYPES = read('src/shared/types.ts')
const SETTINGS_DIALOG = read('src/renderer/src/components/SettingsDialog.vue')
const UI_STORE = read('src/renderer/src/stores/ui.ts')

// 只检查真正的标记/属性：先剥掉 HTML 注释与行注释（注释里会解释“为什么不是页签”）
const markup = (text) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')

const base = { active: 'outline', expanded: true, rightDockVisible: true }

// ── 状态机：active / expanded / rightDockVisible ─────────────────────────────
test('再点当前面板：只收起 expanded，active 保留（dock 仍在）', () => {
  const next = clickRightDockButton(base, 'outline')
  assert.deepEqual(next, { active: 'outline', expanded: false, rightDockVisible: true })
  assert.equal(isRightDockPanelVisible(next, 'outline'), false)
  assert.equal(isRightDockVisible(next), true, '面板收起不影响 dock 本身')
})

test('单独收起 expanded 后，点按钮：展开并显示大纲', () => {
  const collapsed = { ...base, expanded: false }
  assert.deepEqual(clickRightDockButton(collapsed, 'outline'), {
    active: 'outline',
    expanded: true,
    rightDockVisible: true
  })
})

test('rightDockVisible=false：整条 dock 不可见，按钮不可达（状态机原样返回）', () => {
  const hidden = { active: 'outline', expanded: true, rightDockVisible: false }
  assert.equal(isRightDockVisible(hidden), false)
  assert.equal(isRightDockPanelVisible(hidden, 'outline'), false)
  assert.deepEqual(clickRightDockButton(hidden, 'outline'), hidden)
})

test('三个状态互不串味：active 与 expanded 分离、rightDockVisible 只控制整条 dock', () => {
  const state = { active: 'outline', expanded: false, rightDockVisible: true }
  assert.equal(isRightDockPanelVisible(state, 'outline'), false, '收起时面板不可见')
  assert.equal(isRightDockVisible(state), true)
  assert.deepEqual(clickRightDockButton(state, 'outline'), {
    active: 'outline',
    expanded: true,
    rightDockVisible: true
  })
})

test('状态机是纯函数：不修改入参', () => {
  const state = { active: 'outline', expanded: true, rightDockVisible: true }
  const next = clickRightDockButton(state, 'outline')
  assert.deepEqual(state, { active: 'outline', expanded: true, rightDockVisible: true })
  assert.notEqual(next, state)
})

// ── dock 组件契约 ───────────────────────────────────────────────────────────
test('RightDock：独立元素、40px 竖条、恰好一个按钮（大纲）', () => {
  assert.match(RIGHT_DOCK, /<aside[\s\S]*?data-right-dock/, 'dock 必须是独立元素')
  assert.match(RIGHT_DOCK, /role="toolbar"/, 'dock 应有 toolbar 语义')
  assert.match(RIGHT_DOCK, /aria-orientation="vertical"/, 'dock 是竖向工具栏')
  assert.match(RIGHT_DOCK, /w-10/, 'dock 宽度应为 40px（w-10）')
  assert.match(RIGHT_DOCK, /flex-col/, '按钮必须竖排')
  const ids = [...RIGHT_DOCK.matchAll(/\{ id: '(outline|ai)'/g)].map((m) => m[1])
  assert.deepEqual(ids, ['outline'], '按钮表必须只剩 outline 一项')
  assert.doesNotMatch(markup(RIGHT_DOCK), /'ai'|ai\.chat|sparkles/, '主分支不许再有 AI 按钮入口')
  assert.match(RIGHT_DOCK, /v-for="p in PANELS"/, '按钮来自 PANELS 表')
  assert.match(RIGHT_DOCK, /data-right-dock-button/, '按钮缺少 data-right-dock-button')
  assert.match(
    RIGHT_DOCK,
    /:aria-pressed="isRightDockPanelVisible\(state, p\.id\) \? 'true' : 'false'"/,
    '按钮必须用 aria-pressed 表达“面板正在显示”'
  )
  assert.match(RIGHT_DOCK, /:aria-label="t\(p\.labelKey\)"/, '按钮缺少 aria-label')
  assert.match(RIGHT_DOCK, /:title="t\(p\.labelKey\)"/, '按钮缺少 tooltip（title）')
  assert.match(RIGHT_DOCK, /data-panel="p\.id"/, '按钮缺少面板标记')
})

test('RightDock：没有页签语义、没有面板内部隐藏/显示按钮', () => {
  assert.doesNotMatch(markup(RIGHT_DOCK), /role="tablist"|role="tab"|aria-selected/)
  assert.doesNotMatch(markup(RIGHT_DOCK), /data-sidebar-hide|data-sidebar-show/)
  assert.doesNotMatch(markup(RIGHT_DOCK), /data-sidebar-buttons/, '按钮不该再长在面板顶部')
})

// ── 面板组件契约 ───────────────────────────────────────────────────────────
test('OutlinePanel：面板里没有任何按钮（按钮只属于 dock）', () => {
  assert.doesNotMatch(markup(OUTLINE_PANEL), /<button\b/, '面板里不许再有按钮')
  assert.doesNotMatch(markup(OUTLINE_PANEL), /data-sidebar-buttons/, '旧的顶部按钮栏应删除')
  assert.doesNotMatch(markup(OUTLINE_PANEL), /role="tablist"|role="tab"|aria-selected/)
  assert.doesNotMatch(markup(OUTLINE_PANEL), /data-sidebar-hide|data-sidebar-show/)
  assert.match(OUTLINE_PANEL, /data-outline-panel/, '面板必须保留 data-outline-panel')
  assert.match(
    OUTLINE_PANEL,
    /v-show="settings\.outlineRightExpanded"/,
    '面板显隐必须独立于 dock（v-show，常驻 DOM）'
  )
})

test('OutlinePanel：只渲染大纲，AI 面板与右栏切换逻辑已移除', () => {
  assert.match(OUTLINE_PANEL, /id="right-dock-panel-outline"/)
  assert.match(OUTLINE_PANEL, /<Outline \/>/)
  assert.doesNotMatch(OUTLINE_PANEL, /rightDockActive|AiChatPanel|right-dock-panel-ai/)
  assert.doesNotMatch(OUTLINE_PANEL, /ai\.chat|aiActive/)
})

test('EditorView：dock 与面板作为两块 DOM 一起挂载，整组由 rightDockVisible 控制', () => {
  assert.match(EDITOR_VIEW, /import RightDock from '\.\.\/components\/RightDock\.vue'/)
  assert.match(EDITOR_VIEW, /<OutlinePanel \/>/)
  assert.match(EDITOR_VIEW, /<RightDock \/>/)
  assert.match(EDITOR_VIEW, /v-show="settings\.rightDockVisible"/, '整组显隐必须接新设置')
  assert.match(EDITOR_VIEW, /data-right-dock-area/)
  const panelAt = EDITOR_VIEW.indexOf('<OutlinePanel />')
  const dockAt = EDITOR_VIEW.indexOf('<RightDock />')
  assert.ok(panelAt > 0 && dockAt > panelAt, '面板必须在 dock 左侧（先渲染）')
})

// ── 设置与持久化 ───────────────────────────────────────────────────────────
test('新增设置 rightDockVisible：默认 true，三处（类型 / 默认值 / 设置页）齐全', () => {
  assert.match(TYPES, /rightDockVisible: boolean/)
  assert.match(DEFAULTS, /rightDockVisible: true/)
  assert.match(SETTINGS_DIALOG, /settings\.rightDockVisible/, '设置页缺少开关')
  assert.match(SETTINGS_DIALOG, /data-setting-right-dock/, '设置页开关需要可定位的标记')
  assert.match(SETTINGS_DIALOG, /settings\.set\('rightDockVisible', v\)/)
})

test('持久化键：active / expanded / rightDockVisible 都落 settings，重启可恢复', () => {
  assert.match(RIGHT_DOCK, /settings\.set\('rightDockActive'/)
  assert.match(RIGHT_DOCK, /settings\.set\('outlineRightExpanded'/)
  assert.match(TYPES, /rightDockActive: 'outline'/)
  assert.match(DEFAULTS, /rightDockActive: 'outline'/)
  assert.doesNotMatch(UI_STORE, /rightSidebarVisible|sidebarExpanded|rightTab/)
})
