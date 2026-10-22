// ─── 大纲搬回左侧边栏：左栏必须可见、切回右侧不污染用户偏好 ─────────────────────
//
// 用户报障：大纲在右侧、左栏收起时，点「把大纲放回左侧边栏」→ **左侧什么都不出现**。
// 根因（a）：原 `useOutlineSide` 只改 `outlineOnRight` 与页签，没有打开 `ui.sidebarVisible`；
// 而 `App.vue` 的左栏是 `v-if="ui.sidebarVisible"` —— 整条左栏根本没渲染。
//
// 本套件守三件事（对应用户验收）：
//   1. 搬到左侧 ⇒ 左栏强制可见（ui + settings 一起），页签亮出大纲；
//   2. 搬回右侧 ⇒ 左栏还原成搬动前的显隐（原本收起就仍收起，原本开着就仍开着）；
//   3. 状态迁移是纯函数、幂等，不修改入参；渲染条件接的是纯函数而不是各处手写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { moveOutlineSide } from '../src/renderer/src/lib/outlineSideState.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const USE_OUTLINE_SIDE = read('src/renderer/src/composables/useOutlineSide.ts')
const UI_STORE = read('src/renderer/src/stores/ui.ts')
const APP = read('src/renderer/src/App.vue')
const SETTINGS_DIALOG = read('src/renderer/src/components/SettingsDialog.vue')

/** 搬动前的现场：大纲在右侧、左栏被用户收起、页签停在文件（最常见的报障现场） */
const rightWithSidebarHidden = {
  outlineOnRight: true,
  sidebarVisible: false,
  sidebarVisibleBefore: null,
  sidebarTab: 'files',
  rightDockVisible: true,
  outlineRightExpanded: true
}

// ── 切到左侧：左栏强制可见 ───────────────────────────────────────────────────
test('搬到左侧：左栏强制可见（ui 与设置都要 true），页签亮出大纲', () => {
  const next = moveOutlineSide(rightWithSidebarHidden, false)
  assert.equal(next.outlineOnRight, false, '位置确实搬到左栏')
  assert.equal(next.sidebarVisible, true, '左栏必须被打开（否则 App.vue 整条不渲染）')
  assert.equal(next.sidebarVisibilityChanged, true, '显隐变了 ⇒ 要写回 settings，重启后仍可见')
  assert.equal(next.sidebarTab, 'outline', '搬回来的就是大纲，页签必须亮起它')
  assert.equal(next.sidebarVisibleBefore, false, '记住搬动前是收起的，供切回右侧还原')
})

test('搬到左侧不改右侧 dock 的**用户设置值**（渲染层另行隐藏）', () => {
  const next = moveOutlineSide(rightWithSidebarHidden, false)
  assert.equal(next.rightDockVisible, true, '设置值保持 true，不能被渲染条件写坏')
  assert.equal(next.outlineRightExpanded, true, '面板展开状态也不动，搬回右侧即恢复')
})

test('搬到左侧：左栏本来就开着 ⇒ 不产生多余的设置写入，记忆仍是「开着」', () => {
  const next = moveOutlineSide({ ...rightWithSidebarHidden, sidebarVisible: true }, false)
  assert.equal(next.sidebarVisible, true)
  assert.equal(next.sidebarVisibilityChanged, false, '值没变就不写盘')
  assert.equal(next.sidebarVisibleBefore, true)
})

// ── 切回右侧：不污染用户的左栏偏好 ───────────────────────────────────────────
test('切回右侧：左栏还原成搬动前的收起状态（原本隐藏则仍隐藏）', () => {
  const left = moveOutlineSide(rightWithSidebarHidden, false)
  const back = moveOutlineSide(left, true)
  assert.equal(back.outlineOnRight, true)
  assert.equal(back.sidebarVisible, false, '原本收起的左栏，切回右侧后仍必须收起')
  assert.equal(back.sidebarVisibilityChanged, true, '还原也是一次真实变化，要写回设置')
  assert.equal(back.sidebarVisibleBefore, null, '记忆用掉即清空，避免污染下一次')
  assert.equal(back.sidebarTab, 'files', '三栏模式下左栏只承担文件树')
})

test('切回右侧：左栏原本开着 ⇒ 仍然开着（不被顺手关掉）', () => {
  const left = moveOutlineSide({ ...rightWithSidebarHidden, sidebarVisible: true }, false)
  const back = moveOutlineSide(left, true)
  assert.equal(back.sidebarVisible, true)
  assert.equal(back.sidebarVisibilityChanged, false)
})

