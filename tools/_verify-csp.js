'use strict'
// 验收：CSP 的**两半分发** —— meta 里会被忽略的指令（`frame-ancestors`）改由响应头下发。
//
// 用户实测的控制台输出（开发态打开应用）：
//   [renderer:error]   The Content Security Policy directive 'frame-ancestors' is ignored when
//                      delivered via a <meta> element.        ← **真问题**：这条指令根本没生效
//   [renderer:warning] Electron Security Warning (Insecure Content-Security-Policy) …  ← 开发态预期噪音
// 修法：`<meta>` 版（`PROD_CSP`）删掉 meta 无效指令；主进程 `onHeadersReceived` 用响应头
// **只**下发那几条（`CSP_HEADER_ONLY`，目前就 `frame-ancestors 'none'`）。
//
// 断言分组：
//   A **响应头那条路真的过到了文档请求上**（读主进程的取证日志 `[csp] frame-ancestors header set
//     for mainFrame scheme=file:`），并且**自定义协议也覆盖**（`lumin-file:` 的第一条请求也报一条）。
//     ⚠️ 探针图片本身会 `probeState=error`：临时路径不在工作区/已打开文档目录里，被
//     `lumin-file://` 的**位置闸**拒成 404（那行 `[protocol] refused …` 走的是 stderr，
//     所以我们读的 stdout 日志里看不到它）。这不影响本段的判据 —— 我们要证的是
//     "那条请求经过了 CSP 头的注入点"，注入点日志就是证据。
//   B DOM 里那份 `<meta>` 逐字等于 `PROD_CSP`、核心指令在、**一条 meta 无效指令都没有**。
//   C 渲染层控制台（主进程转发成 `[renderer:*]` 写进实例日志）**不再出现**
//     `ignored when delivered via a <meta>` —— 用户报障的就是这一条。
//
// ⚠️ 为什么不用 `Network.getResponseHeaders` 读响应头（用户原本的建议）——实测不可用：
//   * CDP 的 Network 域**看不到** `webRequest.onHeadersReceived` 注入的头（空数组），
//     而主进程的取证日志证明 handler 确实被调用、注入也确实生效；
//   * "生效"的独立证据（本轮做的一次性诊断，已还原）：把注入值临时换成 `default-src 'none'`
//     重启实例后，渲染层控制台报 `Loading the script '…/index-*.js' violates the following
//     Content Security Policy directive: "default-src 'none'"` —— 也就是注入的头**被强制执行**，
//     对 `file://` 文档同样有效（这正是打包态那条路）。
//   * 想用"嵌一次看会不会被拒"来验 `frame-ancestors` 也不成立：应用**自己**的 meta CSP 里有
//     `frame-src 'none'`（meta 里有效），framing 会先被它拦下（实测报的是 frame-src 违规）；
//     而 Electron 的 CDP 不支持 `Target.createTarget`（实测 `{"code":-32000,"message":"Not supported"}`），
//     造不出"没有任何 CSP 的外来父文档"来当判据。
//
// 跑法：`node tools/run-suites.js --suite=_verify-csp.js`（运行器起隔离实例并传实例日志路径）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, sleep, Reporter, fatal, instanceLog } = require('./lib/harness')
const { PROD_CSP, CSP_HEADER_ONLY, META_IGNORED_CSP_DIRECTIVES } = require('../src/shared/csp.ts')

/** 1×1 透明 PNG：唯一用途是让 `lumin-file://` 真的被请求一次（不校验像素） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

/** 读主进程日志（GUI 子系统里主进程没有控制台，这是唯一可读的出口） */
function readLog(logPath) {
  if (!logPath) return ''
  try {
    return fs.readFileSync(logPath, 'utf-8')
  } catch {
    return ''
  }
}

