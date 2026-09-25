'use strict'
// 验收：诊断信息（审计 §9 P1「没有崩溃/运行日志收集，用户报障只能靠猜」）
//
// 判据：
//   1. 设置页「高级」里能拿到一段诊断文本，且**含环境事实**（版本 / Electron / Chromium / 数据目录 / 日志路径）；
//   2. 这段文本**不含**文档内容、也**不含**最近打开过的文件清单（隐私边界，用户要敢直接贴出来）；
//   3. 「打开日志目录」不接受渲染层传路径（避免变成"打开任意目录"的洞）—— 断言 API 签名是 0 参；
//   4. 界面上那两个按钮真的存在（不能只做一个没人能点到的 IPC）。
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('诊断信息：环境事实 / 隐私边界 / 界面入口')
  const { ev } = app

  // ── ① IPC 直接取一次（不看界面，先确认数据本身）─────────────────────────────
  // ⚠️ 断言不看具体语言：矩阵里前面的套件可能把界面语言留在 en-US / ru-RU，
  // 诊断文本的标题是走语言包的（`mainT`），所以这里按中英两式匹配。
  const text = String(await ev(`(async () => await window.luminAPI.app.getDiagnostics())()`))
  report.check('diagnostics-has-title', /diagnostics|诊断信息/i.test(text), text.slice(0, 60))
  report.check(
    'diagnostics-has-environment',
    /Electron: \d+\./.test(text) && /Chromium: \d+\./.test(text),
    text
      .split('\n')
      .filter((l) => /Electron|Chromium/.test(l))
      .join(' | ')
  )
  report.check(
    'diagnostics-has-paths',
    /userData: /.test(text) && /lumin\.db/.test(text) && /lumin-build\.log/.test(text),
    text
      .split('\n')
      .filter((l) => /userData|lumin\.db|\.log/.test(l))
      .join(' | ')
  )
  report.check(
    'diagnostics-declares-no-document-content',
    /no document content|不含文档内容/i.test(text),
    '未声明"不含文档内容"'
  )

  // ── ② 隐私边界：先在**内存里**放一篇带独特关键词的文档，再取诊断，正文不许出现 ──
  // ⚠️ 不要在这里调 `files.save()`：未命名文档的保存会走「另存为」原生对话框，
  // 自动化没法取消它 —— 第一版就是这么挂死的（整条套件超时）。诊断信息本来就不该
  // 依赖"文档已落盘"，标记留在 store 的当前正文里就够了。
  const marker = 'PRIVATE-MARKER-9f3a'
  await ev(`(async () => {
    const files = window.__L.files()
    await files.openUntitled()
    files.setContent(${JSON.stringify('# 秘密文档\n\n' + marker + '\n')})
    return 'ok'
  })()`)
  await sleep(600)
  const text2 = String(await ev(`(async () => await window.luminAPI.app.getDiagnostics())()`))
  report.check(
    'diagnostics-excludes-document-content',
    !text2.includes(marker),
    text2.includes(marker) ? '诊断信息里出现了文档正文！' : 'ok'
  )
  const recents = String(
    await ev(`JSON.stringify(window.__L.settings().recentFiles.map((r) => r.path))`)
  )
  const leaked = JSON.parse(recents).filter((p) => p && text2.includes(String(p)))
  report.check(
    'diagnostics-excludes-recent-file-paths',
    leaked.length === 0,
    JSON.stringify({ leaked })
  )

  // ── ③ openLogDir 不接参数（签名 0 参）────────────────────────────────────────
  const arity = await ev(`window.luminAPI.app.openLogDir.length`)
  report.check('open-log-dir-takes-no-path', arity === 0, `arity=${arity}`)

  // ── ④ 界面入口：设置页「高级」里两个按钮都在，且复制真的能拿到文本 ────────────
  const uiReady = await ev(`(async () => {
    window.__L.ui().openSettings('general')
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150))
      if (document.querySelector('[data-settings-diagnostics]')) break
    }
    const copy = document.querySelector('[data-settings-diagnostics]')
    const logs = document.querySelector('[data-settings-open-logs]')
    return JSON.stringify({
      copy: !!copy,
      logs: !!logs,
      copyLabel: copy ? copy.textContent.trim() : null,
      logsLabel: logs ? logs.textContent.trim() : null
    })
  })()`)
  const ui = JSON.parse(String(uiReady))
  report.check(
    'settings-has-diagnostics-entries',
    ui.copy && ui.logs && !!ui.copyLabel && !!ui.logsLabel,
    String(uiReady)
  )
  await ev(`window.__L.ui().closeSettings()`)
  await sleep(300)

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
