'use strict'
// 验收（审计 P1-1）：导出 HTML / Word 后的资产可移植性。
//
// 复现路径与报告一致：打开一份**含本地图片 + 块级公式**的文档 → 走真实导出按钮
// （工具栏「导出」→ HTML / Word）→ 检查落盘文件：
//   ① `lumin-file://` 出现 0 次、`file:///` 出现 0 次（导出前是 N 次）；
//   ② 图片是 `data:image/…;base64,`，KaTeX 字体是 `data:font/woff2;base64,`；
//   ③ Word 不再伪装 `.doc`，而是如实的 `.html`。
// 然后把导出的 HTML **复制到另一个目录**，用 Electron 打开并截图
// `tmp/audit/fix-export-portable.png` —— 图片与公式仍然显示。
//
// 跑法（自管隔离实例，端口 9544；不碰用户实例）：
//   node tools/_verify-export-portable.js
//
// 环境：起实例前必须 delete ELECTRON_RUN_AS_NODE（否则 electron 退化成 node，见 harness）。

delete process.env.ELECTRON_RUN_AS_NODE

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  Reporter,
  startIsolated,
  spawnApp,
  fatal
} = require('./lib/harness')

const PORT = 9544
const ROOT = path.join(__dirname, '..')
const UD = path.join(os.tmpdir(), 'lumin-export-portable-ud')
const WS = path.join(ROOT, 'tmp', 'audit', 'portable-ws')
const OUT = path.join(ROOT, 'tmp', 'audit', 'portable-out')
const COPY = path.join(ROOT, 'tmp', 'audit', 'portable-copy')
const SHOT = path.join(ROOT, 'tmp', 'audit', 'fix-export-portable.png')
const HERO = path.join(ROOT, 'docs', 'screenshots', 'hero.png')

const MD = [
  '# 便携导出验收',
  '',
  '这是一张本地图片：',
  '',
  '![hero](assets/hero.png)',
  '',
  '下面是一个块级公式：',
  '',
  '$$E = mc^2$$',
  '',
  '正文最后一行。',
  ''
].join('\n')

/** 计数：两个验收串各出现几次 */
function countRefs(text) {
  return {
    luminFile: (text.match(/lumin-file:/g) || []).length,
    fileUrl: (text.match(/file:\/\//g) || []).length
  }
}

/** 等导出目录里出现目标文件（导出是异步的，完成提示可能晚于文件落盘） */
async function waitFile(pattern, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = fs.readdirSync(OUT).find((f) => pattern.test(f))
    if (hit) return path.join(OUT, hit)
    await sleep(200)
  }
  return null
}

/** 用 Electron 打开**复制出去**的那份 HTML，截图（证明图片/公式仍显示） */
function screenshot(htmlPath) {
  const script = path.join(ROOT, 'tmp', 'audit', 'shot-export.cjs')
  fs.writeFileSync(
    script,
    `const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const [html, out] = process.argv.slice(2)
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { sandbox: true } })
  await w.loadFile(html)
  await new Promise((r) => setTimeout(r, 1800))
  const img = await w.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
`,
    'utf8'
  )
  const electron = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve) => {
    const p = spawn('cmd.exe', ['/c', electron, script, htmlPath, SHOT], {
      cwd: ROOT,
      env,
      stdio: 'ignore'
    })
    const timer = setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      resolve(false)
    }, 30000)
    p.on('exit', (code) => {
      clearTimeout(timer)
      resolve(fs.existsSync(SHOT))
    })
  })
}

/** 依次点击工具栏的「导出」→ 指定格式（真实渲染层管线，含 getExportCss） */
async function clickExport(ev, format) {
  const clicked = await ev(`(() => {
    const a = document.querySelector('[data-export-pop-anchor]')
    if (!a) return 'no-anchor'
    a.click()
    return 'ok'
  })()`)
  if (clicked !== 'ok') return clicked
  await sleep(200)
  const index = { pdf: 0, html: 1, word: 2, epub: 3 }[format]
  const r = await ev(`(() => {
    const items = [...document.querySelectorAll('[data-export-pop] button')]
    if (items.length < 4) return 'items=' + items.length
    items[${index}].click()
    return 'ok'
  })()`)
  return r
}

