// ─── 主进程：导出服务（PDF / HTML / Word / EPUB）────────────────────────────
import { app, BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { mainLanguage, mainT } from './i18n'
import * as fileOps from './fileOps'
// ZIP 写入器抽到 main/zip.ts（导出与工作区备份共用；STORE / DEFLATE 两种）
import { zipStore } from './zip'
// 验收旁路（仅开发态）也抽出去了：导出与备份都要用它跳过原生对话框
import { printDryRun, testOutputDir } from './testPaths'
// 预览要显示"共 N 页"、验收要对齐页数：页数解析是纯函数（见 shared/printPreview.ts）
import { countPdfPages } from '../shared/printPreview'
// HTML 转义唯一实现在 shared/html.ts：导出模板里的标题会进 <title>/<dc:title> 与属性位置，
// 少转引号等于让标题里的 `"` 直接闭合标签（审计 §10「重复实现」）
import { escapeHtml } from '../shared/html'
// PDF 页眉/页脚模板（纯函数）：Chromium 只替换 `.pageNumber` / `.totalPages` 这几个类
import { pdfFooterTemplate, pdfHeaderTemplate } from '../shared/pdfTemplates'
// 打印选项映射 + 回调结果归类（纯函数、零依赖，单测在 tests/printOptions.test.mjs）
import { buildPrintOptions, classifyPrintResult } from '../shared/printOptions'
import type { PrintResult } from '../shared/printOptions'
// EPUB 组装（拆章 / 图片内嵌 / nav / opf）是纯函数，在 shared 里且有单测
import {
  buildChapterXhtml,
  buildNavXhtml,
  buildOpf,
  embedImagePath,
  rewriteImageSrcs,
  splitChapters
} from '../shared/epub'
import type { ExportPayload, EpubMeta } from '../shared/types'

// ─── 通用：保存对话框 + 写入 ───────────────────────────────────────────────
async function saveWithDialog(
  defaultName: string,
  ext: string,
  data: Buffer
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const testDir = testOutputDir()
  const result = testDir
    ? { canceled: false, filePath: path.join(testDir, defaultName) }
    : await dialog.showSaveDialog(win!, {
        defaultPath: defaultName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
  if (result.canceled || !result.filePath) return null
  // **原子写**（临时文件 + fsync + rename，与文档保存同一套）：
  // 审计点名导出用的是裸 `fs.writeFile` —— 写一半崩掉会留下一个"看起来是文档、
  // 打开却是半截"的文件，而用户不会知道该删它。
  await fileOps.writeBinary(result.filePath, data)
  return result.filePath
}

function buildHtml(payload: ExportPayload): string {
  // `lang` 也跟着界面语言走：写死 zh-CN 时，英文/俄文用户的导出件会被浏览器
  // 按中文断行与字体回退处理（整篇排版都会偏）
  return `<!doctype html>
<html lang="${mainLanguage()}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(payload.title)}</title>
<style>${payload.css}</style>
</head>
<body class="export-body">
<article class="md-preview">${payload.html}</article>
</body>
</html>`
}

/**
 * HTML 转义：**唯一实现**在 `shared/html.ts`（渲染层若要用也是那一份）。
 * 此前这里只转 `&<>` —— 而标题会出现在 `<title>`、`<dc:title>` 与属性位置上，
 * 少转引号就等于让标题里的 `"` 直接闭合标签（审计 §10「重复实现」）。
 */

export async function exportHtml(payload: ExportPayload): Promise<string | null> {
  const html = buildHtml(payload)
  return saveWithDialog(`${payload.title || 'document'}.html`, 'html', Buffer.from(html, 'utf-8'))
}

export async function exportWord(payload: ExportPayload): Promise<string | null> {
  // Word 可直接打开 HTML 格式的 .doc 文件
  const html = buildHtml(payload)
  return saveWithDialog(`${payload.title || 'document'}.doc`, 'doc', Buffer.from(html, 'utf-8'))
}

/**
 * 用隐藏窗口 + 真实 Chromium 排版引擎渲染**导出用的那一份 HTML**，等网页字体与布局
 * 就绪后交给 `use`，无论成功失败都销毁窗口。
 *
 * **PDF 导出与真打印机打印共用这一份**（审计 §7 第 18 条补「打印」时最关键的约束）：
 * 打印拿到的因此是与 PDF **完全相同**的 HTML + CSS —— 含渲染层那份带 `@media print`
 * 分页规则的样式表、KaTeX 样式、已渲染成 SVG 的 Mermaid，不存在"第二份排版 CSS"。
 *
 * `teardownGraceMs`：打印用得上（见 PRINT_TEARDOWN_GRACE_MS），PDF 导出为 0。
 */
async function withRenderedDocument<T>(
  payload: ExportPayload,
  use: (win: BrowserWindow) => Promise<T>,
  teardownGraceMs = 0
): Promise<T> {
  const printWin = new BrowserWindow({
    show: false,
    width: 960,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(payload)))
    // 等待字体与图片/样式全部可用（KaTeX、系统 CJK 等）
    await printWin.webContents.executeJavaScript(
      `document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : Promise.resolve(true)`
    )
    // 再让一次渲染帧稳定（布局/分页计算完成）
    await new Promise((resolve) => setTimeout(resolve, 250))
    return await use(printWin)
  } finally {
    // 隐藏窗口一律销毁，不留泄漏。宽限期只给打印：那个 webContents 本身就是打印源，
    // 回调刚返回就 destroy 有可能把还没交给 spooler 的任务一起带走。
    if (teardownGraceMs > 0 && !printWin.isDestroyed()) {
      setTimeout(() => {
        if (!printWin.isDestroyed()) printWin.destroy()
      }, teardownGraceMs)
    } else if (!printWin.isDestroyed()) {
      printWin.destroy()
    }
  }
}

/**
 * 用**与 PDF 导出完全相同**的那一段流水生成 PDF 字节：同一个隐藏窗口
 * （`withRenderedDocument`）+ 同一份 `buildHtml` + 同一套 `printToPDF` 参数
 * （页面尺寸 / 边距 / 页眉页脚模板）。
 *
 * 抽出来是因为现在有**两个**消费者：导出 PDF 落盘（`exportPdf`）与打印预览
 * （`printPreview.openPrintPreview`，见 main/printPreview.ts）。分页口径只有这一份 ——
 * 预览显示的页数与导出的 PDF 因此必然一致（验收套件就是这么判的）。
 */
export async function buildPdfBytes(
  payload: ExportPayload,
  pdfSettings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
): Promise<Buffer> {
  return withRenderedDocument(payload, async (printWin) => {
    const marginInch = pdfSettings.margin / 25.4
    // ── 页眉页脚（审计 §7 第 18 条）：此前 `headerTemplate|footerTemplate` 全仓 0 命中 ──
    // Chromium 的模板是**独立 HTML 片段**（不继承页面样式）：必须自带 font-size/颜色，
    // 且只有 `.pageNumber` / `.totalPages` / `.title` / `.date` 这几个类会被替换。
    // 上下边距要给页眉页脚留位置，否则它们会被正文压住（Chromium 把它们画在边距区里）。
    const headerFooterGap = 0.45 // inch
    const data = await printWin.webContents.printToPDF({
      pageSize: pdfSettings.pageSize,
      printBackground: true,
      landscape: false,
      displayHeaderFooter: true,
      headerTemplate: pdfHeaderTemplate(payload.title, marginInch),
      footerTemplate: pdfFooterTemplate(marginInch),
      margins: {
        top: Math.max(marginInch, headerFooterGap),
        bottom: Math.max(marginInch, headerFooterGap),
        left: marginInch,
        right: marginInch
      }
    })
    if (!data || data.length === 0) {
      throw new Error(mainT('export.pdfEmpty'))
    }
    return data
  })
}

export async function exportPdf(
  payload: ExportPayload,
  pdfSettings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const testDir = testOutputDir()
  const defaultName = `${payload.title || 'document'}.pdf`
  const result = testDir
    ? { canceled: false, filePath: path.join(testDir, defaultName) }
    : await dialog.showSaveDialog(win!, {
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
  if (result.canceled || !result.filePath) return null
  const resultFilePath = result.filePath

  try {
    const data = await buildPdfBytes(payload, pdfSettings)
    await fileOps.writeBinary(resultFilePath, data)
    return resultFilePath
  } catch (err) {
    // 导出失败不留半成品：删除可能已写入的损坏文件后向上抛，由渲染层提示
    try {
      await fs.unlink(resultFilePath).catch(() => {})
    } catch {
      /* ignore */
    }
    throw err
  }
}

// ─── 真打印机打印（审计 §7 第 18 条：此前 `webContents.print(` 全仓 0 命中）──────────
//
// 与 PDF 导出**同源**：同一段 `buildHtml(payload)`（即同一份排版 CSS + 分页规则），
// 同一个隐藏窗口渲染流程（`withRenderedDocument`）。区别只有落点：
//   * PDF 导出 → `printToPDF()` 拿到字节，原子写进用户选的文件；
//   * 打印     → `print()` 弹**系统打印对话框**（`silent: false`），由用户选打印机。
//
// ⚠️ **真机打印未经自动化验证**：本仓库的开发机 / CI 没有打印机，系统打印对话框也无法
// 在无头环境里驱动。可自动验证的只有 `buildPrintOptions`（尺寸/边距映射）与
// `classifyPrintResult`（结果归类）两条纯函数，见 `tests/printOptions.test.mjs`；
// 真机验收口径写在交付报告里（需要用户在有打印机的机器上点一次）。

/** 回调兜底时限：个别环境（没装任何打印机、平台在用户关掉对话框后不发通知）不会回调，
 *  没有这条兜底渲染层 `await` 的 IPC Promise 会永远挂着 —— 那正是"静默吞掉结果"。 */
const PRINT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** 回调返回后销毁隐藏窗口前的宽限（打印源就是这个 webContents，见 withRenderedDocument） */
const PRINT_TEARDOWN_GRACE_MS = 1500

/** 兜底原因：ASCII 诊断文案，与其他主进程错误同一口径（渲染层原样展示） */
const PRINT_TIMEOUT_REASON = 'no result from the system print dialog (timed out)'

/**
 * 真打印机打印：复用**与 PDF 导出一模一样**的 HTML + CSS，弹系统打印对话框。
 *
 * `printSettings` 就是设置里那份 PDF 页面设置（页面尺寸 + 边距毫米）——
 * 打印没有独立设置，用户看到的打印结果与导出 PDF 的版式一致。
 *
 * 返回值恒为一个 `PrintResult`（**不抛**）：成功 / 用户取消 / 失败三种都给渲染层一个
 * 可读结果，取消走 `cancelled` 而不是错误（用户点"取消"是正常操作）。
 */
export async function printDocument(
  payload: ExportPayload,
  printSettings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
): Promise<PrintResult> {
  const options = buildPrintOptions({
    pageSize: printSettings.pageSize,
    margins: printSettings.margin
  })
  /**
   * 验收旁路（仅开发态）：`LUMIN_PRINT_DRY_RUN=1` 时**只记账、不弹系统打印对话框**。
   *
   * 为什么必须要有：`silent: false` 会弹原生对话框，自动化既关不掉也点不了，验收就只剩下
   * "靠人眼看"。与 `testPaths.testOutputDir`（导出落点）/ `LUMIN_OPEN_EXTERNAL_DRY_RUN`
   * 是同一套口径：**打包产物忽略该变量**，发布版永远真的打印。
   */
  if (printDryRun()) {
    const pages = countPdfPages(
      await buildPdfBytes(payload, printSettings).catch(() => Buffer.alloc(0))
    )
    console.log(
      `[print] dry-run pages=${pages} pageSize=${options.pageSize} silent=${options.silent}`
    )
    return { status: 'ok', failureReason: '', dryRun: true }
  }
  return withRenderedDocument(
    payload,
    (printWin) =>
      new Promise<PrintResult>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const finish = (result: PrintResult): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(result)
        }
        timer = setTimeout(
          () => finish(classifyPrintResult(false, PRINT_TIMEOUT_REASON)),
          PRINT_CALLBACK_TIMEOUT_MS
        )
        try {
          printWin.webContents.print(options, (success, failureReason) => {
            finish(classifyPrintResult(success, failureReason))
          })
        } catch (err) {
          // 同步抛（选项非法 / webContents 已销毁）：同样要变成一条可读结果回到渲染层
          finish(classifyPrintResult(false, err instanceof Error ? err.message : String(err)))
        }
      }),
    PRINT_TEARDOWN_GRACE_MS
  )
}

export async function exportEpub(meta: EpubMeta): Promise<string | null> {
  const testDir = testOutputDir()
  const defaultName = `${meta.title || 'document'}.epub`
  const result = testDir
    ? { canceled: false, filePath: path.join(testDir, defaultName) }
    : await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
        defaultPath: defaultName,
        filters: [{ name: 'EPUB', extensions: ['epub'] }]
      })
  if (result.canceled || !result.filePath) return null

  const lang = meta.lang || mainLanguage()
  const tocTitle = mainT('export.tocTitle')
  // ── 拆章 + 内嵌本地图片（审计 §7 第 18 条）────────────────────────────────
  // 之前不管文档多大都只打一个 chapter1.xhtml，且 ZIP 里没有图片：
  // 正文里的本地图是 lumin-file://，阅读器不认 → 导出的书里图全裂。
  const chapters = splitChapters(meta.html, meta.title || tocTitle)
  // 图片：把每章用到的本地 src 落成 ZIP 条目（重名按内容去重）
  const mapping: Record<string, string> = {}
  const embedded: { name: string; data: Buffer }[] = []
  for (const chapter of chapters) {
    for (const src of chapter.images) {
      if (mapping[src]) continue
      const bytes = await readLocalImage(src)
      if (!bytes) continue // 读不到（权限/已删除）就保持原样，不阻塞整本书
      const name = `img-${embedded.length + 1}${imageExtOf(src)}`
      mapping[src] = embedImagePath(name)
      embedded.push({ name, data: bytes })
    }
  }
  const withImages = chapters.map((c) => ({ ...c, html: rewriteImageSrcs(c.html, mapping) }))

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const zip = zipStore([
    // mimetype 必须是**第一个**条目且不压缩（EPUB 规范）
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf-8') },
    { name: 'META-INF/container.xml', data: Buffer.from(container, 'utf-8') },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(
        buildOpf({
          title: meta.title,
          author: meta.author || 'Lumin',
          lang,
          chapters: withImages.length,
          images: embedded.map((e) => e.name),
          id: `lumin-${Date.now()}`,
          modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
        }),
        'utf-8'
      )
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: Buffer.from(buildNavXhtml(withImages, { title: meta.title, lang, tocTitle }), 'utf-8')
    },
    ...withImages.map((c, i) => ({
      name: `OEBPS/chapter-${i + 1}.xhtml`,
      data: Buffer.from(buildChapterXhtml(c, { title: meta.title, lang, css: meta.css }), 'utf-8')
    })),
    ...embedded.map((e) => ({ name: `OEBPS/${embedImagePath(e.name)}`, data: e.data })),
    { name: 'OEBPS/styles.css', data: Buffer.from(meta.css, 'utf-8') }
  ])
  // 原子写（临时文件 + fsync + rename）：导出件也不该出现"写了一半"的文件
  await fileOps.writeBinary(result.filePath, zip)
  return result.filePath
}

