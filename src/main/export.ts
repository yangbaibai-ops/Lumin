// ─── 主进程：导出服务（PDF / HTML / Word / EPUB）────────────────────────────
import { app, BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
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

// ─── 通用：保存对话框 + 写入 ───────────────────────────────────────────────
async function saveWithDialog(defaultName: string, ext: string, data: Buffer): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (result.canceled || !result.filePath) return null
  await fs.writeFile(result.filePath, data)
  return result.filePath
}

function buildHtml(payload: ExportPayload): string {
  return `<!doctype html>
<html lang="zh-CN">
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

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
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: `${payload.title || 'document'}.pdf`,
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
    await printWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(payload))
    )
    // 等待字体与图片/样式全部可用（KaTeX、系统 CJK 等）
    await printWin.webContents.executeJavaScript(
      `document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : Promise.resolve(true)`
    )
    // 再让一次渲染帧稳定（布局/分页计算完成）
    await new Promise((resolve) => setTimeout(resolve, 250))

    const marginInch = pdfSettings.margin / 25.4
    const data = await printWin.webContents.printToPDF({
      pageSize: pdfSettings.pageSize,
      printBackground: true,
      landscape: false,
      margins: { top: marginInch, bottom: marginInch, left: marginInch, right: marginInch }
    })
    if (!data || data.length === 0) {
      throw new Error('printToPDF 返回空内容')
    }
    await fs.writeFile(resultFilePath, data)
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
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
    defaultPath: `${meta.title || 'document'}.epub`,
    filters: [{ name: 'EPUB', extensions: ['epub'] }]
  })
  if (result.canceled || !result.filePath) return null

  const chapterId = 'ch1'
  const contentXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${meta.lang || 'zh-CN'}">
<head><meta charset="utf-8"/><title>${escapeHtml(meta.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><article class="md-preview">${meta.html}</article></body>
</html>`

  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${meta.lang || 'zh-CN'}">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">${escapeHtml(meta.title)}</a></li></ol></nav></body>
</html>`

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">lumin-${Date.now()}</dc:identifier>
    <dc:title>${escapeHtml(meta.title)}</dc:title>
    <dc:language>${meta.lang || 'zh-CN'}</dc:language>
    <dc:creator>${escapeHtml(meta.author || 'Lumin')}</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="${chapterId}" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="${chapterId}"/></spine>
</package>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const zip = zipStore([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf-8') },
    { name: 'META-INF/container.xml', data: Buffer.from(container, 'utf-8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf-8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf-8') },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(contentXhtml, 'utf-8') },
    { name: 'OEBPS/styles.css', data: Buffer.from(meta.css, 'utf-8') }
  ])
  await fs.writeFile(result.filePath, zip)
  return result.filePath
}

export function appVersion(): string {
  return app.getVersion()
}
