// ─── 启动诊断日志：格式 / 轮转 / 脱敏 / 导出 / 分段覆盖 ────────────────────────
//
// 这张表守的是**用户报「装完启动 5–6 秒」时我们能不能拿到证据**：
//   ① 段打点真的在（主进程 app-ready/db/窗口/渲染首屏）；
//   ② 轮转有界（3 份 × 256KB，不会无限长）；
//   ③ 脱敏（userData 折成 %APPDATA%\…，路径只留顶层名，文档只留数量）；
//   ④ 导出按钮与 IPC 通道在位（且渲染层上报只收数字）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_STARTUP_LOG_BYTES,
  MAX_STARTUP_LOG_FILES,
  STARTUP_LOG_FILE,
  buildStartupExportText,
  countLogLines,
  redactStartupPath,
  rotatedStartupName,
  sanitizeRendererStartupReport,
  shouldRotateStartup,
  startupLogLine,
  startupRotationPlan,
  topLevelName
} from '../src/shared/startupLog.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('路径脱敏：AppData / 用户目录换成环境变量，其它只留顶层名', () => {
  assert.equal(redactStartupPath('C:\\Users\\alice\\AppData\\Roaming\\Lumin'), '%APPDATA%\\Lumin')
  assert.equal(
    redactStartupPath('C:/Users/alice/AppData/Local/Temp/xw-diag-ud'),
    '%LOCALAPPDATA%\\Temp\\xw-diag-ud'
  )
  assert.equal(
    redactStartupPath('C:\\Users\\alice\\Documents\\novel\\chapter-1.md'),
    '%USERPROFILE%\\Documents\\novel\\chapter-1.md'
  )
  // 非用户目录：父目录与盘符都不进日志，只留最后一段
  assert.equal(redactStartupPath('C:\\work\\Lumin\\secret.md'), 'secret.md')
  assert.equal(topLevelName('C:\\work\\Lumin\\'), 'Lumin')
  assert.equal(topLevelName(''), '')
})

test('轮转：单文件 ≥256KB 才换，最多 5 份（最近 5 次启动），最老的被删掉', () => {
  assert.equal(MAX_STARTUP_LOG_BYTES, 256 * 1024)
  assert.equal(MAX_STARTUP_LOG_FILES, 5)
  assert.equal(shouldRotateStartup(MAX_STARTUP_LOG_BYTES - 1), false)
  assert.equal(shouldRotateStartup(MAX_STARTUP_LOG_BYTES), true)

  const plan = startupRotationPlan(MAX_STARTUP_LOG_FILES)
  assert.equal(plan.remove, rotatedStartupName(4))
  assert.deepEqual(plan.renames, [
    { from: `${STARTUP_LOG_FILE}.3`, to: `${STARTUP_LOG_FILE}.4` },
    { from: `${STARTUP_LOG_FILE}.2`, to: `${STARTUP_LOG_FILE}.3` },
    { from: `${STARTUP_LOG_FILE}.1`, to: `${STARTUP_LOG_FILE}.2` },
    { from: STARTUP_LOG_FILE, to: `${STARTUP_LOG_FILE}.1` }
  ])
  assert.equal(rotatedStartupName(1), 'startup.log.1')
})

test('日志行：单行 JSON + ISO 时间戳，字段原样保留', () => {
  const line = startupLogLine(
    { kind: 'stage', stage: 'app-ready', ms: 42 },
    '2026-01-02T03:04:05.000Z'
  )
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.trim().split('\n').length, 1)
  const parsed = JSON.parse(line.trim())
  assert.equal(parsed.at, '2026-01-02T03:04:05.000Z')
  assert.equal(parsed.stage, 'app-ready')
  assert.equal(parsed.ms, 42)
})

test('渲染层上报清洗：只接受合法 stage 与有限数字 marks，字符串/对象一律丢弃', () => {
  const ok = sanitizeRendererStartupReport({
    stage: 'first-interactive',
    marks: { shell: 120.4, files: 300, 'bad key': 1, content: 'secret text' },
    path: 'C:\\Users\\alice\\secret.md'
  })
  assert.deepEqual(ok, { stage: 'first-interactive', marks: { shell: 120, files: 300 } })

  assert.equal(sanitizeRendererStartupReport({ stage: 'Bad Stage', marks: {} }), null)
  // 非法数字只丢那一条，不整包拒绝（stage 本身是合法的）
  assert.deepEqual(sanitizeRendererStartupReport({ stage: 'x', marks: { a: Infinity, b: -1 } }), {
    stage: 'x',
    marks: {}
  })
  assert.equal(sanitizeRendererStartupReport(null), null)
})