async function main() {
  const app = await connect()
  const report = new Reporter('CSP：meta 无效指令（frame-ancestors）改由响应头下发')
  const { ev } = app
  const logPath = instanceLog()
  report.note('实例日志：' + String(logPath))

  const ready = await settle(app.ev)
  report.check('app-ready', ready === true)

  // ── A. 响应头那条路：主进程取证日志 ────────────────────────────────────────
  // 先让 `lumin-file://` 真的被请求一次（打包态文档里的相对图片走的就是这个协议）
  const pngPath = path.join(os.tmpdir(), 'lumin-csp-header-probe.png')
  let pngUrl = null
  try {
    fs.writeFileSync(pngPath, TINY_PNG)
    pngUrl = 'lumin-file:///' + encodeURI(pngPath.replace(/\\/g, '/'))
  } catch {
    pngUrl = null
  }
  let probeState = 'skipped'
  if (pngUrl) {
    await ev(`(() => {
      window.__cspProbe = 'pending'
      const img = new Image()
      img.onload = () => { window.__cspProbe = 'load' }
      img.onerror = () => { window.__cspProbe = 'error' }
      img.src = ${JSON.stringify(pngUrl)}
      return 'ok'
    })()`)
    await sleep(1200)
    probeState = String(await ev(`window.__cspProbe`))
    fs.rmSync(pngPath, { force: true })
  }

  const log = readLog(logPath)
  const headerLines = log
    .split('\n')
    .filter((l) => l.includes('[csp] frame-ancestors header set for'))
    .map((l) => l.trim())
  console.log('A-HEADER-LOG ' + JSON.stringify({ probeState, lines: headerLines }))
  if (!logPath) {
    report.skip('header-path-ran-for-main-document', '没有 LUMIN_INSTANCE_LOG，读不到主进程日志')
    report.skip('header-path-covers-lumin-file-scheme', '同上')
  } else {
    report.check(
      'header-path-ran-for-main-document',
      headerLines.some((l) => /for mainFrame scheme=(file|http)/.test(l)),
      '主进程没有为文档请求注入 frame-ancestors 响应头（应有一行 for mainFrame scheme=file:）：' +
        JSON.stringify(headerLines)
    )
    report.check(
      'header-path-covers-lumin-file-scheme',
      headerLines.some((l) => /scheme=lumin-file:/.test(l)),
      '自定义协议 lumin-file:// 没走到响应头注入（打包态的相对图片走它）：' +
        JSON.stringify({ probeState, lines: headerLines })
    )
  }
  // 头里不许混进整串策略（那是 meta 的活；两份同时下发会取交集）
  // ⚠️ 这里对常量做防御：本套件会被拿去对**改前**的构建跑（那时还没有 `CSP_HEADER_ONLY`），
  // 直接 `.trim()` 会把"断言红"变成"套件崩"，那样就拿不到两份可比的红/绿输出了
  const headerOnly = String(CSP_HEADER_ONLY ?? '')
  const ignoredDirectives = Array.isArray(META_IGNORED_CSP_DIRECTIVES)
    ? META_IGNORED_CSP_DIRECTIVES
    : []
  report.check(
    'header-only-policy-is-just-frame-ancestors',
    headerOnly.trim() === "frame-ancestors 'none'",
    'CSP_HEADER_ONLY 应只含 frame-ancestors：' + JSON.stringify(headerOnly)
  )

  // ── B. DOM 里那份 <meta>（用户能看到的那一半修好了没有）──────────────────────
  const metaProbe = await ev(`(() => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    return JSON.stringify({ found: !!m, content: m ? m.getAttribute('content') : null })
  })()`).then(JSON.parse)
  console.log('B-META ' + JSON.stringify({ found: metaProbe.found, content: metaProbe.content }))
  report.check('meta-present-in-dom', metaProbe.found === true)
  const metaContent = String(metaProbe.content ?? '')
  report.check(
    'meta-content-equals-prod-csp',
    metaContent === PROD_CSP,
    'DOM 里的 meta 与 shared/csp.ts 的 PROD_CSP 不一致（构建注入漂了？）'
  )
  report.check(
    'meta-keeps-core-directives',
    /(^|;\s*)default-src 'self'/.test(metaContent) && /(^|;\s*)script-src 'self'/.test(metaContent),
    'meta 里的核心指令丢了：' + metaContent
  )
  const offenders = ignoredDirectives.filter((d) =>
    new RegExp(`(^|;\\s*)${d}\\b`).test(metaContent)
  )
  report.check(
    'meta-has-no-ignored-directives',
    ignoredDirectives.length > 0 && offenders.length === 0,
    'meta 里有浏览器会忽略的指令（等于没设）：' + JSON.stringify(offenders) + ' | ' + metaContent
  )
  report.check(
    'header-only-policy-not-duplicated-in-meta',
    !metaContent.includes('frame-ancestors') && headerOnly.includes('frame-ancestors'),
    'meta 与 CSP_HEADER_ONLY 的职责边界被打破'
  )

  // ── C. 控制台：不再出现「meta 里被忽略」那条警告（用户报障的那条）───────────
  // ⚠️ 反向栅栏：先由**我们自己**往渲染层控制台发一条 warning，确认"渲染层 console → 主进程日志"
  // 这条转发通道在当前这次运行里真的是通的 —— 否则上一条断言可能因为"根本没转发"而假绿。
  await ev(`(() => { console.warn('lumin-csp-probe-console-fence'); return 'ok' })()`)
  await sleep(800)
  const log2 = readLog(logPath)
  const fenceSeen = log2.includes('lumin-csp-probe-console-fence')
  const ignoredLines = log2
    .split('\n')
    .filter((l) => /ignored when delivered via a <meta>/i.test(l))
    .map((l) => l.trim().slice(0, 160))
  const rendererLines = log2.split('\n').filter((l) => l.startsWith('[renderer:')).length
  console.log('C-CONSOLE ' + JSON.stringify({ fenceSeen, ignoredLines, rendererLines }))
  if (!logPath) {
    report.skip('console-has-no-ignored-directive-warning', '没有 LUMIN_INSTANCE_LOG')
  } else {
    report.check(
      'console-has-no-ignored-directive-warning',
      ignoredLines.length === 0,
      '渲染层控制台里还有「meta 里被忽略」的警告：' + JSON.stringify(ignoredLines)
    )
    report.check(
      'renderer-console-is-actually-forwarded',
      fenceSeen === true,
      '我们自己的 console.warn 没出现在实例日志里 —— 转发通道没通，上面那条断言等于没验'
    )
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
