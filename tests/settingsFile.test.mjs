// ─── 设置文件（导出 / 导入）的信封校验 + 白名单 + 隐私剔除（审计清单「设置/快捷键导入导出」）──
//
// 这里钉的是**不可信输入**的处理口径：导入的文件可能被人手改过，所以
//   * 信封不认识 ⇒ 拒绝（不是"尽力而为"）；
//   * 白名单外的键 ⇒ 丢掉并记账（不猜、不原样落库）；
//   * `recentFiles` / `recentFolders` ⇒ 永不导出、永不接受（与诊断信息共用一份口径）；
//   * 路径类字段出现绝对路径 / `..` ⇒ 拒绝，并指出是哪一项。
// 另有一条：无论哪条路成功，最终设置都必须过 `settingsSchema` 的归一（导入件也要走迁移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PATH_SETTING_KEYS,
  SETTINGS_FILE_APP,
  SETTINGS_FILE_MAX_BYTES,
  SETTINGS_FILE_VERSION,
  buildSettingsFile,
  exportableSettings,
  filterSettingsKeys,
  mergeImportedSettings,
  parseSettingsFile,
  serializeSettingsFile,
  settingsFileName,
  unsafePathKey
} from '../src/shared/settingsFile.ts'
import { defaultSettings } from '../src/shared/defaults.ts'
import { PRIVATE_SETTING_KEYS } from '../src/shared/diagnostics.ts'
import { SETTINGS_SCHEMA_VERSION, MIGRATIONS } from '../src/shared/settingsSchema.ts'

/** 一份"能导出的" payload（= 默认设置去掉隐私键与本机路径键） */
const payloadOf = (extra = {}) => ({ ...exportableSettings(defaultSettings), ...extra })

/** 组装一个合法的设置文件文本 */
const fileOf = (payload, envelope = {}) =>
  JSON.stringify({
    app: SETTINGS_FILE_APP,
    version: SETTINGS_FILE_VERSION,
    exportedAt: '2026-01-02T03:04:05.000Z',
    payload,
    ...envelope
  })

test('导出件：信封字段齐全，且不含隐私键与本机路径键', () => {
  const settings = {
    ...defaultSettings,
    backupDir: 'D:\\lumin-backups',
    recentFiles: ['C:\\secret\\draft.md'],
    recentFolders: ['D:\\notes']
  }
  const env = buildSettingsFile(settings, {
    appVersion: '1.2.3',
    exportedAt: '2026-01-02T03:04:05.000Z'
  })
  assert.equal(env.app, SETTINGS_FILE_APP)
  assert.equal(env.version, SETTINGS_FILE_VERSION)
  assert.equal(env.exportedAt, '2026-01-02T03:04:05.000Z')
  assert.equal(env.appVersion, '1.2.3')
  assert.equal(
    env.payload.settingsVersion,
    SETTINGS_SCHEMA_VERSION,
    'schema 版本要进文件（导入要迁移）'
  )
  // 隐私口径：路径清单不进文件
  for (const key of PRIVATE_SETTING_KEYS) assert.equal(key in env.payload, false, `不该导出 ${key}`)
  // 本机路径字段也不进文件（换机器没有意义）
  for (const key of PATH_SETTING_KEYS) assert.equal(key in env.payload, false, `不该导出 ${key}`)
  const text = serializeSettingsFile(env)
  assert.ok(!text.includes('recentFiles') && !text.includes('secret'), '导出文本里不许出现隐私清单')
  assert.ok(text.endsWith('\n'), '文本文件结尾留一个换行')
  // 白名单 = defaults 的顶层键 − 隐私 − 本机路径
  assert.equal(
    Object.keys(env.payload).length,
    Object.keys(defaultSettings).length - PRIVATE_SETTING_KEYS.length - PATH_SETTING_KEYS.length
  )
})

test('正常往返：导出 → 序列化 → 解析，设置与自定义快捷键逐键一致', () => {
  const settings = {
    ...defaultSettings,
    fontSize: 19,
    theme: 'dark',
    keybindings: { 'file.save': 'Ctrl+Shift+S', 'editor.bold': null }
  }
  const res = parseSettingsFile(serializeSettingsFile(buildSettingsFile(settings)))
  assert.equal(res.ok, true, '合法导出件必须能导入')
  assert.deepEqual(res.patch, exportableSettings(settings), '往返结果必须与原设置逐键一致')
  assert.equal(res.patch.fontSize, 19)
  assert.deepEqual(res.patch.keybindings, {
    'file.save': 'Ctrl+Shift+S',
    'editor.bold': null
  })
  assert.deepEqual(res.unknownKeys, [])
  assert.deepEqual(res.removedPrivate, [])
  assert.deepEqual(res.dropped, [])
  assert.equal(res.applied.length, Object.keys(exportableSettings(settings)).length)
})