/** 图片扩展名（从 src 里取，取不到按 .png —— 只影响 EPUB 里的 media-type 与文件名） */
function imageExtOf(src: string): string {
  const m = /\.(png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/i.exec(src)
  return m ? `.${m[1].toLowerCase()}` : '.png'
}

/**
 * 读一张**本地**图片的字节（EPUB 内嵌用）。
 *   * `lumin-file:///…` 是渲染层给本地图的 URL：解码后就是绝对路径；
 *   * 只放行媒体扩展名 + `isServableMedia`（工作区或已打开文档目录之内）——
 *     导出是"把磁盘上的文件塞进 ZIP"，没有这道闸就等于给了渲染层一个任意读文件的通道。
 * 读不到返回 null（调用方保持原 src，不阻塞整本书）。
 */
async function readLocalImage(src: string): Promise<Buffer | null> {
  try {
    let p = src
    if (/^lumin-file:/i.test(src)) {
      const u = new URL(src)
      p = decodeURIComponent(u.pathname.replace(/^\//, ''))
    } else if (!path.isAbsolute(src)) {
      return null // 相对路径需要文档目录才能解析：渲染层给的已经是 lumin-file:// 绝对 URL
    }
    if (!fileOps.isServableMedia(p)) return null
    return await fs.readFile(p)
  } catch {
    return null
  }
}

export function appVersion(): string {
  return app.getVersion()
}
