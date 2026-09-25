// ─── 设置的 schema 版本与「孤儿键」清理（审计 §6 P2）────────────────────────────
//
// 口径：kv 里的设置只能长成 `defaults` 的形状 —— 多余的键丢掉、缺的补默认值、
// 形状不符的退回默认值、最后盖上 `settingsVersion`。这里把四件事与"只写回一次"都钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings,
  versionOf
} from '../src/shared/settingsSchema.ts'
import { defaultSettings } from '../src/shared/defaults.ts'

const normalize = (raw) => normalizeSettings(raw, defaultSettings)

test('defaults 自带当前 schema 版本（改形状时才 +1）', () => {
  assert.equal(defaultSettings.settingsVersion, SETTINGS_SCHEMA_VERSION)
  assert.ok(SETTINGS_SCHEMA_VERSION >= 1)
})

test('孤儿键被丢掉并记账，版本号被盖上', () => {
  const { settings, dropped, changed } = normalize({
    ...defaultSettings,
    // 历史上存在、后来删掉的设置项（模拟）
    typingMachine: true,
    fontFamilyOld: 'Georgia',
    nestedGone: { a: 1 }
  })
  assert.deepEqual(dropped.sort(), ['fontFamilyOld', 'nestedGone', 'typingMachine'])
  assert.equal(changed, true)
  assert.equal(settings.settingsVersion, SETTINGS_SCHEMA_VERSION)
  assert.equal('typingMachine' in settings, false)
  assert.equal('nestedGone' in settings, false)
})

test('缺键补默认值；补过之后第二次读不再"有变化"（只写回一次）', () => {
  const first = normalize({ theme: 'dark' })
  assert.equal(first.settings.theme, 'dark', '用户设过的值要留住')
  assert.equal(first.settings.fontSize, defaultSettings.fontSize, '缺的键回落到默认值')
  assert.equal(first.changed, true, '缺键 ⇒ 要写回')

  // 写回的就是归一结果本身：再读一次必须已经是干净的（否则每次启动都写库）
  const second = normalize(first.settings)
  assert.deepEqual(second.dropped, [])
  assert.equal(second.changed, false)
})

test('形状不符退回默认值（kv 被外部改坏也不让启动崩）', () => {
  const { settings } = normalize({
    ...defaultSettings,
    fontSize: '17', // 字符串
    toolbarItems: 'bold', // 不是数组
    historyEnabled: 1, // 数字
    export: { pdf: { margin: '24', pageSize: 'A4' }, html: { template: 'default' } }
  })
  assert.equal(settings.fontSize, defaultSettings.fontSize)
  assert.deepEqual(settings.toolbarItems, defaultSettings.toolbarItems)
  assert.equal(settings.historyEnabled, defaultSettings.historyEnabled)
  assert.equal(settings.export.pdf.margin, defaultSettings.export.pdf.margin)
  assert.equal(settings.export.pdf.pageSize, 'A4')
})

test('keybindings 是自由映射：不能用 defaults 的键集合去裁剪（否则会被裁空）', () => {
  const { settings } = normalize({
    ...defaultSettings,
    keybindings: { 'file.save': 'Ctrl+S', 'some.custom.command': 'Ctrl+K' }
  })
  assert.deepEqual(settings.keybindings, { 'file.save': 'Ctrl+S', 'some.custom.command': 'Ctrl+K' })
})

test('嵌套对象里的多余键也丢掉，并按路径记账', () => {
  const { dropped, settings } = normalize({
    ...defaultSettings,
    export: { pdf: { margin: 30, pageSize: 'A5', legacyFlag: true }, html: { template: 'default' } }
  })
  assert.deepEqual(dropped, ['export.pdf.legacyFlag'])
  assert.equal(settings.export.pdf.margin, 30)
  assert.equal(settings.export.pdf.pageSize, 'A5')
})

test('输入根本不是对象时整份回落默认值（null / 字符串 / 数组）', () => {
  for (const broken of [null, undefined, 'settings', 42, []]) {
    const { settings, changed } = normalize(broken)
    assert.equal(settings.theme, defaultSettings.theme, `坏输入 ${JSON.stringify(broken)}`)
    assert.equal(settings.settingsVersion, SETTINGS_SCHEMA_VERSION)
    assert.equal(changed, true)
  }
})

test('versionOf：缺字段/非法值一律按 0（比任何版本都老，会走完所有迁移）', () => {
  assert.equal(versionOf({}), 0)
  assert.equal(versionOf({ settingsVersion: '2' }), 0)
  assert.equal(versionOf({ settingsVersion: -1 }), 0)
  assert.equal(versionOf({ settingsVersion: Number.NaN }), 0)
  assert.equal(versionOf({ settingsVersion: 2.7 }), 2)
})
