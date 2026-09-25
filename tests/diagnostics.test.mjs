// 诊断信息（shared/diagnostics.ts）：纯函数，毫秒级。
//
// 这条守的不是"格式好不好看"，而是**隐私边界**：诊断信息是给用户贴进 issue 的，
// 一旦夹带文档内容或"最近打开过哪些文件"，用户就不敢贴 —— 那这个功能等于没做。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDiagnosticsText,
  recentErrorLines,
  safeLaunchArgs,
  settingsSnapshot
} from '../src/shared/diagnostics.ts'
import { defaultSettings } from '../src/shared/defaults.ts'
import zhCN from '../src/shared/i18n/zh-CN.json' with { type: 'json' }

/**
 * 单测用的假 `t`：直接用中文包里 `diagnostics.*` 那一段，
 * 于是"主进程传什么、单测就断言什么"用的是同一份文案（不会各写一份中文）。
 */
const T = (key, params) => {
  const value = key.startsWith('diagnostics.')
    ? zhCN.diagnostics[key.slice('diagnostics.'.length)]
    : undefined
  let s = value ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

const base = () => ({
  appVersion: '1.0.0',
  platform: 'win32',
  arch: 'x64',
  electron: '39.8.10',
  chrome: '142.0.0.0',
  node: '22.0.0',
  v8: '14.2',
  packaged: false,
  userData: 'C:\\Users\\u\\AppData\\Roaming\\lumin',
  dbPath: 'C:\\Users\\u\\AppData\\Roaming\\lumin\\lumin.db',
  logs: [{ label: 'build', path: 'C:\\Temp\\lumin-build.log' }],
  launchArgs: ['--debug-port=9222'],
  settings: { ...defaultSettings },
  recentErrors: [
    { level: 'error', title: '保存失败', createdAt: 1700000000000 },
    { level: 'info', title: '已创建文件', createdAt: 1700000001000 }
  ],
  startedAt: '2026-09-24T15:30:12.000Z'
})

test('settingsSnapshot：剔除"看过哪些文件"，其余键保留且有序', () => {
  const snap = settingsSnapshot({
    ...defaultSettings,
    recentFiles: [{ path: 'C:\\secret\\a.md', title: 'a', at: 1 }],
    recentFolders: [{ path: 'C:\\secret', at: 1 }]
  })
  assert.equal('recentFiles' in snap, false, 'recentFiles 必须被剔除')
  assert.equal('recentFolders' in snap, false, 'recentFolders 必须被剔除')
  const keys = Object.keys(snap)
  assert.deepEqual(
    keys,
    [...keys].sort((a, b) => a.localeCompare(b)),
    '键应按名排序'
  )
  assert.ok(keys.length >= 10, `设置快照太短：${keys.length}`)
})

test('safeLaunchArgs：剔除个人路径类参数', () => {
  assert.deepEqual(
    safeLaunchArgs(['electron', '.', '--lumin-open=C:\\secret\\a.md', '--debug-port=9222']),
    ['electron', '.', '--debug-port=9222']
  )
  assert.deepEqual(safeLaunchArgs(['--lumin-open-folder=C:\\secret']), [])
})

test('recentErrorLines：只要 error 级、最多 10 条、不带 body', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    level: 'error',
    title: `e${i}`,
    createdAt: i,
    body: '这里可能是文档片段 —— 不该出现'
  }))
  const lines = recentErrorLines([...many, { level: 'info', title: 'info', createdAt: 1 }])
  assert.equal(lines.length, 10)
  assert.ok(
    lines.every((l) => !l.includes('文档片段')),
    'body 不该被带出来'
  )
  assert.ok(lines.every((l) => /^- \[/.test(l)))
})

test('buildDiagnosticsText：含环境事实，且**不含**文档内容与最近文件清单', () => {
  const text = buildDiagnosticsText(base(), T)
  for (const want of ['1.0.0', 'win32', '39.8.10', 'C:\\Temp\\lumin-build.log', '1700000000000']) {
    assert.ok(text.includes(want), `诊断信息里应包含 ${want}`)
  }
  assert.match(text, /不含文档内容/)
  assert.equal(text.includes('recentFiles'), false, '不该出现 recentFiles')
  assert.equal(text.includes('recentFolders'), false, '不该出现 recentFolders')
  assert.ok(text.includes('保存失败'), 'error 级通知的标题应在（那正是线索）')
  assert.equal(text.includes('已创建文件'), false, '非 error 级的通知不该出现')
})

test('buildDiagnosticsText：标题走语言包（换语言时诊断信息跟着变）', () => {
  const en = buildDiagnosticsText(base(), (k) => `EN:${k}`)
  assert.ok(en.startsWith('# EN:diagnostics.title'), en.slice(0, 60))
  assert.ok(en.includes('## EN:diagnostics.versions'), '每个小节标题都应来自语言包')
  assert.ok(en.includes('EN:diagnostics.log'), '带占位符的小节标题也应来自语言包')
})

test('buildDiagnosticsText：没有启动时间/没有错误时也不留空行占位', () => {
  const d = base()
  delete d.startedAt
  d.recentErrors = []
  const text = buildDiagnosticsText(d, T)
  assert.equal(/本次启动/.test(text), false)
  assert.ok(text.includes('- （无）'), '没有错误时要有明确的"（无）"')
  assert.equal(
    /\n\n\n/.test(text),
    false,
    `不该出现连续空行：${JSON.stringify(text.slice(0, 200))}`
  )
})
