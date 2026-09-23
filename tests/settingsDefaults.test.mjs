// ─── 新增设置的**出厂默认**要钉在单测里 ───────────────────────────────────────
//
// 用户口径很明确：「默认使用当前的结构，不用三栏式」。默认值写错（比如手滑改成 true）
// 会让所有老用户一升级就发现左栏的结构变了，而 CDP 套件测的是「开关打开后的行为」，
// 抓不到这类偏差。所以这里用毫秒级的纯单测把默认钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings } from '../src/shared/defaults.ts'

test('大纲三栏模式：出厂默认关闭，右侧大纲默认展开', () => {
  assert.equal(
    defaultSettings.outlineOnRight,
    false,
    '默认必须是原来的结构（左栏「文件 / 大纲」页签）；三栏只能由用户显式打开'
  )
  assert.equal(
    defaultSettings.outlineRightExpanded,
    true,
    '三栏一旦打开，右侧大纲应当是展开的（否则用户会以为设置没生效）'
  )
})

test('保存方式：出厂默认**手动保存**（用户口径）', () => {
  assert.equal(
    defaultSettings.autoSave,
    false,
    '默认手动：自动保存会把半成品随时写进磁盘；手动模式下仍有草稿崩溃保护，不等于丢字'
  )
  assert.ok(defaultSettings.autoSaveInterval > 0, '间隔仍要有正数默认值，便于用户切回自动保存时直接用')
})