async function main() {
  const report = new Reporter('导出资产可移植：HTML/Word 内联图片与 KaTeX 字体、Word 不再伪装 .doc')
  for (const d of [WS, OUT, COPY, UD]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(WS, 'assets'), { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(COPY, { recursive: true })
  fs.copyFileSync(HERO, path.join(WS, 'assets', 'hero.png'))
  const mdPath = path.join(WS, 'portable.md')
  fs.writeFileSync(mdPath, MD, 'utf8')

  startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  const proc = spawnApp({
    userData: UD,
    port: PORT,
    env: { LUMIN_EXPORT_DIR: OUT, LUMIN_TRUSTED_PATHS: os.tmpdir() }
  })
  let w = null
  try {
    w = await connect({ port: PORT, timeoutMs: 45000 }).catch(() => null)
    if (!w) {
      report.skip('实例', '隔离实例没起来（端口 9544）')
      return report.finish()
    }
    if (!(await settle(w.ev))) {
      report.skip('实例', '页面没就绪')
      return report.finish()
    }
    const { ev } = w
    await ev(
      `(() => { window.__L.settings().set('autoSave', false); window.__L.settings().set('toolbarVisible', true); return 'ok' })()`
    )
    await ev(
      `(async () => { await window.__L.files().setRoot(${JSON.stringify(WS)}); return 'ok' })()`
    )
    await sleep(600)
    await ev(
      `(async () => { await window.__L.files().openPath(${JSON.stringify(mdPath)}); return 'ok' })()`
    )
    await waitEditor(ev)
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(1200)
    await waitEditor(ev)
    const docState = await ev(`JSON.stringify({
      mode: window.__L.ui().editorMode,
      htmlHasImg: /<img/i.test(window.__L.ed()?.getHTML() ?? ''),
      htmlHasMath: /katex|math/i.test(window.__L.ed()?.getHTML() ?? '')
    })`)
    report.note('编辑器状态：' + docState)
    report.check(
      'editor-has-local-image',
      JSON.parse(docState).htmlHasImg === true,
      '编辑器 getHTML 里应有 <img>'
    )

    // ── 导出 HTML（真实按钮） ──────────────────────────────────────────────
    const clickHtml = await clickExport(ev, 'html')
    const htmlPath = await waitFile(/^portable\.html$/i)
    if (!htmlPath) {
      const notes = await ev(
        `JSON.stringify(window.__L.notifications().items.map((n) => ({ level: n.level, title: n.title, body: n.body })))`
      )
      report.note('导出失败时的通知：' + notes)
    }
    report.check(
      'html-exported',
      !!htmlPath && fs.existsSync(htmlPath),
      `click=${clickHtml} path=${htmlPath}`
    )
    report.check('html-file-extension', !!htmlPath && htmlPath.endsWith('.html'), String(htmlPath))
    const html = htmlPath ? fs.readFileSync(htmlPath, 'utf8') : ''
    const htmlRefs = countRefs(html)
    report.check(
      'html-no-lumin-file',
      htmlRefs.luminFile === 0,
      `lumin-file 出现 ${htmlRefs.luminFile} 次`
    )
    report.check('html-no-file-url', htmlRefs.fileUrl === 0, `file:// 出现 ${htmlRefs.fileUrl} 次`)
    report.check(
      'html-image-is-data-uri',
      /src="data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+"/i.test(html),
      `bytes=${Buffer.byteLength(html)}`
    )
    report.check(
      'html-katex-font-is-data-uri',
      /data:font\/woff2;base64,/.test(html) && !/@font-face\{[^}]*file:/i.test(html),
      `bytes=${Buffer.byteLength(html)}`
    )

    // ── 导出 Word（真实按钮） ──────────────────────────────────────────────
    const clickWord = await clickExport(ev, 'word')
    const wordPath = await waitFile(/^portable \(Word\)\.html$/i)
    report.check(
      'word-exported',
      !!wordPath && fs.existsSync(wordPath),
      `click=${clickWord} path=${wordPath}`
    )
    report.check(
      'word-is-real-html-not-fake-doc',
      !!wordPath &&
        wordPath.endsWith('.html') &&
        !fs.existsSync(path.join(OUT, 'portable (Word).doc')),
      String(wordPath)
    )
    const word = wordPath ? fs.readFileSync(wordPath, 'utf8') : ''
    const wordRefs = countRefs(word)
    report.check(
      'word-no-lumin-file',
      wordRefs.luminFile === 0,
      `lumin-file 出现 ${wordRefs.luminFile} 次`
    )
    report.check('word-no-file-url', wordRefs.fileUrl === 0, `file:// 出现 ${wordRefs.fileUrl} 次`)
    report.check(
      'word-content-equals-html-export',
      word === html,
      `html=${Buffer.byteLength(html)}B word=${Buffer.byteLength(word)}B`
    )

    // ── 复制到别处仍显示（截图） ───────────────────────────────────────────
    const copyPath = path.join(COPY, 'portable.html')
    if (html) fs.writeFileSync(copyPath, html, 'utf8')
    const shotOk = html ? await screenshot(copyPath) : false
    report.check(
      'copied-html-screenshot',
      shotOk && fs.existsSync(SHOT),
      `copied=${copyPath} shot=${SHOT}`
    )
    report.note(`HTML 参考计数：${JSON.stringify(htmlRefs)}；Word：${JSON.stringify(wordRefs)}`)
  } finally {
    try {
      if (w) w.close()
    } catch {
      /* ignore */
    }
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  }
  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
