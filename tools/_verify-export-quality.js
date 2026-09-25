'use strict'
// 验收：导出质量（审计 §7 第 18 条 —— 仓库自己的覆盖矩阵把这块列为"最大功能空洞"）
//
// 原缺陷三条：
//   ① EPUB 只打一个 `chapter1.xhtml`，ZIP 里**没有图片**（本地图是 lumin-file://，阅读器不认）；
//   ② PDF 只有 pageSize/margins，`headerTemplate|footerTemplate` 全仓 0 命中（没有页码/页眉）；
//   ③ 导出用裸 `fs.writeFile`（非原子）。
//
// 怎么在自动化里验：主进程有一条**仅开发态**的旁路 `LUMIN_EXPORT_DIR`
// （原生「另存为」对话框自动化取消不了，没有它这块就只能人眼看）。
// 本套件自己起实例时带上这个环境变量，导出直接落到临时目录，然后：
//   * EPUB：`zipStore` 是 STORE（不压缩），条目名与图片字节在文件里**字面可查** ——
//     直接断言 `OEBPS/chapter-N.xhtml`、`OEBPS/images/img-N.png` 与图片原始字节都在；
//   * PDF：断言是合法 PDF（`%PDF-` 开头、`%%EOF` 结尾）且页眉页脚模板由单测钉住
//     （见 tests/pdfTemplates.test.mjs：`.pageNumber`/`.totalPages` 必须在模板里）。
const { spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { Reporter, sleep, fatal } = require('./lib/harness')

const PORT = 9233
const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')

/** 1×1 PNG（合法、可被 Chromium 打开） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const get = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

async function main() {
  const report = new Reporter('导出质量：EPUB 拆章带图 / PDF 页码页眉 / 原子写')
  const ws = path.join(os.tmpdir(), 'lumin-export-ws')
  const out = path.join(os.tmpdir(), 'lumin-export-out')
  const ud = path.join(os.tmpdir(), 'lumin-export-ud')
  for (const d of [ws, out, ud]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(ud, { recursive: true })
  const pngPath = path.join(ws, 'assets', 'pic.png')
  fs.writeFileSync(pngPath, PNG)

  const proc = spawn('cmd.exe', ['/c', ELECTRON, '.', `--user-data-dir=${ud}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      // 调试端口靠**环境变量**开（见 main/index.ts:54）——只传命令行开关是不生效的，
      // 第一版就是这么"实例没起来"的
      LUMIN_DEBUG_PORT: String(PORT),
      LUMIN_EXPORT_DIR: out,
      LUMIN_TRUSTED_PATHS: os.tmpdir()
    },
    stdio: 'ignore',
    detached: false
  })

  let page = null
  for (let i = 0; i < 60 && !page; i += 1) {
    await sleep(500)
    try {
      page = (await get('/json/list')).find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (!page) {
    console.log('SKIP: 实例没起来')
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    return 0
  }

  const w = connect(page.webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  for (let i = 0; i < 40; i += 1) {
    await sleep(300)
    if ((await w.ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }

  try {
    // ⚠️ 先开工作区：导出内嵌本地图时主进程要过 `isServableMedia` 的闸
    // （工作区 / 已打开文档目录之内），没开工作区时图**有意**不内嵌、保持 lumin-file://。
    // 这条闸是被测行为的一部分，套件必须先把前置状态摆对（第一版就是漏了这一步）。
    await w.ev(
      `(async () => { await window.luminAPI.workspace.setRoot(${JSON.stringify(ws)}); return 'ok' })()`
    )
    await sleep(800)

    // ── EPUB：两章 + 一张本地图 ────────────────────────────────────────────
    const html = [
      '<h1>第一章</h1><p>正文一</p>',
      `<p><img src="lumin-file:///${pngPath.replace(/\\/g, '/')}" alt="pic"></p>`,
      '<h1>第二章</h1><p>正文二</p>'
    ].join('')
    const epubPath = String(
      await w.ev(`(async () => {
        const p = await window.luminAPI.export.epub({
          title: '导出验收书',
          author: 'Lumin 验收',
          lang: 'zh-CN',
          html: ${JSON.stringify(html)},
          css: 'body{font-family:sans-serif}'
        })
        return p || 'null'
      })()`)
    )
    report.check('epub-written', epubPath.endsWith('.epub') && fs.existsSync(epubPath), epubPath)
    const epub = fs.readFileSync(epubPath)
    report.check(
      'epub-has-two-chapters',
      epub.includes(Buffer.from('OEBPS/chapter-1.xhtml')) &&
        epub.includes(Buffer.from('OEBPS/chapter-2.xhtml')) &&
        epub.includes(Buffer.from('第一章')),
      `bytes=${epub.length}`
    )
    report.check(
      'epub-embeds-local-image',
      epub.includes(Buffer.from('OEBPS/images/img-1.png')) &&
        // 图片**字节**必须真的进了 ZIP（zipStore 是 STORE，不压缩 → 可字面查）
        epub.includes(PNG.subarray(0, 32)) &&
        !epub.includes(Buffer.from('lumin-file:///')),
      `png=${PNG.length}B epub=${epub.length}B`
    )
    report.check(
      'epub-nav-lists-chapters',
      epub.includes(Buffer.from('epub:type="toc"')) &&
        epub.includes(Buffer.from('chapter-2.xhtml')) &&
        epub.includes(Buffer.from('第二章')),
      'nav 里应有第二章的链接'
    )

    // ── HTML / Word / PDF ─────────────────────────────────────────────────
    const payload = { title: '导出验收', html: '<h1>标题</h1><p>正文</p>', css: 'body{margin:0}' }
    const htmlPath = String(
      await w.ev(
        `(async () => (await window.luminAPI.export.html(${JSON.stringify(payload)})) || 'null')()`
      )
    )
    const wordPath = String(
      await w.ev(
        `(async () => (await window.luminAPI.export.word(${JSON.stringify(payload)})) || 'null')()`
      )
    )
    report.check(
      'html-and-word-written',
      fs.existsSync(htmlPath) && fs.existsSync(wordPath) && wordPath.endsWith('.doc'),
      JSON.stringify({ htmlPath, wordPath })
    )
    const pdfPath = String(
      await w.ev(`(async () => {
        const p = await window.luminAPI.export.pdf(
          { title: '导出验收', html: '<h1>标题</h1><p>正文段落</p>', css: 'body{margin:0}' },
          { margin: 20, pageSize: 'A4' }
        )
        return p || 'null'
      })()`)
    )
    const pdf = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : Buffer.alloc(0)
    report.check(
      'pdf-is-valid',
      pdf.length > 1000 &&
        pdf.subarray(0, 5).toString('latin1') === '%PDF-' &&
        pdf.includes(Buffer.from('%%EOF')),
      `bytes=${pdf.length} head=${pdf.subarray(0, 8).toString('latin1')}`
    )
    // 非原子写的痕迹：目录里不该留下临时文件
    const leftovers = fs.readdirSync(out).filter((f) => f.endsWith('.lumin-tmp'))
    report.check('exports-leave-no-temp-files', leftovers.length === 0, JSON.stringify(leftovers))
  } finally {
    try {
      w.ws.close()
    } catch {
      /* ignore */
    }
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
