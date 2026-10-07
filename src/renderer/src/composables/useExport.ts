import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useNotificationsStore } from '../stores/notifications'
import { getExportCss, renderMermaidInHtml } from '../lib/export'
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
    const html = await renderMermaidInHtml(raw, settings.resolveTheme())
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
   * 真打印机打印（审计 §7 第 18 条）。
   *
   * 与 PDF 导出的唯一区别是落点：这边走系统打印对话框（主进程 `silent: false`），
   * 所以**没有输出路径**、也不需要保存对话框。三种结果都必须让用户看得见：
   *   * `ok`        → 轻提示「已发送到打印机」；
   *   * `cancelled` → 轻提示「已取消打印」（用户取消是正常路径，**不是错误**）；
   *   * `failed`    → 错误通知，正文是 Chromium 原样回报的 `failureReason`。
   * 没有打印机 / 对话框弹不出来时同理：主进程会把结论回传，绝不静默吞掉。
   */
  async function runPrint(): Promise<void> {
    try {
      const doc = await buildDoc()
      if (!doc) return
      // 打印的载荷与 PDF 导出逐字相同（同一份页面尺寸/边距设置），见 printRequest 的说明
      const req = printRequest(doc, optionsSlice())
      const result = await window.luminAPI.print.document(
        req.args as Parameters<typeof window.luminAPI.print.document>[0],
        req.options as Parameters<typeof window.luminAPI.print.document>[1]
      )
      if (result.status === 'ok') {
        ui.toast(i18n.global.t('toast.printDone'), 'success')
        return
      }
      if (result.status === 'cancelled') {
        ui.toast(i18n.global.t('toast.printCancelled'), 'info')
        return
      }
      // 失败：原因原样透传；系统没给原因时也要有一句可读的话，而不是一条空通知
      void notifications.notify({
        level: 'error',
        title: i18n.global.t('toast.printFailed'),
        body: result.failureReason || i18n.global.t('toast.printNoReason')
      })
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