test('非 JSON：给 not-json，而不是抛异常', () => {
  const res = parseSettingsFile('{ not json ]')
  assert.equal(res.ok, false)
  assert.equal(res.code, 'not-json')
  assert.ok(res.detail, 'detail 要能帮人定位（解析器的话）')
})

test('信封形状不对（根不是对象 / 缺 payload / 不是设置文件）都给明确错误', () => {
  for (const text of ['null', '[]', '"settings"', '42']) {
    const res = parseSettingsFile(text)
    assert.equal(res.ok, false, `根为 ${text} 应拒绝`)
    assert.equal(res.code, 'bad-envelope')
  }
  const noPayload = parseSettingsFile(
    JSON.stringify({ app: SETTINGS_FILE_APP, version: SETTINGS_FILE_VERSION })
  )
  assert.equal(noPayload.ok, false)
  assert.equal(noPayload.code, 'bad-envelope')
  assert.equal(noPayload.detail, 'payload')
  const wrongApp = parseSettingsFile(
    JSON.stringify({ app: 'other-app', version: 1, payload: payloadOf() })
  )
  assert.equal(wrongApp.ok, false)
  assert.equal(wrongApp.code, 'wrong-app')
})

test('版本不认：信封版本比本应用新、或根本不是整数 ⇒ 拒绝', () => {
  for (const version of [SETTINGS_FILE_VERSION + 1, 99, 0, -1, 1.5, '1', null, undefined]) {
    const res = parseSettingsFile(fileOf(payloadOf(), { version }))
    assert.equal(res.ok, false, `version=${String(version)} 应拒绝`)
    assert.equal(res.code, 'unknown-version')
    assert.equal(res.detail, 'version')
  }
  // payload 里的设置 schema 版本比本应用新 ⇒ 同样拒绝（不知道新字段的语义，硬套等于写坏设置）
  const newer = parseSettingsFile(
    fileOf(payloadOf({ settingsVersion: SETTINGS_SCHEMA_VERSION + 1 }))
  )
  assert.equal(newer.ok, false)
  assert.equal(newer.code, 'unknown-version')
  assert.equal(newer.detail, 'settingsVersion')
  // 比当前旧的（甚至整个键都没有）是正常情况：走迁移/补默认值，不该拒
  const noVersion = payloadOf()
  delete noVersion.settingsVersion
  const older = parseSettingsFile(fileOf(noVersion))
  assert.equal(older.ok, true)
  // patch 只带文件里真的给了的键：`settingsVersion` 由落库那一层（normalizeSettings）重新盖
  assert.equal('settingsVersion' in older.patch, false)
})

test('导入件也要过 settingsSchema 的迁移表（临时挂一条迁移，跑完还原）', () => {
  const original = MIGRATIONS[0]
  try {
    MIGRATIONS[0] = (raw) => ({ ...raw, fontSize: 30 })
    const res = parseSettingsFile(fileOf(payloadOf({ settingsVersion: 0 })))
    assert.equal(res.ok, true)
    assert.equal(res.patch.fontSize, 30, '迁移后的值必须进入 patch（导入路径不能绕过迁移）')
  } finally {
    if (original) MIGRATIONS[0] = original
    else delete MIGRATIONS[0]
  }
  assert.equal(MIGRATIONS[0], undefined, '迁移表要还原，别影响别的用例')
})

test('未知键：丢掉并记账，绝不原样落库', () => {
  const res = parseSettingsFile(
    fileOf(payloadOf({ typingMachine: true, nestedGone: { a: 1 }, fontFamilyOld: 'Georgia' }))
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.unknownKeys.sort(), ['fontFamilyOld', 'nestedGone', 'typingMachine'])
  for (const key of res.unknownKeys) assert.equal(key in res.patch, false, `${key} 不该进 patch`)
})

test('含 recentFiles / recentFolders 的文件：隐私字段必须被剔除', () => {
  const res = parseSettingsFile(
    fileOf(
      payloadOf({
        recentFiles: ['C:\\secret\\draft.md'],
        recentFolders: ['D:\\notes'],
        fontSize: 18
      })
    )
  )
  assert.equal(res.ok, true, '隐私字段不该让整份文件作废，但绝不能落库')
  assert.deepEqual(res.removedPrivate.sort(), ['recentFiles', 'recentFolders'])
  assert.equal('recentFiles' in res.patch, false)
  assert.equal('recentFolders' in res.patch, false)
  assert.ok(!res.applied.includes('recentFiles'), 'applied 里也不许出现隐私键')
  assert.equal(res.patch.fontSize, 18, '同一份文件里合法的项照常导入')
})

