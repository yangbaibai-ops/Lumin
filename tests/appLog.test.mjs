// 运行日志：位置、有界、以及"主进程崩了要留证据"（审计 §4 P2 / §9 P1）。
//
// 为什么值得一条单测：日志本身没人看，直到需要它的那一刻 —— 而那一刻才发现
// "写在所有本机进程都能读的临时目录""没有上限""打包态也照写用户文档路径"就太晚了。
// 这里把三件事钉住：① 阈值与格式化（纯函数）；② 落点是 profile 里的 logs/；
// ③ 主进程真的注册了未捕获异常的记录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { LOG_FILE, MAX_LOG_BYTES, logLine, shouldRotate } from '../src/shared/logPolicy.ts'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
/** 剥掉注释再判"还有没有写临时目录"：注释里正该留着"以前写在哪、为什么搬走" */
const code = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`\w])\/\/[^\n]*/g, '$1')

test('日志策略：上限是有界的，轮转点在 >= 上限处', () => {
  assert.ok(MAX_LOG_BYTES > 0 && MAX_LOG_BYTES <= 4 * 1024 * 1024, `上限不合理：${MAX_LOG_BYTES}`)
  assert.equal(shouldRotate(MAX_LOG_BYTES - 1), false, '没到上限不该轮转')
  assert.equal(shouldRotate(MAX_LOG_BYTES), true, '正好到上限就该轮转')
  assert.equal(shouldRotate(0), false)
  // 阈值可注入（便于以后按文件区分大小），并且用的是传入值而不是常量
  assert.equal(shouldRotate(10, 10), true)
  assert.equal(shouldRotate(9, 10), false)
})

test('日志行：单行 JSON + ISO 时间戳，entry 的字段在最外层', () => {
  const line = logLine({ kind: 'launch-intent', argv: ['--x'] }, '2026-09-26T00:00:00.000Z')
  assert.ok(line.endsWith('\n'), '每条日志一行')
  assert.equal(line.split('\n').length, 2, '不能出现内嵌换行（否则 grep/统计会被打断）')
  const parsed = JSON.parse(line)
  assert.equal(parsed.at, '2026-09-26T00:00:00.000Z')
  assert.equal(parsed.kind, 'launch-intent')
  assert.deepEqual(parsed.argv, ['--x'])
  // 不给时间戳时自己带一个 ISO 串（而不是 undefined）
  assert.match(JSON.parse(logLine({})).at, /^\d{4}-\d{2}-\d{2}T/)
})

test('日志不再写 %TEMP%：落点是 profile 的 logs/ 目录', () => {
  const appLog = read('src/main/services/appLog.ts')
  assert.match(appLog, /app\.getPath\('userData'\)/, '日志目录必须由 userData 推导')
  assert.match(appLog, /join\(logDir\(\), name\)/, '文件路径必须落在 logDir() 里')
  assert.doesNotMatch(code(appLog), /tmpdir\(/, '日志模块不该再碰临时目录')
  // buildStamp 是历史上写 %TEMP%\\lumin-build.log 的地方，必须已经改道
  const stamp = read('src/main/services/buildStamp.ts')
  assert.doesNotMatch(code(stamp), /tmpdir\(|lumin-build\.log/, '构建指纹不该再写临时目录')
  assert.match(stamp, /appendLog\(/, '构建指纹应当走 appLog.appendLog')
  // 诊断页报告的日志位置与"打开日志目录"必须是同一个来源
  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /appLog\.logPath\(\)/, '诊断页的日志路径必须来自 appLog.logPath()')
  assert.match(
    ipc,
    /shell\.openPath\(appLog\.logDir\(\)\)/,
    '「打开日志目录」必须打开 appLog.logDir()'
  )
  assert.doesNotMatch(ipc, /os\.tmpdir\(\)/, 'ipc 里不该再出现临时目录')
  assert.equal(LOG_FILE, 'app.log')
})

test('主进程注册了未捕获异常 / 未处理 rejection 的记录（崩溃要留证据）', () => {
  const idx = read('src/main/index.ts')
  assert.match(idx, /process\.on\('uncaughtException'/, '缺少 uncaughtException 记录')
  assert.match(idx, /process\.on\('unhandledRejection'/, '缺少 unhandledRejection 记录')
  // 记录之后仍然退出：不能把崩溃吞成"半坏状态"
  const at = idx.indexOf(`process.on('uncaughtException'`)
  assert.match(idx.slice(at, at + 200), /process\.exit\(1\)/, '未捕获异常记录完仍应退出')
  const frame = read('src/main/services/appLog.ts')
  assert.match(frame, /export function recordFatal/, 'appLog 必须导出 recordFatal')
  assert.match(frame, /stack.*slice\(0, 4096\)/s, '栈要有长度上限（否则一份日志被栈顶爆）')
})
