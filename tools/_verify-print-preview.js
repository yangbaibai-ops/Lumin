'use strict'
// 验收：`Ctrl+P` → **应用内打印预览**（第十一轮用户报障：Windows 打印窗口提示"此应用不支持打印预览"）
//
// 为什么这个套件**自管实例**（端口 9237，避开运行器的 9222 与其它自管套件）：
//   ① 「预览里点打印」必须走通打印通路，而真打印会弹**原生**系统对话框、自动化关不掉 ——
//      所以实例要带 `LUMIN_PRINT_DRY_RUN=1`（**仅开发态**生效，见 src/main/testPaths.ts）；
//   ② 还要 `LUMIN_EXPORT_DIR` 才能让「导出 PDF」跳过原生「另存为」对话框，用它做
//      "预览的页数 == 导出的 PDF 页数"这条交叉验证；
//   ③ 这两个环境变量都必须在**实例启动前**给到。
//
// 断言分组：
//   A Ctrl+P 之后**出现预览**：新目标 + 预览页语义锚点 + 临时目录里真有一份 `%PDF-`
//   B 预览页**没有被 CSP/本地文件策略拦掉**：预览窗口的 console 没有违约错误，embed 有尺寸；
//     并且预览窗口**没有发出任何网络请求**（全部是 file://）
//   C 页数：预览页上的 `data-print-preview-pages` == 直接解析 PDF 字节得到的页数
//     == **走正常导出路径**产出的 PDF 的页数（同一份渲染/分页口径）
//   D 「打印」：dry-run 下返回 ok + 标记，且主进程日志出现 `[print] dry-run …`
//   E 「关闭」：预览窗口消失 + 临时目录（含 preview.pdf）被删掉
const os = require('os')
const path = require('path')
const fs = require('fs')
const {
  connect,
  attach,
  settle,
  sleep,
  startIsolated,
  Reporter,
  fatal,
  instanceLog,
  listTargets,
  watchEvents,
  requireFocus
} = require('./lib/harness')
const { countPdfPages, PRINT_PREVIEW_DIR_PREFIX } = require('../src/shared/printPreview.ts')

const PORT = 9237
const ROOT = path.resolve(__dirname, '..')
// ⚠️ 这两个目录名**故意不带** `lumin-print-preview-` 前缀：`previewDirs()` 是按那个前缀
// 找预览作业目录的，名字撞上就会把自己的 ud/导出目录也算成"预览临时目录"（实测踩过）。
const UD = path.join(os.tmpdir(), 'lumin-pp-ud')
const OUT = path.join(os.tmpdir(), 'lumin-pp-out')

/** 自管隔离实例：两个旁路变量都要在**启动前**给到（见文件头） */
function isolated(cleanupOnly = false) {
  return startIsolated({
    userData: UD,
    port: PORT,
    env: { LUMIN_PRINT_DRY_RUN: '1', LUMIN_EXPORT_DIR: OUT },
    cleanupOnly
  })
}

function readLog() {
  const p = instanceLog(UD)
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

/** 当前存在的预览临时目录（我们的前缀；启动时已清过，所以正常只有 0 或 1 个） */
function previewDirs() {
  const tmp = os.tmpdir()
  try {
    return fs
      .readdirSync(tmp)
      .filter((n) => n.startsWith(PRINT_PREVIEW_DIR_PREFIX))
      .map((n) => path.join(tmp, n))
  } catch {
    return []
  }
}

async function click(app, x, y) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 元素中心点（不存在返回 null）；`scope` 可限定在某层浮层里查 */
async function centerOf(ev, selector, scope) {
  const raw = await ev(`(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'}
    if (!root) return null
    const el = root.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (el.textContent || '').trim() })
  })()`)
  return raw ? JSON.parse(raw) : null
}

/** 目标里的应用页（排除 devtools:// 与预览窗口） */
async function appPage() {
  const t = (await listTargets(PORT)).filter((x) => x.type === 'page')
  return t.find((x) => !/^devtools:/.test(String(x.url)) && !/lumin-print-preview/.test(String(x.url))) ?? null
}

/** 预览窗口的目标 */
async function previewTarget() {
  const t = (await listTargets(PORT)).filter((x) => x.type === 'page')
  return t.find((x) => /lumin-print-preview-[a-z0-9]+\/index\.html/.test(String(x.url))) ?? null
}

/** 等预览窗口出现（默认 20s：第一份 PDF 要渲染一次完整文档） */
async function waitPreview(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const t = await previewTarget()
    if (t) return t
    if (Date.now() > end) return null
    await sleep(250)
  }
}

