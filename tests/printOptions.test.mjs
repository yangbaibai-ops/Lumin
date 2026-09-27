// ─── 真打印机打印：选项映射 + 结果归类（纯逻辑）────────────────────────────────
//
// 审计 §7 第 18 条：「打印」此前只有 PDF 导出，真打印机没有入口（`webContents.print(`
// 全仓 0 命中）。补上这条能力时，**唯一能自动验证**的就是本文件覆盖的两条纯映射：
//
//   1. `buildPrintOptions`：设置里的页面尺寸/边距（毫米）→ `webContents.print()` 选项；
//   2. `classifyPrintResult`：Chromium 回调 `(success, failureReason)` → ok/cancelled/failed。
//
// ⚠️ **真正的打印没有被自动验证，也不可能在这里被验证**：`silent: false` 要弹系统打印
// 对话框，需要一台真打印机与一个真人点击。真机验收口径写在交付报告里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintOptions, classifyPrintResult, mmToCssPx } from '../src/shared/printOptions.ts'

const PAGE_SIZES = ['A4', 'A5', 'Letter']

test('buildPrintOptions：A4/A5/Letter 同名直通，走系统对话框并打印背景', () => {
  for (const pageSize of PAGE_SIZES) {
    const options = buildPrintOptions({ pageSize, margins: 24 })
    // 页面尺寸是**直通**的：设置里那张表就叫 A4/A5/Letter，Electron 认同一批字面量，
    // 中间不做任何"换算/映射表"，所以不存在"设置说 A4、打出来是 Letter"的可能
    assert.equal(options.pageSize, pageSize, pageSize)
    assert.equal(options.silent, false, 'silent 必须是 false：要弹系统打印对话框')
    assert.equal(options.printBackground, true, '不打背景等于丢掉代码块/表头底色与图片')
  }
})

test('buildPrintOptions：边距按 96dpi 从毫米换算，四边一致且取整', () => {
  // 24mm（默认值）→ 24 * 96 / 25.4 = 90.708… → 91
  assert.equal(mmToCssPx(24), 91)
  // 25.4mm 恰好 1 英寸
  assert.equal(mmToCssPx(25.4), 96)
  assert.equal(mmToCssPx(0), 0)
  const { margins } = buildPrintOptions({ pageSize: 'A4', margins: 24 })
  assert.equal(margins.marginType, 'custom', '只有 custom 才会读下面四个值（Electron 的约定）')
  assert.deepEqual(margins, { marginType: 'custom', top: 91, bottom: 91, left: 91, right: 91 })
  // 其它边距值也跟着走同一条换算，不是写死的 91
  assert.equal(buildPrintOptions({ pageSize: 'A5', margins: 12.7 }).margins.left, 48)
})

test('buildPrintOptions：脏边距（NaN / 负数 / Infinity）归 0，不把坏值交给 Electron', () => {
  for (const bad of [NaN, -5, -0.1, Infinity, -Infinity]) {
    const { margins } = buildPrintOptions({ pageSize: 'Letter', margins: bad })
    assert.deepEqual(
      margins,
      { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
      `${bad}`
    )
  }
})

test('buildPrintOptions：deviceName 只在给出非空名字时才出现在选项里', () => {
  // 这个参数只对 silent: true 的静默打印有意义；本应用走对话框，所以默认不带。
  // 空串在 Electron 里等于"没指定"，带上只会让选项更难读（也更容易被误认为在指定打印机）。
  for (const empty of [undefined, '', '   ']) {
    const options = buildPrintOptions({ pageSize: 'A4', margins: 20, deviceName: empty })
    assert.equal('deviceName' in options, false, `不该出现 deviceName：${JSON.stringify(empty)}`)
  }
  const options = buildPrintOptions({ pageSize: 'A4', margins: 20, deviceName: '  HP_LaserJet  ' })
  assert.equal(options.deviceName, 'HP_LaserJet', '设备名要 trim（系统设备名里没有首尾空格）')
  assert.deepEqual(
    Object.keys(options).sort(),
    ['deviceName', 'margins', 'pageSize', 'printBackground', 'silent'],
    'PrintOptions 的键集合是稳定契约（webContents.print 只认这几个）'
  )
  assert.deepEqual(Object.keys(buildPrintOptions({ pageSize: 'A4', margins: 20 })).sort(), [
    'margins',
    'pageSize',
    'printBackground',
    'silent'
  ])
})

test('classifyPrintResult：成功 → ok，失败原因归一成空串', () => {
  // Chromium 成功时第二个参数是空串，但别指望它一定是 ''（有的版本给 undefined）
  for (const reason of ['', undefined, null]) {
    assert.deepEqual(classifyPrintResult(true, reason), { status: 'ok', failureReason: '' })
  }
})

test('classifyPrintResult：用户取消是正常路径（cancelled），不能被报成失败', () => {
  // electron.d.ts 里写明的取消原因就是 `Print job canceled`；不同平台/版本还会给
  // `cancelled` / `Canceled by user` 这类变体 —— 大小写与拼写都要认。
  for (const reason of [
    'Print job canceled',
    'cancelled',
    'Canceled by user',
    'PRINT CANCELLED BY USER'
  ]) {
    const result = classifyPrintResult(false, reason)
    assert.equal(result.status, 'cancelled', reason)
    assert.equal(result.failureReason, reason, '原因仍要原样透传（不吞、不改写）')
  }
  // 有牙齿：确认「取消」不会被归成 failed（这条测试要能抓住归类写反）
  assert.notEqual(classifyPrintResult(false, 'Print job canceled').status, 'failed')
})

test('classifyPrintResult：真失败 → failed 且 failureReason 原样透传', () => {
  for (const reason of [
    'Invalid printer settings',
    'Print job failed',
    'EPRINT_FAILED',
    'x'.repeat(80)
  ]) {
    const result = classifyPrintResult(false, reason)
    assert.equal(result.status, 'failed', reason)
    assert.equal(result.failureReason, reason, '渲染层要看到 Chromium 的原话')
  }
  // 空原因（系统什么都没说）：如实归到 failed，原因保持空串 —— 渲染层会补一句
  // 「打印系统没有给出失败原因」，而不是显示一条空通知。
  assert.deepEqual(classifyPrintResult(false, ''), { status: 'failed', failureReason: '' })
  assert.deepEqual(classifyPrintResult(false, undefined), { status: 'failed', failureReason: '' })
  // 首尾空白不该进到界面文案里
  assert.deepEqual(classifyPrintResult(false, '  Print job failed  '), {
    status: 'failed',
    failureReason: 'Print job failed'
  })
})

test('结果三态是穷尽的：ok / cancelled / failed 之外没有别的可能', () => {
  const statuses = new Set()
  for (const success of [true, false]) {
    for (const reason of [
      '',
      'Print job canceled',
      'Print job failed',
      'Invalid printer settings'
    ]) {
      statuses.add(classifyPrintResult(success, reason).status)
    }
  }
  assert.deepEqual([...statuses].sort(), ['cancelled', 'failed', 'ok'])
})