test('路径类字段：绝对路径 / UNC / `..` / 空值 ⇒ unsafe-path，并指出是哪一项', () => {
  const bad = [
    'D:\\backups',
    'C:/backups',
    '\\\\server\\share',
    '//server/share',
    '/var/backups',
    '..',
    'a/../b',
    'a\\..\\b',
    '',
    '   ',
    'x\0y',
    42
  ]
  for (const value of bad) {
    const res = parseSettingsFile(fileOf(payloadOf({ backupDir: value })))
    assert.equal(res.ok, false, `backupDir=${JSON.stringify(value)} 应拒绝`)
    assert.equal(res.code, 'unsafe-path')
    assert.equal(res.detail, 'backupDir', '要指出违反的是哪一项')
  }
  // null（用默认位置）与相对路径是合法值
  for (const value of [null, 'backups', 'backups/sub']) {
    const res = parseSettingsFile(fileOf(payloadOf({ backupDir: value })))
    assert.equal(res.ok, true, `backupDir=${JSON.stringify(value)} 应通过`)
    assert.equal(res.patch.backupDir, value)
  }
  assert.equal(unsafePathKey({ backupDir: null }), null)
  assert.equal(unsafePathKey({ backupDir: 'D:\\x' }), 'backupDir')
  assert.equal(unsafePathKey({}), null, '没给这一项就是通过')
})

test('导入也必过 settingsSchema 归一：形状不符退默认值，自由映射原样保留', () => {
  const res = parseSettingsFile(
    fileOf(
      payloadOf({
        fontSize: '17',
        toolbarItems: 'bold',
        historyEnabled: 1,
        keybindings: { 'some.custom.command': 'Ctrl+K' }
      })
    )
  )
  assert.equal(res.ok, true)
  assert.equal(res.patch.fontSize, defaultSettings.fontSize)
  assert.deepEqual(res.patch.toolbarItems, defaultSettings.toolbarItems)
  assert.equal(res.patch.historyEnabled, defaultSettings.historyEnabled)
  assert.deepEqual(res.patch.keybindings, { 'some.custom.command': 'Ctrl+K' })
  // 嵌套里的多余键由归一那一层丢掉并记账
  const nested = parseSettingsFile(
    fileOf(
      payloadOf({
        export: { pdf: { margin: 30, pageSize: 'A5', legacy: 1 }, html: { template: 'default' } }
      })
    )
  )
  assert.equal(nested.ok, true)
  assert.deepEqual(nested.dropped, ['export.pdf.legacy'])
  assert.equal(nested.patch.export.pdf.margin, 30)
})

test('filterSettingsKeys：非对象给空结果；`__proto__` 只会进未知键（不污染原型）', () => {
  for (const raw of [null, undefined, 'x', 7, []]) {
    const r = filterSettingsKeys(raw)
    assert.deepEqual(r, { kept: {}, unknownKeys: [], removedPrivate: [] })
  }
  // JSON.parse 造出的 `__proto__` 是**自有**可枚举属性：它不在白名单里，只能进 unknownKeys
  const r = filterSettingsKeys(JSON.parse('{"__proto__":{"polluted":true},"fontSize":19}'))
  assert.deepEqual(r.unknownKeys, ['__proto__'])
  assert.equal(r.kept.fontSize, 19)
  assert.equal(Object.getPrototypeOf(r.kept), Object.prototype)
  assert.equal({}.polluted, undefined, '全局原型不许被污染')
})

test('导入是整体替换：`keybindings: {}` 能清掉本机覆盖项，未给的键（含隐私清单）保持本机值', () => {
  // 这条守的是**深合并会写错**的那一处：`settings:update` 是递归合并，
  // 若导入也走它，两台机器的 keybindings 会合并出第三份，空对象也清不掉旧键
  const current = {
    ...defaultSettings,
    keybindings: { 'file.save': 'Ctrl+S' },
    fontSize: 20,
    recentFiles: ['C:\\mine\\a.md']
  }
  const next = mergeImportedSettings(current, { keybindings: {}, theme: 'dark' })
  assert.deepEqual(next.keybindings, {}, '空对象 = 导入方没有任何自定义键，必须真的清空')
  assert.equal(next.theme, 'dark')
  assert.equal(next.fontSize, 20, '文件里没给的键保留本机现值')
  assert.deepEqual(next.recentFiles, ['C:\\mine\\a.md'], '本机的最近文件不可能被导入覆盖')
  // 与解析结果串起来：文件里只为一条命令留了覆盖项
  const parsed = parseSettingsFile(
    fileOf(payloadOf({ keybindings: { 'file.save': 'Ctrl+Shift+S' } }))
  )
  assert.equal(parsed.ok, true)
  assert.deepEqual(mergeImportedSettings(current, parsed.patch).keybindings, {
    'file.save': 'Ctrl+Shift+S'
  })
})

test('文件名与大小上限（信封之外的边界常量）', () => {
  assert.equal(settingsFileName(new Date(2026, 0, 2, 3, 4)), 'lumin-settings-20260102-0304.json')
  assert.ok(SETTINGS_FILE_MAX_BYTES >= 64 * 1024 && SETTINGS_FILE_MAX_BYTES <= 16 * 1024 * 1024)
})