/**
 * 订阅预览窗口里的 console 与网络请求。
 *
 * 为什么要**单独 attach 到预览窗口**：它是另一个 BrowserWindow（另一个 CDP 目标），
 * "内置 PDF 查看器有没有被 CSP 的 `frame-ancestors 'none'` 或"不许访问本地文件"拦掉"
 * 只有它自己的 console 知道；"预览不许发网络请求"也只有它的 Network 域能证明。
 */
async function watchPreview(target) {
  const pv = await attach(target)
  await pv.send('Page.enable').catch(() => {})
  const messages = []
  const requests = []
  const off = watchEvents(pv, (m) => {
    if (m.method === 'Log.entryAdded') messages.push(String(m.params?.entry?.text ?? ''))
    if (m.method === 'Runtime.consoleAPICalled') {
      messages.push((m.params?.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '))
    }
    if (m.method === 'Network.requestWillBeSent') requests.push(String(m.params?.request?.url ?? ''))
  })
  await pv.send('Log.enable').catch(() => {})
  await pv.send('Runtime.enable').catch(() => {})
  await pv.send('Network.enable').catch(() => {})
  return { pv, messages, requests, off }
}

async function main() {
  const report = new Reporter('打印预览：Ctrl+P → 应用内 PDF 预览 → 打印通路 / 临时文件清理')

  // 清掉可能残留的预览目录（上一次崩溃留下的），否则下面的断言分不清新旧
  for (const d of previewDirs()) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  isolated(true)
  const code = isolated(false)
  if (code !== 0) {
    report.skip('ctrl-p-opens-print-preview', `隔离实例没起来（start-isolated.ps1 exit=${code}）`)
    return report.finish()
  }
  const app = await connect({ port: PORT })
  try {
    if (!(await settle(app.ev))) {
      report.skip('ctrl-p-opens-print-preview', '页面没就绪')
      return report.finish()
    }

    /**
     * 先放一段**足够长**的内容进正文（80 段）：这样预览必然是**多页**，
     * 于是"页数 == 导出件页数"这条断言不是拿 1 == 1 蒙过去的。
     * 用 JSON 文档而不是 HTML 字符串：`setContent('<h1>…')` 会被当成纯文本（第一版踩过，
     * 截图里整段标签原样显示）。
     */
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '打印预览验收' }] }
      ].concat(
        Array.from({ length: 80 }, (_, i) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `第 ${i + 1} 段：预览的分页与「导出 PDF」逐页一致。` }]
        }))
      )
    }
    await app.ev(
      `(() => {
        const ed = window.__L && window.__L.ed ? window.__L.ed() : null
        if (ed) ed.commands.setContent(${JSON.stringify(doc)})
        return 'ok'
      })()`
    )
    await sleep(600)

    // ── A. Ctrl+P → 预览窗口 ─────────────────────────────────────────────────
    /**
     * 先要 OS 焦点：`Ctrl+P` 是**真实按键注入**，窗口不在前台时 CDP 的按键会丢
     * （表现为"按了没反应"，不是产品缺陷）。拿不到就按 harness 的口径**如实 SKIP**。
     */
    await requireFocus(app, 'Ctrl+P 段')
    const logBefore = readLog().length
    await app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: 2, // Ctrl
      windowsVirtualKeyCode: 80,
      code: 'KeyP',
      key: 'p'
    })
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      windowsVirtualKeyCode: 80,
      code: 'KeyP',
      key: 'p'
    })
    const target = await waitPreview()
    console.log('A-PREVIEW-TARGET ' + JSON.stringify(target ? { url: target.url, id: target.id } : null))
    report.check('ctrl-p-opens-print-preview-window', !!target, JSON.stringify(target))

    const dirs = previewDirs()
    const pdfPath = dirs.length ? path.join(dirs[0], 'preview.pdf') : null
    const pdf = pdfPath && fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : null
    console.log(
      'A-TEMP-DIR ' +
        JSON.stringify({
          dirs: dirs.map((d) => path.basename(d)),
          pdfBytes: pdf ? pdf.length : 0,
          head: pdf ? pdf.slice(0, 5).toString('latin1') : null
        })
    )
    report.check(
      'preview-writes-a-real-pdf-into-temp',
      !!pdf && pdf.slice(0, 5).toString('latin1') === '%PDF-' && pdf.length > 1000,
      JSON.stringify({ dirs: dirs.map((d) => path.basename(d)), bytes: pdf ? pdf.length : 0 })
    )

    if (!target || !pdf) {
      for (const n of [
        'preview-page-has-pdf-embed',
        'preview-page-renders-without-csp-or-file-errors',
        'preview-makes-no-network-requests',
        'preview-pages-match-exported-pdf',
        'preview-print-goes-through-print-path',
        'closing-preview-removes-temp-pdf'
      ]) {
        report.skip(n, '预览窗口或 PDF 没生成')
      }
      return report.finish()
    }

    // 预览页本身（语义锚点 + embed）
    const watchers = await watchPreview(target)
    const pv = watchers.pv
    /**
     * 装好 Network 域之后**重新加载一次**再取读数：`attach` 时页面早就加载完了，
     * "没有网络请求"会变成真空断言。重载之后 wrapper 与 `preview.pdf` 的请求都会被记下来，
     * 于是能同时证明两件事：**PDF 真的被取来渲染了**，且**全部都是 `file://`**。
     */
    await pv.send('Page.reload').catch(() => {})
    await sleep(2000) // 给内置 PDF 查看器一点渲染时间
    const pageInfo = JSON.parse(
      await pv.ev(`(() => {
        const b = document.body
        const emb = document.querySelector('[data-print-preview-pdf]')
        return JSON.stringify({
          attr: b.getAttribute('data-print-preview'),
          job: b.getAttribute('data-print-preview-job'),
          pages: b.getAttribute('data-print-preview-pages'),
          hasPrintBtn: !!document.querySelector('[data-print-preview-print]'),
          hasCloseBtn: !!document.querySelector('[data-print-preview-close]'),
          embedSrc: emb ? emb.getAttribute('src') : null,
          embedW: emb ? emb.clientWidth : 0,
          embedH: emb ? emb.clientHeight : 0,
          title: document.title,
          csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || ''
        })
      })()`)
    )
    console.log('A-PREVIEW-PAGE ' + JSON.stringify(pageInfo))
    report.check(
      'preview-page-has-pdf-embed',
      pageInfo.attr === 'true' && pageInfo.embedSrc === './preview.pdf' && pageInfo.hasPrintBtn && pageInfo.hasCloseBtn,
      JSON.stringify(pageInfo)
    )
    // 临时目录名要跟页面上那个 job id 对上（说明这份 PDF 就是这个作业的）
    report.check(
      'preview-temp-dir-matches-job-id',
      path.basename(dirs[0]) === PRINT_PREVIEW_DIR_PREFIX + pageInfo.job,
      JSON.stringify({ dir: path.basename(dirs[0]), job: pageInfo.job })
    )

    // ── B. 没被 CSP / 本地文件策略拦掉；也没有任何网络请求 ─────────────────────
    const badMsgs = watchers.messages.filter((m) =>
      /frame-ancestors|Content Security Policy|Not allowed to load local resource|ERR_/i.test(m)
    )
    console.log(
      'B-PREVIEW-CONSOLE ' +
        JSON.stringify({ total: watchers.messages.length, bad: badMsgs, sample: watchers.messages.slice(0, 4) })
    )
    report.check(
      'preview-page-renders-without-csp-or-file-errors',
      badMsgs.length === 0 && pageInfo.embedW > 100 && pageInfo.embedH > 100,
      JSON.stringify({ bad: badMsgs, embedW: pageInfo.embedW, embedH: pageInfo.embedH })
    )
    const netRequests = watchers.requests.filter((u) => !/^file:\/\//.test(u) && !/^devtools:\/\//.test(u))
    const pdfRequested = watchers.requests.some((u) => /preview\.pdf$/i.test(u))
    console.log(
      'B-PREVIEW-NETWORK ' + JSON.stringify({ all: watchers.requests, nonFile: netRequests, pdfRequested })
    )
    report.check(
      'preview-makes-no-network-requests',
      netRequests.length === 0 && pdfRequested,
      '预览窗口的请求应当**只有** file://，且确实取过 preview.pdf：' +
        JSON.stringify({ nonFile: netRequests, all: watchers.requests })
    )
    // 预览页自带一份严格 CSP（自己生成的页面：默认什么都不许，只放行内联样式与本地 PDF）
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/i18n/zh-CN.json'), 'utf-8'))
    console.log('B-PREVIEW-META ' + JSON.stringify({ title: pageInfo.title, csp: pageInfo.csp }))
    report.check(
      'preview-page-has-its-own-strict-csp',
      /default-src 'none'/.test(pageInfo.csp) && /object-src file:/.test(pageInfo.csp),
      JSON.stringify({ csp: pageInfo.csp })
    )
    report.check(
      'preview-window-title-is-localized',
      pageInfo.title === pack.printPreview.title,
      JSON.stringify({ got: pageInfo.title, expect: pack.printPreview.title })
    )

    // ── C. 页数：预览 == 直接解析 PDF == 正常导出路径的 PDF ─────────────────────
    const localPages = countPdfPages(pdf)
    report.check(
      'preview-pages-match-pdf-bytes',
      Number(pageInfo.pages) === localPages && localPages >= 2,
      JSON.stringify({ pageAttr: pageInfo.pages, parsed: localPages })
    )

    // 走**正常导出路径**（文件 → 导出 → 导出为 PDF）：落到 LUMIN_EXPORT_DIR 旁路目录
    const fileGroup = await centerOf(app.ev, '[data-topmenu-group="f"]')
    if (fileGroup) await click(app, fileGroup.x, fileGroup.y)
    await sleep(350)
    const exportRow = await centerOf(app.ev, '[data-menu-item="menu.export"]', '.topmenu-drop:not(.topmenu-sub)')
    if (exportRow) await click(app, exportRow.x, exportRow.y)
    await sleep(400)
    const pdfItem = await centerOf(app.ev, '[data-menu-item="menu.exportPdf"]', '.topmenu-sub')
    if (pdfItem) await click(app, pdfItem.x, pdfItem.y)
    await sleep(2500)
    const exported = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.pdf')) : []
    const exportedPdf = exported.length ? fs.readFileSync(path.join(OUT, exported[0])) : null
    const exportedPages = exportedPdf ? countPdfPages(exportedPdf) : 0
    console.log(
      'C-PAGES ' +
        JSON.stringify({
          previewAttr: pageInfo.pages,
          previewBytesPages: localPages,
          exportedFiles: exported,
          exportedPages
        })
    )
    report.check(
      'preview-pages-match-exported-pdf',
      exportedPages > 0 && exportedPages === localPages && localPages >= 2,
      JSON.stringify({ exportedPages, previewPages: localPages, files: exported })
    )

    // ── D. 「打印」→ 打印通路（dry-run）────────────────────────────────────────
    await pv.ev(`(document.querySelector('[data-print-preview-print]').click(), 'clicked')`)
    await sleep(2500)
    const printed = JSON.parse(
      await pv.ev(`JSON.stringify({
        result: document.body.getAttribute('data-print-preview-result'),
        dryRun: document.body.getAttribute('data-print-preview-dry-run'),
        status: (document.querySelector('[data-print-preview-status]') || {}).textContent || ''
      })`)
    )
    const logTail = readLog().slice(logBefore)
    const dryLines = logTail.split('\n').filter((l) => l.includes('[print] dry-run')).map((l) => l.trim())
    console.log('D-PRINT ' + JSON.stringify({ printed, dryLines }))
    report.check(
      'preview-print-goes-through-print-path',
      printed.result === 'ok' && printed.dryRun === 'true',
      JSON.stringify(printed)
    )
    report.check(
      'print-path-logged-in-main',
      dryLines.length === 1 && dryLines[0].includes('pages=' + localPages),
      JSON.stringify({ dryLines, expectPages: localPages })
    )

    // ── E. 「关闭」→ 临时目录被删 ─────────────────────────────────────────────
    await pv.ev(`(document.querySelector('[data-print-preview-close]').click(), 'clicked')`)
    await sleep(1500)
    watchers.off()
    pv.close()
    const dirsAfter = previewDirs()
    const gone = !fs.existsSync(pdfPath)
    console.log(
      'E-CLEANUP ' + JSON.stringify({ dirsAfter: dirsAfter.map((d) => path.basename(d)), pdfGone: gone, target: !!previewTarget() })
    )
    report.check('closing-preview-removes-temp-pdf', gone && dirsAfter.length === 0, JSON.stringify({
      dirsAfter: dirsAfter.map((d) => path.basename(d)),
      pdfGone: gone
    }))
    report.check('closing-preview-closes-the-window', !(await previewTarget()))
  } finally {
    app.close()
    isolated(true)
  }
  return report.finish()
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((fatal))
