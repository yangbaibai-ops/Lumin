// ─── 主进程：打印预览（作业管理 + 预览窗口 + 临时文件生命周期）─────────────────
//
// 背景（用户报障第十一轮）：`Ctrl+P` 走 `webContents.print()` 只弹**系统**打印对话框 ——
// Chromium 那套打印预览 UI 是 Chrome 浏览器的功能，Electron 里不存在，所以 Windows 会明说
// 「此应用不支持打印预览」。做法：**自己做预览**。
//
// 一段流水（每一步都复用既有实现，没有第二份排版口径）：
//   ① 渲染层给来「当前文档 + 导出用 CSS」（`ExportPayload`，与 PDF 导出**同一份**载荷）；
//   ② 这里调 `export.buildPdfBytes`（从 `exportPdf` 里抽出来的那一段：同一个隐藏窗口
//      `withRenderedDocument` + 同一套 `printToPDF` 参数与页眉页脚模板）拿到 PDF 字节；
//   ③ 写进**临时目录** `<temp>/lumin-print-preview-<id>/{preview.pdf,index.html}`；
//   ④ 开一个窗口加载 `index.html`：Chromium **内置的 PDF 查看器**渲染那份 PDF（不引 CDN、
//      不发任何网络请求），上面一条我们自己的工具栏（打印 / 关闭）；
//   ⑤ 「打印」→ 走**既有**的 `export.printDocument`（同一个隐藏窗口 + `webContents.print()`，
//      弹系统打印对话框）—— 打印的 HTML/CSS/页面设置与预览的 PDF 逐字同源；
//      「关闭」/关窗 → 销毁窗口并**删掉临时目录**（app 退出时也兜一次）。
//
// 为什么打印"原 HTML"而不是"打印那个 PDF"：Electron 里对 PDF 查看器的 webContents 调
// `print()` 打印的是插件宿主页，不保证会把 PDF 内容交给打印子系统（社区长期反馈会打出空白页）；
// 而原 HTML 这条路是本仓库已经在用、且有真实打印验收口径的那条。
// ⚠️ 代价要说清：**预览里的 PDF 带着我们的页眉页脚模板，系统打印对话框打出来的页眉页脚
// 由 Chromium 的打印设置决定**（`webContents.print()` 不支持 `headerTemplate/footerTemplate`）。
// 版式、分页、页面尺寸、边距仍与预览一致。
import { BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { mainT } from './i18n'
import { buildPdfBytes, printDocument } from './export'
import {
  PRINT_PREVIEW_PAGE,
  PRINT_PREVIEW_PDF,
  buildPrintPreviewHtml,
  countPdfPages,
  printPreviewDirName
} from '../shared/printPreview'
import type { PrintPreviewLabels } from '../shared/printPreview'
import type { PrintResult } from '../shared/printOptions'
import type { ExportPayload } from '../shared/types'

/** 一个预览作业：窗口 + 临时目录 + 打印时要用的载荷 */
interface PreviewJob {
  id: string
  dir: string
  pdfPath: string
  pages: number
  bytes: number
  win: BrowserWindow
  payload: ExportPayload
  settings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
}

const jobs = new Map<string, PreviewJob>()

function labels(): PrintPreviewLabels {
  return {
    title: mainT('printPreview.title'),
    print: mainT('printPreview.print'),
    close: mainT('printPreview.close'),
    printing: mainT('printPreview.printing'),
    sent: mainT('printPreview.sent'),
    cancelled: mainT('printPreview.cancelled'),
    failed: mainT('printPreview.failed'),
    unavailable: mainT('printPreview.unavailable')
  }
}

/** 作业 id：只含小写字母与数字（要进目录名，绝不带路径分隔符） */
function newJobId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 删除一个作业的临时目录（幂等）。
 * 任何一条出路都要走到这里：用户点「关闭」、直接关窗口、应用退出。
 */
async function removeJobDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉不影响功能（临时目录会被系统清理），但绝不让它把流程搞崩 */
  }
}