test('导出文本：有环境摘要与日志，不含文档内容；行数按非空行算', () => {
  const text = buildStartupExportText(
    {
      appVersion: '1.0.0',
      electron: '39.0.0',
      chrome: '142.0.0',
      node: '22.0.0',
      platform: 'win32',
      arch: 'x64',
      locale: 'zh-CN',
      totalmemMb: 16384,
      cpuModel: 'Test CPU',
      cpuCount: 8,
      packaged: true,
      userData: '%APPDATA%\\Lumin',
      firstRun: false,
      startedAt: '2026-01-02T03:04:05.000Z'
    },
    [
      { name: 'startup.log.1', text: '{"stage":"old"}\n' },
      { name: 'startup.log', text: '{"stage":"new"}\n' }
    ]
  )
  assert.match(text, /# Lumin startup diagnostics/)
  assert.match(text, /No document content/)
  assert.match(text, /CPU: Test CPU \(8 cores\)/)
  assert.match(text, /userData: %APPDATA%\\Lumin/)
  assert.match(text, /startup\.log\.1/)
  // 旧日志在新日志之前
  assert.ok(text.indexOf('{"stage":"old"}') < text.indexOf('{"stage":"new"}'))
  assert.equal(text.includes('secret.md'), false)
  assert.ok(countLogLines(text) > 10)
})

test('分段覆盖：主进程与渲染层的关键打点都在（少一段就量不出慢在哪）', () => {
  const main = read('src/renderer/src/main.ts')
  assert.match(main, /reportStartup\('first-interactive'\)/)
  assert.match(main, /reportStartup\('shell'\)/)
  assert.match(main, /reportStartup\('files'\)/)
  assert.match(main, /performance\.getEntriesByType\('mark'\)/)

  const idx = read('src/main/index.ts')
  for (const stage of [
    'app-ready',
    'db-ready',
    'spellcheck-ready',
    'ipc-registered',
    'recent-list',
    'jump-list',
    'session-plan',
    'first-window-created',
    'window-did-start-loading',
    'window-dom-ready',
    'window-did-finish-load',
    'window-shown',
    'first-window-painted',
    'updater-init'
  ]) {
    assert.match(idx, new RegExp(`'${stage}'`), `主进程缺启动段：${stage}`)
  }
  // DB 打开/迁移耗时真的被记进去（不是只写了个字段）
  assert.match(idx, /dbOpenMs/)
  assert.match(idx, /dbMigrationMs/)
  assert.match(idx, /recentCount/)
  // 首次运行 / 环境摘要 / 更新是否推迟
  const svc = read('src/main/services/startupLog.ts')
  assert.match(svc, /'process-start'/)
  assert.match(svc, /firstRun/)
  assert.match(svc, /totalmem/)
  assert.match(svc, /os\.cpus\(\)/)
  assert.match(svc, /cpuModel/)
})

test('导出入口在位：主进程 IPC、preload API、设置页按钮、双向类型', () => {
  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /ipcMain\.handle\('app:exportStartupDiagnostics'/)
  assert.match(ipc, /writeStartupExport/)
  const preload = read('src/preload/index.ts')
  assert.match(
    preload,
    /exportStartupDiagnostics: \(\) => ipcRenderer\.invoke\('app:exportStartupDiagnostics'\)/
  )
  assert.match(preload, /reportStartup: \(payload\) => ipcRenderer\.send\('startup:report'/)
  const dialog = read('src/renderer/src/components/SettingsDialog.vue')
  assert.match(dialog, /data-settings-export-startup/)
  assert.match(dialog, /exportStartupDiagnostics\(\)/)
  const types = read('src/shared/types.ts')
  assert.match(types, /exportStartupDiagnostics/)
  assert.match(types, /reportStartup/)
  // 主进程要真的注册上报通道
  assert.match(read('src/main/index.ts'), /ipcMain\.on\('startup:report'/)
})