test('切回右侧：没有记忆（重启后）⇒ 保持当前左栏状态，不回退成硬编码值', () => {
  const leftAfterRestart = {
    outlineOnRight: false,
    sidebarVisible: true,
    sidebarVisibleBefore: null,
    sidebarTab: 'files',
    rightDockVisible: true,
    outlineRightExpanded: true
  }
  const back = moveOutlineSide(leftAfterRestart, true)
  assert.equal(back.sidebarVisible, true)
  assert.equal(back.sidebarVisibilityChanged, false)

  const hidden = moveOutlineSide({ ...leftAfterRestart, sidebarVisible: false }, true)
  assert.equal(hidden.sidebarVisible, false, '用户收起的左栏也不会被强行打开')
})

test('切回右侧：dock 设置值打开、右侧面板展开（既有的「搬过去要看得见」口径）', () => {
  const left = {
    outlineOnRight: false,
    sidebarVisible: true,
    sidebarVisibleBefore: null,
    sidebarTab: 'outline',
    rightDockVisible: false,
    outlineRightExpanded: false
  }
  const back = moveOutlineSide(left, true)
  assert.equal(back.rightDockVisible, true)
  assert.equal(back.outlineRightExpanded, true)
})

// ── 纯函数 / 幂等 ───────────────────────────────────────────────────────────
test('幂等：已经在目标侧时什么都不改（也不覆盖记忆）', () => {
  const left = {
    outlineOnRight: false,
    sidebarVisible: true,
    sidebarVisibleBefore: false,
    sidebarTab: 'outline',
    rightDockVisible: true,
    outlineRightExpanded: true
  }
  const same = moveOutlineSide(left, false)
  assert.equal(same.changed, false)
  assert.equal(same.sidebarVisibilityChanged, false)
  assert.equal(same.sidebarVisibleBefore, false, '记忆必须保持原值')
  const rest = { ...same }
  delete rest.changed
  delete rest.sidebarVisibilityChanged
  assert.deepEqual(rest, left)
})

test('纯函数：不修改入参', () => {
  const input = { ...rightWithSidebarHidden }
  const snapshot = { ...input }
  moveOutlineSide(input, false)
  assert.deepEqual(input, snapshot)
})

// ── 接线：真正的开关、左栏渲染条件、设置入口 ─────────────────────────────────
test('useOutlineSide 是唯一实现：读 store → 纯函数 → 写回 ui 与 settings', () => {
  assert.match(USE_OUTLINE_SIDE, /import \{ moveOutlineSide \} from '\.\.\/lib\/outlineSideState'/)
  assert.match(
    USE_OUTLINE_SIDE,
    /ui\.sidebarVisible = change\.sidebarVisible/,
    '必须真的改左栏显隐'
  )
  assert.match(
    USE_OUTLINE_SIDE,
    /settings\.set\('sidebarVisible', change\.sidebarVisible\)/,
    '显隐变化必须落库（重启后仍可见）'
  )
  assert.match(
    USE_OUTLINE_SIDE,
    /ui\.sidebarVisibleBeforeOutlineLeft = change\.sidebarVisibleBefore/
  )
  assert.match(USE_OUTLINE_SIDE, /ui\.sidebarTab = change\.sidebarTab/)
  assert.match(USE_OUTLINE_SIDE, /settings\.set\('outlineOnRight', change\.outlineOnRight\)/)
  assert.match(USE_OUTLINE_SIDE, /settings\.set\('rightDockVisible', change\.rightDockVisible\)/)
})

test('左栏渲染条件确实是 ui.sidebarVisible（证明「只改 outlineOnRight」不够）', () => {
  assert.match(APP, /<AppSidebar v-if="ui\.sidebarVisible" \/>/)
})

test('ui store 提供会话内记忆 sidebarVisibleBeforeOutlineLeft', () => {
  assert.match(UI_STORE, /sidebarVisibleBeforeOutlineLeft: null as boolean \| null/)
  assert.doesNotMatch(
    UI_STORE,
    /sidebarTabBeforeOutlineRight/,
    '页签记忆已由纯函数接管，字段应删除'
  )
})

test('设置页的大纲位置开关也走同一份实现（不能直接写 settings）', () => {
  assert.match(
    SETTINGS_DIALOG,
    /function toggleOutlineRight\(v: boolean\): void \{\s*setOutlineSide\(v\)/
  )
  assert.match(SETTINGS_DIALOG, /@update:model-value="toggleOutlineRight"/)
})

test('持久化：位置落 settings.outlineOnRight / 左栏显隐落 settings.sidebarVisible', () => {
  const DEFAULTS = read('src/shared/defaults.ts')
  const TYPES = read('src/shared/types.ts')
  assert.match(TYPES, /outlineOnRight: boolean/)
  assert.match(DEFAULTS, /outlineOnRight: false/)
  assert.match(TYPES, /sidebarVisible: boolean/)
  assert.match(DEFAULTS, /sidebarVisible: true/)
})