/**
 * 生成预览：PDF + 预览页写进临时目录，开窗显示。
 *
 * 返回给渲染层的是**可判定的信息**（`pages` / `bytes` / `pdfPath`）：页数用于界面提示，
 * 路径用于验收脚本核对"预览的确实是我们生成的这份 PDF"。
 */
export async function openPrintPreview(
  payload: ExportPayload,
  settings: { margin: number; pageSize: 'A4' | 'A5' | 'Letter' }
): Promise<
  | { ok: true; id: string; pages: number; bytes: number; pdfPath: string }
  | { ok: false; error: string }
> {
  const id = newJobId()
  const dir = path.join(app.getPath('temp'), printPreviewDirName(id))
  const pdfPath = path.join(dir, PRINT_PREVIEW_PDF)
  let data: Buffer
  let pages = 0
  try {
    // 与「导出 PDF」**同一段**代码：同一隐藏窗口、同一套 printToPDF 参数与页眉页脚模板
    data = await buildPdfBytes(payload, settings)
    pages = countPdfPages(data)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(pdfPath, data)
    await fs.writeFile(
      path.join(dir, PRINT_PREVIEW_PAGE),
      buildPrintPreviewHtml({
        labels: labels(),
        pages,
        pagesText: mainT('printPreview.pages', { n: pages }),
        jobId: id
      }),
      'utf-8'
    )
  } catch (e) {
    await removeJobDir(dir)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const parent = BrowserWindow.getFocusedWindow()
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    minWidth: 520,
    minHeight: 420,
    show: true,
    title: mainT('printPreview.title'),
    autoHideMenuBar: true,
    parent: parent ?? undefined,
    backgroundColor: '#525659',
    webPreferences: {
      // 专用 preload：只暴露「打印 / 关闭」两个动作（见 src/preload/printPreview.ts）
      preload: path.join(__dirname, '../preload/printPreview.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  jobs.set(id, { id, dir, pdfPath, pages, bytes: data.length, win, payload, settings })

  win.on('closed', () => {
    const job = jobs.get(id)
    jobs.delete(id)
    if (job) void removeJobDir(job.dir)
  })
  await win.loadFile(path.join(dir, PRINT_PREVIEW_PAGE))
  return { ok: true, id, pages, bytes: data.length, pdfPath }
}

/**
 * 预览里的「打印」：走既有的系统打印通路（`export.printDocument`）。
 *
 * 返回值恒为一个 `PrintResult`（不抛）：成功 / 取消 / 失败都要让预览页显示出来。
 * `LUMIN_PRINT_DRY_RUN=1`（仅开发态）时 `printDocument` 只记账、不弹系统对话框 ——
 * 验收脚本因此能断言"点打印真的走到了打印通路"而不会把自动化卡在原生对话框上。
 */
export async function printPreviewJob(jobId: string): Promise<PrintResult> {
  const job = jobs.get(jobId)
  if (!job) return { status: 'failed', failureReason: 'preview job not found' }
  return printDocument(job.payload, job.settings)
}

/** 预览里的「关闭」：销毁窗口（`closed` 里统一清目录） */
export function closePrintPreview(jobId: string): { ok: boolean } {
  const job = jobs.get(jobId)
  if (!job) return { ok: false }
  if (!job.win.isDestroyed()) job.win.destroy()
  return { ok: true }
}

/**
 * 应用退出/异常时的兜底清理：把所有作业目录删掉（`rm -rf` 是异步的，这里只发起不等待 ——
 * 退出流程不因为清理慢而卡住；能删多少删多少，剩下的交给系统临时目录策略）。
 */
export function cleanupPrintPreviews(): void {
  for (const job of jobs.values()) {
    if (!job.win.isDestroyed()) job.win.destroy()
    void removeJobDir(job.dir)
  }
  jobs.clear()
}
