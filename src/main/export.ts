// ─── 主进程：导出服务（PDF / HTML / Word / EPUB）────────────────────────────
import { app, BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { mainLanguage, mainT } from './i18n'
import * as fileOps from './fileOps'
// HTML 转义唯一实现在 shared/html.ts：导出模板里的标题会进 <title>/<dc:title> 与属性位置，
// 少转引号等于让标题里的 `"` 直接闭合标签（审计 §10「重复实现」）
import { escapeHtml } from '../shared/html'
// PDF 页眉/页脚模板（纯函数）：Chromium 只替换 `.pageNumber` / `.totalPages` 这几个类
import { pdfFooterTemplate, pdfHeaderTemplate } from '../shared/pdfTemplates'
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

// ─── 最小 ZIP 写入器（STORE 存储，无压缩 —— 足以生成合法 EPUB）─────────────
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

function zipStore(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const now = new Date()
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version
    local.writeUInt16LE(0x0800, 6) // utf-8 flag
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, entry.data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(dosTime, 12)
    cen.writeUInt16LE(dosDate, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(entry.data.length, 20)
    cen.writeUInt32LE(entry.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + entry.data.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

/**
 * 验收旁路：`LUMIN_EXPORT_DIR` 存在（且**不是打包版**）时跳过「另存为」对话框，
 * 直接写进该目录的默认文件名。存在的理由：原生对话框自动化取消不了，
 * 没有这条路，导出这条功能就只能靠人眼看（审计 §7 第 18 条要求"导出质量"可验）。
 * 与 `LUMIN_TRUSTED_PATHS` 同一口径：**仅开发态生效**，打包版忽略。
 */
function exportTestDir(): string | null {
  const dir = process.env['LUMIN_EXPORT_DIR']
  return dir && !app.isPackaged ? dir : null
}

// ─── 通用：保存对话框 + 写入 ───────────────────────────────────────────────
async function saveWithDialog(
  defaultName: string,
  ext: string,
  data: Buffer
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const testDir = exportTestDir()
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

export async function exportPdf(
  payload: ExportPayload,
  pdfSettings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const testDir = exportTestDir()
  const defaultName = `${payload.title || 'document'}.pdf`
  const result = testDir
    ? { canceled: false, filePath: path.join(testDir, defaultName) }
    : await dialog.showSaveDialog(win!, {
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
  if (result.canceled || !result.filePath) return null
  const resultFilePath = result.filePath

  // 用隐藏窗口 + 真实 Chromium 排版引擎渲染后再 printToPDF；
  // 等页面渲染与网页字体完全就绪再打印，避免空白/缺字/未分页
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
  } finally {
    printWin.destroy()
  }
}

export async function exportEpub(meta: EpubMeta): Promise<string | null> {
  const testDir = exportTestDir()
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
