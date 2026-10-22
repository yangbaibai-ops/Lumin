import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useNotificationsStore } from '../stores/notifications'
import {
  getExportCss,
  renderMathInHtml,
  renderMermaidInHtml,
  resolveExportImageSrcs
} from '../lib/export'
import { exportRequest, printRequest } from '../lib/exportPayload'
import type { ExportFormat } from '../lib/exportPayload'
import { beginExportRender, endExportRender } from '../lib/remoteImages'
import { stripTextExtension } from '../../../shared/textFiles'
import i18n from '../i18n'

// ─── 导出（渲染层）：基于 Tiptap getHTML() 输出 ────────────────────────────
export function useExport(): {
  runExport: (format: ExportFormat) => Promise<void>
  runPrint: () => Promise<void>
} {
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const editorStore = useEditorStore()
  const notifications = useNotificationsStore()

  async function buildExportHtml(): Promise<{ html: string; title: string } | null> {
    if (!files.current) return null
    const editor = editorStore.instance
    // 远程图片的隐私闸门在浏览时把 `<img src>` 换成了占位；导出要的是**真实 HTML**，
    // 所以在这段同步窗口里放行（见 lib/remoteImages.ts 的 beginExportRender）。
    let raw: string
    beginExportRender()
    try {
      raw = editor ? editor.getHTML() : `<p>${files.current.content.replace(/\n/g, '<br>')}</p>`
    } finally {
      endExportRender()
    }
    const withImages = resolveExportImageSrcs(raw)
    const withMath = await renderMathInHtml(withImages)
    const html = await renderMermaidInHtml(withMath, settings.resolveTheme())
    // 标题去掉可打开的文本后缀（清单见 shared/textFiles.ts），不在这里手写正则
    return { html, title: stripTextExtension(files.current.name) }
  }

  /**
   * 「当前文档 + 导出用 CSS」这一份纯数据载荷。
   *
   * 导出的四种格式与**打印**都从这里取 —— 打印因此拿到与 PDF 导出**完全相同**的
   * HTML + CSS（含 `@media print` 分页规则），不存在第二份排版 CSS。
   * CSS（含 KaTeX 那份）在这里按需拉取：只在真的要导出/打印时才加载（见 lib/export.ts）。
   */
  async function buildDoc(): Promise<{ title: string; html: string; css: string } | null> {
    const payload = await buildExportHtml()
    if (!payload) return null
    const css = await getExportCss()
    return { title: payload.title, html: payload.html, css }
  }

  /** 导出/打印请求共用的设置切片（逐个字段摊平，见 lib/exportPayload.ts 的说明） */
  function optionsSlice(): Parameters<typeof exportRequest>[2] {
    return {
      pdfMargin: settings.export.pdf.margin,
      pdfPageSize: settings.export.pdf.pageSize,
      language: settings.language,
      author: 'Lumin'
    }
  }

  async function runExport(format: ExportFormat): Promise<void> {
    try {
      const doc = await buildDoc()
      if (!doc) return
      // 请求载荷的构造收口在 lib/exportPayload.ts（纯函数、有单测）：它把 Pinia 代理
      // **逐个字段摊平成普通对象** —— 代理过不了 IPC 的结构化克隆（"could not be cloned"），
      // 这是当年「导出 PDF 必失败」的根因。
      const req = exportRequest(format, doc, optionsSlice())
      /**
       * 发送表：`Record<ExportFormat, …>` —— **少一个格式 TypeScript 当场报错**，
       * 不再靠 if/else 链的最后一个 else 兜底（原先 epub 是 else 分支，
       * 将来加一种格式忘了改这里，它会静默走成 epub）。
       */
      const senders: Record<
        ExportFormat,
        (req: ReturnType<typeof exportRequest>) => Promise<string | null>
      > = {
        pdf: (r) =>
          window.luminAPI.export.pdf(
            r.args as Parameters<typeof window.luminAPI.export.pdf>[0],
            r.options as Parameters<typeof window.luminAPI.export.pdf>[1]
          ),
        html: (r) =>
          window.luminAPI.export.html(r.args as Parameters<typeof window.luminAPI.export.html>[0]),
        word: (r) =>
          window.luminAPI.export.word(r.args as Parameters<typeof window.luminAPI.export.word>[0]),
        epub: (r) =>
          window.luminAPI.export.epub(r.args as Parameters<typeof window.luminAPI.export.epub>[0])
      }
      const path = await senders[format](req)
      if (path) ui.toast(i18n.global.t('toast.exportedTo', { path }), 'success')
    } catch (e) {
      // 失败原因作为「详情」展示：标题保持一行可扫读，细节不丢（同类失败自动合并为一条）
      void notifications.notify({
        level: 'error',
        title: i18n.global.t('toast.exportFailed'),
        body: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * 打印（第十一轮改成**先预览**）。
   *
   * 用户报障原话：「点击 Ctrl+P 打印的时候，出现的 Windows 打印窗口提示：**此应用不支持
   * 打印预览**」—— `webContents.print()` 只弹系统对话框；Chromium 那套带缩略图的打印预览
   * UI 是 Chrome 浏览器的功能，Electron 里没有。所以这里改成：先用**与 PDF 导出同一段流水**
   * 生成 PDF（主进程 `print:preview`），在应用内的预览窗口里显示；用户在预览里点「打印」，
   * 才走系统打印对话框（那一步由预览窗口自己的 preload 驱动，见 main/printPreview.ts）。
   *
   * 载荷与 PDF 导出逐字相同（`printRequest` 与 `exportRequest` 共用 `buildDoc()`）。
   * 只有"开预览失败"才会在这里报错 —— 打印结果（成功/取消/失败）由预览窗口显示，
   * 不再从这里弹通知（那时用户看的是预览窗口，不是主窗口）。
   */
  async function runPrint(): Promise<void> {
    try {
      const doc = await buildDoc()
      if (!doc) return
      const req = printRequest(doc, optionsSlice())
      const res = await window.luminAPI.print.preview(
        req.args as Parameters<typeof window.luminAPI.print.preview>[0],
        req.options as Parameters<typeof window.luminAPI.print.preview>[1]
      )
      if (!res.ok) {
        void notifications.notify({
          level: 'error',
          title: i18n.global.t('toast.printFailed'),
          body: res.error || i18n.global.t('toast.printNoReason')
        })
      }
    } catch (e) {
      void notifications.notify({
        level: 'error',
        title: i18n.global.t('toast.printFailed'),
        body: e instanceof Error ? e.message : String(e)
      })
    }
  }

  return { runExport, runPrint }
}
