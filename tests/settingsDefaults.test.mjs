// ─── 新增设置的**出厂默认**要钉在单测里 ───────────────────────────────────────
//
// 用户口径很明确：「默认使用当前的结构，不用三栏式」。默认值写错（比如手滑改成 true）
// 会让所有老用户一升级就发现左栏的结构变了，而 CDP 套件测的是「开关打开后的行为」，
// 抓不到这类偏差。所以这里用毫秒级的纯单测把默认钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings } from '../src/shared/defaults.ts'

test('大纲三栏模式：出厂默认关闭，右侧面板默认展开', () => {
  assert.equal(
    defaultSettings.outlineOnRight,
    false,
    '默认必须是原来的结构（左栏「文件 / 大纲」页签）；三栏只能由用户显式打开'
  )
  assert.equal(
    defaultSettings.outlineRightExpanded,
    true,
    '右侧面板应当默认展开（否则用户会以为开关没生效）'
  )
})

test('右侧停靠栏：出厂默认**显示**（用户口径「设置里开关，默认开」）', () => {
  assert.equal(
    defaultSettings.rightDockVisible,
    true,
    '停靠栏默认常驻；关掉后 dock 与面板一起隐藏，重新打开恢复上次选中面板'
  )
  assert.equal(defaultSettings.rightDockActive, 'outline', '首次启动默认选中大纲')
})

test('保存方式：出厂默认**手动保存**（用户口径）', () => {
  assert.equal(
    defaultSettings.autoSave,
    false,
    '默认手动：自动保存会把半成品随时写进磁盘；手动模式下仍有草稿崩溃保护，不等于丢字'
  )
  assert.ok(
    defaultSettings.autoSaveInterval > 0,
    '间隔仍要有正数默认值，便于用户切回自动保存时直接用'
  )
})

test('行内标记字符：出厂默认**照旧显示**（不隐藏），打开后才「永不显形」', () => {
  // 用户原话是「设置内容是是否显示例如加粗 ** 这样的字符，**默认开启（按钮显示关闭）**」——
  // 两句只有按「默认 = 现状（光标进构造才显形）」才自洽；反过来会让所有老用户升级后突然
  // 看不到标记（也不符合"默认使用当前的结构"这条既有口径）。措辞判断见 defaults.ts 的注释。
  assert.equal(
    defaultSettings.hideInlineMarkers,
    false,
    '默认必须仍按光标显形（老 profile 缺这个键时也走默认值 ⇒ 升级后行为不变）'
  )
})

test('页面无响应提示：出厂默认开启（误报由门控解决，不靠默认关掉功能）', () => {
  assert.equal(
    defaultSettings.unresponsivePromptEnabled,
    true,
    '默认关掉会让真卡死也没提示；误报应靠「可见性门控」修，用户真要取消再手动关'
  )
})
